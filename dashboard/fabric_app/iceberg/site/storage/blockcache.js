// =============================================================================
// blockcache.js — the worker's reads of Parquet files, kept in OPFS by block
// =============================================================================
// A classic script, loaded into DuckDB's worker before the engine (data.js). DuckDB-WASM reads
// a remote file by blocking requests, one at a time, each a round trip to OneLake (~0.4 s), and
// a scan of a large table makes hundreds. The browser's cache cannot keep them for long: every
// URL carries the SAS, which changes every hour.
//
// So the worker answers DuckDB's reads of .parquet files itself, the way the cache_httpfs
// extension does for httpfs (it has no WASM build): each read is cut into blocks of BLOCK
// bytes, a block is kept in OPFS under the file's path (no SAS), and only the blocks a read
// lacks are fetched, in one request. Only what queries read is kept: the column chunks of the
// row groups they scan, not whole files. An Iceberg file is never rewritten in place, so a
// block is never checked again. A HEAD of a file whose size is known is answered too.
// Every file of an Iceberg table is immutable, not only its Parquet: a commit writes a new
// metadata.json, a new manifest list and new manifests, and never touches the old ones. So
// those are kept too (.avro, .metadata.json), and planning a table that has not changed, or
// the old manifests of one that has, reads nothing from OneLake.
// DuckDB's extensions are kept the same way, whole: their folder is named after the engine's
// pins (ext-<hash>/, iceberg/duckdb.mjs), so a file there never changes either.
//
// Two OPFS files, in blockcache/: blocks.bin (the blocks, appended) and index.jsonl (where
// each block is, and each file's size and validators), read back at start. Over CAP_BYTES the
// store starts over. One tab writes them (an OPFS access handle is exclusive); another tab
// opens them read-only: it answers from what the writer has kept, reads the index again on a
// miss (both files only grow), and what it fetches itself it does not keep. Until the store
// is open, reads go to OneLake as before.
//
// What a miss fetches, in one round trip (a request costs ~0.5 s whatever its size):
//   - a file of WHOLE_BYTES or less: the whole file (a dimension, a small table's files);
//   - a read of READ_MIN or more: READAHEAD from its start, forward (DuckDB scans a file in
//     reads of ~2 MB, one after the other: a 100 MB file was 50 requests);
//   - a read in the last TAIL of a file: the whole tail (the 8 bytes before the footer, then
//     the footer, then the column index: one request instead of three);
//   - else its own blocks.
// The page tells the worker each file's size as it opens a table (BroadcastChannel
// 'blockcache', { sizes }), so a HEAD is answered without a request and the tail is known.
//
// Also: no If-Match. DuckDB 2.0 sends every ranged read with it (the ETag of its HEAD), and the
// browser's cache answers no request that carries it; an Iceberg file never changes, so the
// check guards nothing. (The engine also URL-encodes it, which OneLake answers with HTTP 412:
// duckdb/duckdb-wasm#2297.)
// =============================================================================
(() => {
  const BLOCK = 256 * 1024;
  const CAP_BYTES = 2 * 1024 * 1024 * 1024;
  const READ_MIN = 1024 * 1024;
  const READAHEAD = 16 * 1024 * 1024;
  const WHOLE_BYTES = 4 * 1024 * 1024;
  const TAIL = 1024 * 1024;
  const VERSION = 1;

  const P = XMLHttpRequest.prototype, open = P.open, set = P.setRequestHeader, send = P.send;
  let blocks = null, index = null;   // OPFS access handles, once open
  let writable = false;              // this tab keeps what it fetches; a read-only tab does not
  let indexRead = 0;                 // bytes of index.jsonl applied (a read-only tab reads on)
  const where = new Map();           // `${path}#${n}` -> [offset, length] in blocks.bin
  const files = new Map();           // path -> { size, etag, lastModified }
  let end = 0;                       // bytes in blocks.bin
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const pathOf = u => String(u).split('?')[0];
  const isExtension = u => /\/ext-[0-9a-f]+\/[^?]*\.duckdb_extension\.wasm$/i.test(pathOf(u));
  const isIceberg = u => /\.(parquet|avro|metadata\.json)$/i.test(pathOf(u));
  const cacheable = (m, u) => (m === 'GET' || m === 'HEAD') && (isIceberg(u) || isExtension(u));

  function log(entry) {
    if (!writable) return;
    const b = enc.encode(JSON.stringify(entry) + '\n');
    index.write(b, { at: index.getSize() });
    indexRead = index.getSize();
  }
  function reset() {
    blocks.truncate(0); index.truncate(0); where.clear(); files.clear(); end = 0; indexRead = 0;
    log({ v: VERSION, block: BLOCK });
  }
  // The index's lines not applied yet: all of them at start, and for a read-only tab what the
  // writer added since. The first line is the store's version; a store of another version is
  // reset by its writer, and a read-only tab leaves it alone and holds nothing.
  function applyIndex() {
    const size = index.getSize();
    if (size <= indexRead) return true;
    const buf = new Uint8Array(size - indexRead);
    index.read(buf, { at: indexRead });
    const text = dec.decode(buf);
    const cut = text.lastIndexOf('\n');   // a line the writer has not finished
    if (cut < 0) return true;
    const lines = text.slice(0, cut).split('\n').filter(Boolean);
    indexRead += enc.encode(text.slice(0, cut + 1)).length;
    end = blocks.getSize();   // a block the writer has indexed but not flushed yet is not taken
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch (x) { continue; }
      if (e.v !== undefined) { if (e.v !== VERSION || e.block !== BLOCK) return false; }
      else if (e.k) { if (e.o + e.l <= end) where.set(e.k, [e.o, e.l]); }
      else if (e.f && !files.has(e.f)) files.set(e.f, { size: e.s, etag: e.e, lastModified: e.m });
    }
    return true;
  }

  (async () => {
    let dir;
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('blockcache', { create: true }); }
    catch (e) { return; }   // no OPFS: reads go to OneLake
    const bh = await dir.getFileHandle('blocks.bin', { create: true });
    const ih = await dir.getFileHandle('index.jsonl', { create: true });
    try {
      const b = await bh.createSyncAccessHandle();
      const i = await ih.createSyncAccessHandle();
      blocks = b; index = i; writable = true; end = b.getSize();
      if (!applyIndex() || index.getSize() === 0 || end > CAP_BYTES) reset();
    } catch (e) {
      // Another tab writes the store: read it (Chrome 121+; an older browser throws here too,
      // and this tab reads OneLake).
      try {
        const b = await bh.createSyncAccessHandle({ mode: 'read-only' });
        const i = await ih.createSyncAccessHandle({ mode: 'read-only' });
        blocks = b; index = i; writable = false; end = b.getSize();
        if (!applyIndex()) { blocks = index = null; }
      } catch (x) { blocks = index = null; }
    }
  })();

  // The sizes the page knows (its snapshot records), so a HEAD is answered without a request
  // and a read in a file's tail fetches the whole tail.
  try {
    new BroadcastChannel('blockcache').onmessage = e => {
      for (const [path, size] of Object.entries(e.data?.sizes ?? {})) {
        if (files.has(path) || !(size > 0)) continue;
        files.set(path, { size, etag: null, lastModified: null });
        log({ f: path, s: size, e: null, m: null });
      }
      if (writable && index) index.flush();
    };
  } catch (e) {}

  // A response DuckDB reads as if it came from OneLake: status, bytes and the few headers it asks.
  function answer(xhr, status, body, headers) {
    const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const props = { status, readyState: 4, statusText: status === 206 ? 'Partial Content' : 'OK',
                    response: body, responseURL: xhr.__bcU };
    for (const [k, v] of Object.entries(props)) Object.defineProperty(xhr, k, { value: v, configurable: true });
    xhr.getResponseHeader = k => h[String(k).toLowerCase()] ?? null;
    xhr.getAllResponseHeaders = () => Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  }

  // The bytes [a, b] of `path` from the store, or null when a block is missing.
  function fromStore(path, a, b) {
    const out = new Uint8Array(b - a + 1);
    for (let n = Math.floor(a / BLOCK); n <= Math.floor(b / BLOCK); n++) {
      const at = where.get(`${path}#${n}`);
      if (!at) return null;
      const block = new Uint8Array(at[1]);
      blocks.read(block, { at: at[0] });
      const s = Math.max(a, n * BLOCK), e = Math.min(b, n * BLOCK + at[1] - 1);
      out.set(block.subarray(s - n * BLOCK, e - n * BLOCK + 1), s - a);
    }
    return out;
  }

  // Fetches the blocks [first, last] of `url` in one request and keeps them. False on failure.
  function fetchBlocks(url, path, first, last) {
    const x = new XMLHttpRequest();
    open.call(x, 'GET', url, false);
    x.responseType = 'arraybuffer';
    const known = files.get(path);
    const to = known ? Math.min((last + 1) * BLOCK, known.size) - 1 : (last + 1) * BLOCK - 1;
    set.call(x, 'Range', `bytes=${first * BLOCK}-${to}`);
    send.call(x, null);
    if (x.status !== 206 && x.status !== 200) return false;
    const body = new Uint8Array(x.response);
    const start = x.status === 200 ? 0 : first * BLOCK;
    const size = x.status === 200 ? body.length
      : Number((x.getResponseHeader('Content-Range') || '').split('/')[1]) || known?.size;
    if (!size) return false;
    keep(x, path, body, start, size);
    return true;
  }

  // Keeps the bytes `body`, from offset `start` of a file of `size` bytes, as blocks. A
  // read-only tab keeps nothing: it only learns the file's size, for the HEADs that follow.
  function keep(x, path, body, start, size) {
    if (!files.has(path)) {
      const f = { size, etag: x.getResponseHeader('ETag'), lastModified: x.getResponseHeader('Last-Modified') };
      files.set(path, f);
      log({ f: path, s: f.size, e: f.etag, m: f.lastModified });
    }
    if (!writable) return;
    if (end > CAP_BYTES) reset();
    for (let n = Math.floor(start / BLOCK); n * BLOCK < start + body.length; n++) {
      const key = `${path}#${n}`;
      const s = n * BLOCK - start, len = Math.min(BLOCK, size - n * BLOCK, body.length - s);
      if (where.has(key) || len <= 0 || (len < BLOCK && n * BLOCK + len < size)) continue;   // a partial block is not kept
      blocks.write(body.subarray(s, s + len), { at: end });
      where.set(key, [end, len]);
      log({ k: key, o: end, l: len });
      end += len;
    }
    blocks.flush(); index.flush();
  }

  P.open = function (m, u, ...r) {
    this.__bcM = String(m).toUpperCase(); this.__bcU = String(u); this.__bcR = null;
    return open.call(this, m, u, ...r);
  };
  P.setRequestHeader = function (k, v) {
    const n = String(k).toLowerCase();
    if (n === 'if-match') return;
    if (n === 'range') this.__bcR = String(v);
    return set.call(this, k, v);
  };
  P.send = function (body) {
    try {
      if (blocks && cacheable(this.__bcM, this.__bcU)) {
        const path = pathOf(this.__bcU), f = files.get(path);
        if (this.__bcM === 'HEAD') {
          if (f) return answer(this, 200, null, { 'Content-Length': f.size, 'Accept-Ranges': 'bytes',
                                                  ETag: f.etag, 'Last-Modified': f.lastModified });
        } else {
          const r = /^bytes=(\d+)-(\d*)$/.exec(this.__bcR || '');
          if (!r && f) {
            const out = fromStore(path, 0, f.size - 1);
            if (out) return answer(this, 200, out.buffer, { 'Content-Length': out.length, 'Accept-Ranges': 'bytes',
                                                            ETag: f.etag, 'Last-Modified': f.lastModified });
          }
          if (r) {
            const a = Number(r[1]);
            const b = r[2] === '' ? (f ? f.size - 1 : NaN) : (f ? Math.min(Number(r[2]), f.size - 1) : Number(r[2]));
            if (Number.isFinite(b) && b >= a) {
              let out = fromStore(path, a, b);
              if (!out && !writable && applyIndex()) out = fromStore(path, a, b);   // the writer may have it by now
              if (!out) {
                let first = Math.floor(a / BLOCK), last = Math.floor(b / BLOCK);
                const blocksOf = g => Math.ceil(g.size / BLOCK) - 1;
                if (f && f.size <= WHOLE_BYTES) { first = 0; last = blocksOf(f); }
                else if (b - a + 1 >= READ_MIN) last = Math.max(last, f ? Math.min(first + READAHEAD / BLOCK - 1, blocksOf(f)) : first + READAHEAD / BLOCK - 1);
                else if (f && b >= f.size - TAIL) { first = Math.min(first, Math.max(0, Math.floor((f.size - TAIL) / BLOCK))); last = blocksOf(f); }
                while (first <= last && where.has(`${path}#${first}`)) first++;
                while (last >= first && where.has(`${path}#${last}`)) last--;
                if (writable && fetchBlocks(this.__bcU, path, first, last)) out = fromStore(path, a, Math.min(b, files.get(path).size - 1));
              }
              if (out) {
                const g = files.get(path);
                return answer(this, 206, out.buffer, { 'Content-Length': out.length, 'Accept-Ranges': 'bytes',
                  'Content-Range': `bytes ${a}-${a + out.length - 1}/${g.size}`, ETag: g.etag, 'Last-Modified': g.lastModified });
              }
            }
          }
        }
      }
    } catch (e) { /* the store failed: the request goes to OneLake as it is */ }
    const r = send.call(this, body);
    // A whole file that went to OneLake or the app's hosting (an extension): kept, all of it.
    try {
      if (blocks && this.__bcM === 'GET' && !this.__bcR && cacheable(this.__bcM, this.__bcU) && this.status === 200
          && this.response && this.response.byteLength) {
        const bytes = new Uint8Array(this.response);
        keep(this, pathOf(this.__bcU), bytes, 0, bytes.length);
      }
    } catch (e) {}
    // A HEAD that went to OneLake teaches the store the file's size, for the reads that follow.
    try {
      if (blocks && this.__bcM === 'HEAD' && cacheable(this.__bcM, this.__bcU) && this.status === 200) {
        const path = pathOf(this.__bcU), size = Number(this.getResponseHeader('Content-Length'));
        if (size && !files.has(path)) {
          const f = { size, etag: this.getResponseHeader('ETag'), lastModified: this.getResponseHeader('Last-Modified') };
          files.set(path, f);
          log({ f: path, s: f.size, e: f.etag, m: f.lastModified });
          index.flush();
        }
      }
    } catch (e) {}
    return r;
  };
})();
