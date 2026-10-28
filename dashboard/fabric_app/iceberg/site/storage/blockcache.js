// =============================================================================
// blockcache.js — the worker's reads of Parquet files, kept in OPFS by block
// =============================================================================
// A classic script, loaded into DuckDB's worker before the engine (data.js). DuckDB-WASM reads
// a remote file by blocking requests, one at a time, each a round trip to OneLake (~0.4 s), and
// a scan of a large table makes hundreds. The browser's cache cannot keep them for long: every
// URL carries the SAS, which changes every hour.
//
// So the worker answers DuckDB's reads of .parquet files itself, the way the cache_httpfs
// extension does for httpfs (it has no WASM build): a file is kept in OPFS in blocks of BLOCK
// bytes under its path (no SAS), and a read is answered from them. An Iceberg file is never
// rewritten in place, so a block is never checked again. A HEAD of a file whose size is known
// is answered too.
// Every file of an Iceberg table is immutable, not only its Parquet: a commit writes a new
// metadata.json, a new manifest list and new manifests, and never touches the old ones. So
// those are kept too (.avro, .metadata.json), and planning a table that has not changed, or
// the old manifests of one that has, reads nothing from OneLake.
// DuckDB's extensions are kept the same way, whole: a file of DuckDB's repositories sits
// under its version (extensions.duckdb.org/v<version>/wasm_eh/...), so it never changes.
//
// Two OPFS files, in blockcache/: blocks.bin (the blocks, appended) and index.jsonl (where
// each block is, and each file's size and validators), read back at start. Over CAP_BYTES the
// store starts over. Every worker (each of the page's engines, in every tab) opens them
// 'readwrite-unsafe', the one mode two handles share (Chrome 121+; 'read-only' fails while a
// 'readwrite' handle is open, checked 2026-10-28), and one of them writes: the holder of the
// Web Lock 'blockcache-writer', for its lifetime. The others answer from what the writer has
// kept, read the index again on a miss (both files only grow), and hand what they fetch to the
// writer to keep; when the writer is gone, the next of them to be handed a file takes the
// lock and writes. Until the store is open, reads go to OneLake as before.
//
// OneLake is never seeked: a request costs ~0.5 s whatever its size, and DuckDB reads a
// Parquet file in many (the footer in three, then a column chunk at a time). The page
// downloads a table's files whole, six at a time, and hands them to the writer over the
// channel before the table's view is created (prefetch.js), so DuckDB's ranged reads are
// answered here. A file still missing (a table read before its prefetch, a store reset) is
// fetched whole, in one request, on its first read. The page also tells the worker each
// file's size as it opens a table, so a HEAD is answered without a request.
//
// Also: no If-Match. DuckDB 2.0 (not the 1.5 this app runs) sends every ranged read with it (the ETag of its HEAD), and the
// browser's cache answers no request that carries it; an Iceberg file never changes, so the
// check guards nothing. (The engine also URL-encodes it, which OneLake answers with HTTP 412:
// duckdb/duckdb-wasm#2297.)
// =============================================================================
(() => {
  const BLOCK = 256 * 1024;
  // Whole files of every table read, and over the cap the store starts over: the cap is well
  // above what a model's tables hold, so it has room to grow.
  const CAP_BYTES = 8 * 1024 * 1024 * 1024;
  const VERSION = 1;

  const P = XMLHttpRequest.prototype, open = P.open, set = P.setRequestHeader, send = P.send;
  let blocks = null, index = null;   // OPFS access handles, once open
  let writable = false;              // this worker is the writer: it keeps what it fetches
  let indexRead = 0;                 // bytes of index.jsonl applied (a reader reads on)
  const where = new Map();           // `${path}#${n}` -> [offset, length] in blocks.bin
  const files = new Map();           // path -> { size, etag, lastModified }
  let end = 0;                       // bytes in blocks.bin
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const pathOf = u => String(u).split('?')[0];
  const isExtension = u => /^https:\/\/(community-)?extensions\.duckdb\.org\/v[^/]+\/wasm_[a-z]+\/[^/]+\.duckdb_extension\.wasm$/i.test(pathOf(u));
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
  // The index's lines not applied yet: all of them at start, and for a reader what the
  // writer added since. The first line is the store's version; a store of another version is
  // reset by its writer, and a reader leaves it alone and holds nothing.
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

  // The writer's lock, if no one holds it: held until the worker ends. Without the Locks API
  // the handles are exclusive anyway (a browser before 121 ignores the mode), so the worker that
  // opened them writes.
  const takeWriter = () => !navigator.locks ? Promise.resolve(true) : new Promise(resolve => {
    navigator.locks.request('blockcache-writer', { ifAvailable: true }, lock => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(false));
  });
  // Becomes the writer when the last one is gone: from what the index says now.
  let promoting = null;
  const promote = () => promoting ??= takeWriter().then(won => {
    promoting = null;
    if (!won || writable || !blocks) return writable;
    writable = true;
    if (!applyIndex()) reset();
    end = blocks.getSize();
    return true;
  });

  (async () => {
    let dir;
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('blockcache', { create: true }); }
    catch (e) { return; }   // no OPFS: reads go to OneLake
    try {
      const bh = await dir.getFileHandle('blocks.bin', { create: true });
      const ih = await dir.getFileHandle('index.jsonl', { create: true });
      const b = await bh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      const i = await ih.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      blocks = b; index = i; end = b.getSize();
      writable = await takeWriter();
      if (writable) { if (!applyIndex() || index.getSize() === 0 || end > CAP_BYTES) reset(); }
      else if (!applyIndex()) blocks = index = null;   // a store of another version, not reset yet
    } catch (e) { blocks = index = null; }   // a writer of an older build holds it exclusively
  })();

  // The page's channel (BroadcastChannel 'blockcache'), to every tab's worker:
  //   { sizes }          the sizes the page knows (its snapshot records), so a HEAD is answered
  //                      without a request;
  //   { store, bytes }   a whole file the page downloaded (prefetch.js), or a reader's
  //                      worker fetched: the writer keeps it and answers { stored }. Not the
  //                      browser's HTTP cache: it does not keep a response of 70-100 MB.
  let bc = null;
  try {
    bc = new BroadcastChannel('blockcache');
    bc.onmessage = async e => {
      for (const [path, size] of Object.entries(e.data?.sizes ?? {})) {
        if (files.has(path) || !(size > 0)) continue;
        files.set(path, { size, etag: null, lastModified: null });
        log({ f: path, s: size, e: null, m: null });
      }
      if (writable && index) index.flush();
      const { store, bytes } = e.data ?? {};
      // The writer answers once it has kept it, and a worker with no store at once (nothing will
      // keep it: the page waits no longer); the others leave it to the writer, or become it
      // when it is gone.
      if (store && bytes && blocks && !writable) await promote();
      if (store && bytes && (writable || !blocks)) {
        if (writable) try { const b = new Uint8Array(bytes); keep(NO_HEADERS, store, b, 0, b.length); } catch (x) {}
        bc.postMessage({ stored: store });
      }
    };
  } catch (e) {}
  const NO_HEADERS = { getResponseHeader: () => null };

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
    // A reader whose writer has started the store over (its index shrank): the offsets
    // it holds now point at other files' blocks.
    if (!writable && index.getSize() < indexRead) {
      where.clear(); files.clear(); indexRead = 0;
      if (!applyIndex()) return null;
    }
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

  // Fetches the whole of `url` in one request and keeps it: its bytes, or null on failure.
  function fetchWhole(url, path) {
    const x = new XMLHttpRequest();
    open.call(x, 'GET', url, false);
    x.responseType = 'arraybuffer';
    send.call(x, null);
    if (x.status !== 200 || !x.response || !x.response.byteLength) return null;
    const body = new Uint8Array(x.response);
    keep(x, path, body, 0, body.length);
    return body;
  }

  // Keeps the bytes `body`, from offset `start` of a file of `size` bytes, as blocks. A
  // reader does not write the store: it learns the file's size, and hands a whole file to
  // the writer, from which its next reads come.
  function keep(x, path, body, start, size) {
    // Before the file's size is recorded: a reset clears it.
    if (writable && end > CAP_BYTES) reset();
    if (!files.has(path)) {
      const f = { size, etag: x.getResponseHeader('ETag'), lastModified: x.getResponseHeader('Last-Modified') };
      files.set(path, f);
      log({ f: path, s: f.size, e: f.etag, m: f.lastModified });
    }
    if (!writable) {
      if (bc && start === 0 && body.length === size) try { bc.postMessage({ store: path, bytes: body }); } catch (e) {}
      return;
    }
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
            const end = g => r[2] === '' ? g.size - 1 : Math.min(Number(r[2]), g.size - 1);
            let out = f && end(f) >= a ? fromStore(path, a, end(f)) : null;
            if (!out && f && !writable && applyIndex()) out = fromStore(path, a, end(f));   // the writer may have it by now
            if (!out) {
              const whole = fetchWhole(this.__bcU, path);
              const g = files.get(path);
              if (whole && g && end(g) >= a) out = whole.slice(a, end(g) + 1);
            }
            if (out && out.length) {
              const g = files.get(path);
              return answer(this, 206, out.buffer, { 'Content-Length': out.length, 'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${a}-${a + out.length - 1}/${g.size}`, ETag: g.etag, 'Last-Modified': g.lastModified });
            }
          }
        }
      }
    } catch (e) { /* the store failed: the request goes to OneLake as it is */ }
    const r = send.call(this, body);
    // A whole file that went to OneLake or DuckDB's repository (an extension): kept, all of it.
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
