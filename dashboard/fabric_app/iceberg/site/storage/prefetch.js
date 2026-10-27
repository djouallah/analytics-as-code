// =============================================================================
// prefetch.js — a table's Iceberg files fetched ahead of DuckDB, in parallel
// =============================================================================
// DuckDB-WASM reads a remote file one request at a time (synchronous XHR in its worker), and
// OneLake answers each in ~0.6 s whatever its size: opening a table (metadata.json, manifest
// list, manifests, a HEAD and a GET each) takes seconds before any data. The browser's HTTP
// cache serves the worker's requests too, HEAD and Range included, and OneLake's files are
// cacheable (Last-Modified, no Cache-Control). So the page fetches what DuckDB is about to
// read, many at once, and DuckDB finds it cached. Nothing is kept here: the cache is the
// browser's, and the URLs (the file and the SAS) are the ones azure_wasm builds.
//
//   prefetchTable(name, metadata, url, { data, known })
//                                           name: the table, for prioritize(name);
//                                           metadata: the table's metadata.json, parsed;
//                                           url(abfss) -> the https URL DuckDB will ask for;
//                                           data: the data files too (delete files included:
//                                           a table about to be read whole), after every
//                                           table's metadata layers;
//                                           known: manifest paths the worker holds already
//                                           (snapshots.js: the table's last record), not
//                                           fetched. A new snapshot's manifest list names
//                                           every manifest of the table, old ones included.
//   prefetchFiles(name, files, url, store, onFile)
//                                           each Parquet file whole, six at a time, handed to
//                                           the worker's store (store(path, bytes), resolved
//                                           once kept; blockcache.js); onFile(bytes) as each
//                                           one is done. files: [{ path, size }]. Returns the
//                                           sizes.
// =============================================================================

// OneLake answers HTTP/1.1 only, so a browser keeps six connections to it: more would queue.
const PARALLEL = 6;

// PARALLEL slots shared by every table, served table by table: the table a query is about to
// open first (prioritize, called by data.js before it opens one), then the others in the order
// they were started (smallest first). Within a table its manifests come before its data files,
// which need them. (First come, first served across tables, a small table's few files waited
// behind the large tables' hundreds of manifests; data files fetched only when their table
// opens were slower still: tables open one at a time.)
let active = 0;
let order = [];                       // table names, the first served first
const waiting = new Map();            // table name -> resolvers waiting for a slot
export function prioritize(...names) {
  order = [...names, ...order.filter(n => !names.includes(n))];
}
function next() {
  for (const n of order) { const w = waiting.get(n); if (w?.length) return w.shift(); }
  return null;
}
async function limited(fn, table) {
  if (active >= PARALLEL) await new Promise(r => { if (!waiting.has(table)) waiting.set(table, []); waiting.get(table).push(r); });
  active++;
  try { return await fn(); } finally { active--; next()?.(); }
}
const get = (url, table) => limited(async () => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}, table);

// A large table's new files, whole, six at a time, each handed to the worker's store
// (store(path, bytes), resolved once it is kept): DuckDB's ranged reads of them are then
// answered there, not seeked from OneLake. Not left in the browser's HTTP cache, which does not
// keep a response of 70-100 MB: the worker downloaded each file again, one at a time (2-5 s
// each). Returns each file's size.
export async function prefetchFiles(name, files, url, store, onFile = () => {}) {
  if (!order.includes(name)) order.push(name);
  return Promise.all(files.map(f => limited(async () => {
    const r = await fetch(url(f.path), { cache: 'no-store' });
    if (!r.ok) return { path: f.path, size: f.size ?? null };
    const bytes = await r.arrayBuffer();
    await store(f.path, bytes);
    return { path: f.path, size: bytes.byteLength || null };
  }, name).catch(() => ({ path: f.path, size: f.size ?? null })).then(f => { onFile(f.size ?? 0); return f; })));
}

// --- An Avro object container file, as far as its strings: the header's codec, then each
// block, inflated if the codec is deflate. Enough to find the paths in a manifest.
function zigzag(b, pos) {
  let n = 0, shift = 0, byte;
  do { byte = b[pos.i++]; n += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return n % 2 ? -(n + 1) / 2 : n / 2;
}
const text = bytes => new TextDecoder('latin1').decode(bytes);
async function inflateRaw(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}
async function avroText(b) {
  if (b[0] !== 0x4f || b[1] !== 0x62 || b[2] !== 0x6a || b[3] !== 1) return '';   // "Obj\x01"
  const pos = { i: 4 }, meta = {};
  for (let n; (n = zigzag(b, pos)) !== 0;) {
    if (n < 0) { n = -n; zigzag(b, pos); }   // a negative count is followed by the block's size
    for (let k = 0; k < n; k++) {
      const kl = zigzag(b, pos), key = text(b.subarray(pos.i, pos.i += kl));
      const vl = zigzag(b, pos); meta[key] = text(b.subarray(pos.i, pos.i += vl));
    }
  }
  pos.i += 16;   // the sync marker
  const codec = meta['avro.codec'] ?? 'null';
  if (codec !== 'null' && codec !== 'deflate') return '';
  let all = '';
  while (pos.i < b.length) {
    zigzag(b, pos);                 // objects in the block
    const size = zigzag(b, pos);
    const block = b.subarray(pos.i, pos.i += size);
    pos.i += 16;
    all += text(codec === 'deflate' ? await inflateRaw(block) : block);
  }
  return all;
}
const paths = (s, ext) => [...new Set(s.match(new RegExp(`abfss://[\\x21-\\x7e]+?\\.${ext}`, 'g')) ?? [])];

// The current snapshot's manifest list, its manifests, and with `data` the files they name.
export async function prefetchTable(name, metadata, url, { data = false, known = new Set() } = {}) {
  if (!order.includes(name)) order.push(name);
  const current = String(metadata['current-snapshot-id']);
  const snapshot = (metadata.snapshots ?? []).find(s => String(s['snapshot-id']) === current);
  if (!snapshot?.['manifest-list']) return 0;
  const list = await avroText(await get(url(snapshot['manifest-list']), name));
  // A known manifest is in the worker's store, and so are the data files it names that were
  // read (a small table was read whole): only the new manifests are fetched, and with `data`
  // the files they name.
  const manifests = await Promise.all(paths(list, 'avro').filter(m => !known.has(m))
    .map(async m => avroText(await get(url(m), name))));
  let n = 1 + manifests.length;
  if (data) {
    const files = [...new Set(manifests.flatMap(m => paths(m, 'parquet')))];
    // A manifest also names the files a later snapshot removed (its DELETED entries, which this
    // reader does not tell apart): those answer 404 and are skipped.
    await Promise.all(files.map(f => get(url(f), name).catch(() => null)));
    n += files.length;
  }
  return n;
}
