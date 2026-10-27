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
//   prefetchTable(metadata, url, { data })  metadata: the table's metadata.json, parsed;
//                                           url(abfss) -> the https URL DuckDB will ask for;
//                                           data: the data files too (delete files included:
//                                           a table about to be read whole), after every
//                                           table's metadata layers.
// =============================================================================

// OneLake answers HTTP/1.1 only, so a browser keeps six connections to it: more would queue.
const PARALLEL = 6;

// PARALLEL slots shared by every table. The metadata layers go before the data files: a
// table cannot be opened before its manifests, whoever's data files are still coming. (Data
// files fetched only when their table opens were slower: tables open one at a time.)
let active = 0;
const waiting = { high: [], low: [] };
async function limited(fn, low) {
  if (active >= PARALLEL) await new Promise(r => waiting[low ? 'low' : 'high'].push(r));
  active++;
  try { return await fn(); } finally { active--; (waiting.high.shift() ?? waiting.low.shift())?.(); }
}
const get = (url, low = false) => limited(async () => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}, low);

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
export async function prefetchTable(metadata, url, { data = false } = {}) {
  const current = String(metadata['current-snapshot-id']);
  const snapshot = (metadata.snapshots ?? []).find(s => String(s['snapshot-id']) === current);
  if (!snapshot?.['manifest-list']) return 0;
  const list = await avroText(await get(url(snapshot['manifest-list'])));
  const manifests = await Promise.all(paths(list, 'avro').map(async m => avroText(await get(url(m)))));
  let n = 1 + manifests.length;
  if (data) {
    const files = [...new Set(manifests.flatMap(m => paths(m, 'parquet')))];
    // A manifest also names the files a later snapshot removed (its DELETED entries, which this
    // reader does not tell apart): those answer 404 and are skipped.
    await Promise.all(files.map(f => get(url(f), true).catch(() => null)));
    n += files.length;
  }
  return n;
}
