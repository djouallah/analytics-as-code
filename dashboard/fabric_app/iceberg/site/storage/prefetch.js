// =============================================================================
// prefetch.js — a table planned from Iceberg, and its files fetched ahead of DuckDB
// =============================================================================
// The page is the only thing that reads OneLake (DuckDB reads only the local store,
// blockcache.js), many requests at once (OneLake answers each in ~0.6 s whatever its size):
// it plans a table (metadata.json, the manifest list, the manifests, read here) and downloads
// the files DuckDB will read into the store.
//
//   planTable(name, metadata, url)
//                                           name: the table, for prioritize(name);
//                                           metadata: the table's metadata.json, parsed;
//                                           url(abfss) -> the https URL to fetch it with.
//                                           Returns { record, manifests, fetched }: the record
//                                           snapshots.js keeps (without location and bytes),
//                                           the snapshot's manifests and how many were not in
//                                           the manifest cache.
//   prefetchFiles(name, files, url, store, onFile)
//                                           each Parquet file whole, six at a time, handed to
//                                           the worker's store (store(path, bytes), resolved
//                                           once kept; blockcache.js); onFile(bytes) as each
//                                           one is done. files: [{ path, size }]. Returns the
//                                           sizes; a file that fails to download throws.
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

// The files of a table the store lacks, whole, six at a time, each handed to the worker's
// store (store(path, bytes), resolved once it is kept): DuckDB reads them there. Not through
// the browser's HTTP cache, which does not keep a response of 70-100 MB. Returns each file's
// size.
export async function prefetchFiles(name, files, url, store, onFile = () => {}) {
  if (!order.includes(name)) order.push(name);
  return Promise.all(files.map(f => limited(async () => {
    const r = await fetch(url(f.path), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${f.path.split('/').pop()}: HTTP ${r.status}`);
    const bytes = await r.arrayBuffer();
    await store(f.path, bytes);
    onFile(bytes.byteLength);
    return { path: f.path, size: bytes.byteLength };
  }, name)));
}

// --- Avro object container files, read by the schema in their header: the records of a
// manifest list and of a manifest. Codecs null and deflate (what Iceberg writers use by
// default); another one throws, and the table fails.
const utf8 = new TextDecoder();
function long(r) {
  let n = 0, shift = 0, byte;
  do { byte = r.b[r.i++]; n += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return n % 2 ? -(n + 1) / 2 : n / 2;   // exact below 2^53: sizes and counts; ids only skipped
}
const bytesOf = r => { const n = long(r); return r.b.subarray(r.i, r.i += n); };
// Every named type, by its name and its full name: a schema refers to one by either.
function names(s, out = new Map(), space = '') {
  if (Array.isArray(s)) { for (const x of s) names(x, out, space); return out; }
  if (!s || typeof s !== 'object') return out;
  const ns = s.namespace ?? space;
  if (s.name && ['record', 'enum', 'fixed'].includes(s.type)) { out.set(s.name, s); if (ns) out.set(`${ns}.${s.name}`, s); }
  if (s.type === 'record') for (const f of s.fields) names(f.type, out, ns);
  else if (s.type === 'array') names(s.items, out, ns);
  else if (s.type === 'map') names(s.values, out, ns);
  else if (typeof s.type === 'object') names(s.type, out, ns);
  return out;
}
function decode(s, r, named) {
  if (Array.isArray(s)) return decode(s[long(r)], r, named);   // a union: its branch, then the value
  if (typeof s === 'string') {
    switch (s) {
      case 'null': return null;
      case 'boolean': return r.b[r.i++] !== 0;
      case 'int': case 'long': return long(r);
      case 'float': { const v = new DataView(r.b.buffer, r.b.byteOffset + r.i, 4).getFloat32(0, true); r.i += 4; return v; }
      case 'double': { const v = new DataView(r.b.buffer, r.b.byteOffset + r.i, 8).getFloat64(0, true); r.i += 8; return v; }
      case 'bytes': return bytesOf(r);
      case 'string': return utf8.decode(bytesOf(r));
    }
    const t = named.get(s);
    if (!t) throw new Error(`Avro: unknown type ${s}`);
    return decode(t, r, named);
  }
  switch (s.type) {
    case 'record': { const o = {}; for (const f of s.fields) o[f.name] = decode(f.type, r, named); return o; }
    case 'enum': return s.symbols[long(r)];
    case 'fixed': return r.b.subarray(r.i, r.i += s.size);
    case 'array': case 'map': {
      const out = s.type === 'array' ? [] : {};
      for (let n; (n = long(r)) !== 0;) {
        if (n < 0) { n = -n; long(r); }   // a negative count is followed by the block's size
        for (let k = 0; k < n; k++) {
          if (s.type === 'array') out.push(decode(s.items, r, named));
          else { const key = utf8.decode(bytesOf(r)); out[key] = decode(s.values, r, named); }
        }
      }
      return out;
    }
    default: return decode(s.type, r, named);   // a primitive with a logical type
  }
}
async function inflateRaw(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export async function avroRecords(b) {
  if (b[0] !== 0x4f || b[1] !== 0x62 || b[2] !== 0x6a || b[3] !== 1) throw new Error('Avro: not an object container file');
  const r = { b, i: 4 }, meta = {};
  for (let n; (n = long(r)) !== 0;) {
    if (n < 0) { n = -n; long(r); }
    for (let k = 0; k < n; k++) { const key = utf8.decode(bytesOf(r)); meta[key] = utf8.decode(bytesOf(r)); }
  }
  r.i += 16;   // the sync marker
  const codec = meta['avro.codec'] || 'null';
  if (codec !== 'null' && codec !== 'deflate') throw new Error(`Avro: codec ${codec}`);
  const schema = JSON.parse(meta['avro.schema']), named = names(schema);
  const out = [];
  while (r.i < b.length) {
    const count = long(r), size = long(r);
    const block = b.subarray(r.i, r.i += size);
    r.i += 16;
    const br = { b: codec === 'deflate' ? await inflateRaw(block) : block, i: 0 };
    for (let k = 0; k < count; k++) out.push(decode(schema, br, named));
  }
  return out;
}

// --- Planning. A manifest is immutable: what it lists is kept by its path (Cache Storage,
// this browser's), so a new snapshot reads only the manifests it added. Each entry kept as
// [status, content, path, format, size]: status 2 is DELETED; content 0 data, 1 position
// deletes, 2 equality deletes (a v1 manifest has none: its manifest list says, 0).
const MANIFESTS = 'iceberg-manifests-v1';
const cacheKey = path => `https://manifests.local/${encodeURIComponent(path)}`;
async function cached(path) {
  try { const r = await (await caches.open(MANIFESTS)).match(cacheKey(path)); return r ? await r.json() : null; }
  catch (e) { return null; }   // no Cache Storage: read it again
}
async function keep(path, entries) {
  try { await (await caches.open(MANIFESTS)).put(cacheKey(path), new Response(JSON.stringify(entries))); } catch (e) {}
}
async function manifestEntries(path, content, url, name) {
  const hit = await cached(path);
  if (hit) return { entries: hit, fetched: false };
  const entries = (await avroRecords(await get(url(path), name))).map(e => {
    const f = e.data_file;
    return [e.status, f.content ?? content, f.file_path, String(f.file_format).toLowerCase(), f.file_size_in_bytes ?? null];
  });
  await keep(path, entries);
  return { entries, fetched: true };
}

// The current snapshot's live files: what DuckDB's iceberg_metadata() WHERE status <> 'DELETED'
// gives. `scan`: what a view over the Parquet files cannot read (no data file, a file that is
// not Parquet such as a deletion vector, an equality delete): the table fails to open.
export async function planTable(name, metadata, url) {
  if (!order.includes(name)) order.push(name);
  const current = String(metadata['current-snapshot-id']);
  const snapshot = (metadata.snapshots ?? []).find(s => String(s['snapshot-id']) === current);
  const record = { scan: true, files: [], deleteFiles: [], manifests: [] };
  if (!snapshot?.['manifest-list']) return { record, manifests: 0, fetched: 0 };
  const list = await avroRecords(await get(url(snapshot['manifest-list']), name));
  const read = await Promise.all(list.map(m => manifestEntries(m.manifest_path, m.content ?? 0, url, name)));
  const live = read.flatMap(m => m.entries).filter(e => e[0] !== 2);
  const files = content => [...new Map(live.filter(e => e[1] === content).map(e => [e[2], { path: e[2], size: e[4] }])).values()];
  Object.assign(record, {
    files: files(0), deleteFiles: files(1),
    manifests: list.map(m => m.manifest_path),
  });
  record.scan = !record.files.length || live.some(e => e[1] === 2 || e[3] !== 'parquet');
  return { record, manifests: list.length, fetched: read.filter(m => m.fetched).length };
}
