// =============================================================================
// blockcache.js — the local store DuckDB reads its files from, and its only way out
// =============================================================================
// A classic script, loaded into DuckDB's worker before the engine (data.js). DuckDB reads
// nothing from the network: the page downloads every file a table needs (prefetch.js) and
// hands it to this store before the table's view is created, and DuckDB reads the files by
// names registered to https://store.local/... (duckdb-wasm's own HTTP file system; no httpfs).
// store.local is not a host: this script answers it from the store, and a file the store does
// not hold is an error (404), not a request. No SAS ever reaches this worker.
// The one other request a worker may make is DuckDB downloading its extensions
// (extensions.duckdb.org/v<version>/wasm_eh/...), each kept here whole after its first load (a
// file under its version never changes). Every other request is refused: SQL typed in Explore
// cannot reach any URL.
//
// A file is kept in OPFS in blocks of BLOCK bytes under its OneLake path without the SAS
// (https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>/...; store.local/<ws>/<lh>/... reads it).
// An Iceberg file is never rewritten in place, so a block is never checked again. duckdb-wasm
// asks a HEAD with Range: bytes=0- first and reads by range only if that answers 206 with a
// Content-Length; then the footer, then column chunks.
//
// Two OPFS files, in blockcache/: blocks.bin (the blocks, appended) and index.jsonl (where
// each block is, and each file's size), read back at start. Over CAP_BYTES the store starts
// over. Every worker (each of the page's engines, in every tab) opens them 'readwrite-unsafe',
// the one mode two handles share (Chrome 121+; 'read-only' fails while a 'readwrite' handle is
// open, checked 2026-10-28), and one of them writes: the holder of the Web Lock
// 'blockcache-writer', for its lifetime. The others answer from what the writer has kept and
// read the index again on a miss (both files only grow); when the writer is gone, the next of
// them to be handed a file takes the lock and writes.
//
// The page's channel (BroadcastChannel 'blockcache'), to every tab's worker:
//   { ping }           the writer answers { writer: true } (it also says so when it becomes one);
//   { missing, id }    store paths: the writer answers { id, missing } with those it does not
//                      hold whole;
//   { stats, id }      the writer answers { id, stats: { files, bytes } } (the Logs tab);
//   { store, bytes }   a whole file the page downloaded: the writer keeps it and answers
//                      { stored }. Not the browser's HTTP cache: it does not keep a response of
//                      70-100 MB.
// =============================================================================
(() => {
  const BLOCK = 256 * 1024;
  // Whole files of every table read, and over the cap the store starts over: the cap is well
  // above what a model's tables hold, so it has room to grow.
  const CAP_BYTES = 8 * 1024 * 1024 * 1024;
  const VERSION = 1;
  const LOCAL = 'https://store.local/';
  const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com/';

  const P = XMLHttpRequest.prototype, open = P.open, set = P.setRequestHeader, send = P.send;
  let blocks = null, index = null;   // OPFS access handles, once open
  let writable = false;              // this worker is the writer: it keeps what it is handed
  let indexRead = 0;                 // bytes of index.jsonl applied (a reader reads on)
  const where = new Map();           // `${path}#${n}` -> [offset, length] in blocks.bin
  const files = new Map();           // path -> { size }
  let end = 0;                       // bytes in blocks.bin
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const pathOf = u => String(u).split('?')[0];
  const isExtension = u => /^https:\/\/(community-)?extensions\.duckdb\.org\/v[^/]+\/wasm_[a-z]+\/[^/]+\.duckdb_extension\.wasm$/i.test(pathOf(u));
  const isLocal = u => String(u).startsWith(LOCAL);
  // A store.local URL is the store path of the OneLake file it names.
  const storeKey = u => ONELAKE + pathOf(u).slice(LOCAL.length);

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
      else if (e.f && !files.has(e.f)) files.set(e.f, { size: e.s });
    }
    return true;
  }
  // A reader whose writer has started the store over (its index shrank): the offsets it holds
  // now point at other files' blocks.
  function freshIndex() {
    if (!writable && index.getSize() < indexRead) { where.clear(); files.clear(); indexRead = 0; }
    return applyIndex();
  }
  // A file kept whole: its size known and every block of it in the store.
  function whole(path) {
    const f = files.get(path);
    if (!f || !(f.size > 0)) return false;
    for (let n = 0; n * BLOCK < f.size; n++) if (!where.has(`${path}#${n}`)) return false;
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
  const announce = () => { try { bc?.postMessage({ writer: true }); } catch (e) {} };
  // Becomes the writer when the last one is gone: from what the index says now.
  let promoting = null;
  const promote = () => promoting ??= takeWriter().then(won => {
    promoting = null;
    if (!won || writable || !blocks) return writable;
    writable = true;
    if (!applyIndex()) reset();
    end = blocks.getSize();
    announce();
    return true;
  });

  let bc = null;
  (async () => {
    let dir;
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('blockcache', { create: true }); }
    catch (e) { return; }   // no OPFS: no store, and nothing for DuckDB to read
    try {
      const bh = await dir.getFileHandle('blocks.bin', { create: true });
      const ih = await dir.getFileHandle('index.jsonl', { create: true });
      const b = await bh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      const i = await ih.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      blocks = b; index = i; end = b.getSize();
      writable = await takeWriter();
      if (writable) { if (!applyIndex() || index.getSize() === 0 || end > CAP_BYTES) reset(); announce(); }
      else if (!applyIndex()) blocks = index = null;   // a store of another version, not reset yet
    } catch (e) { blocks = index = null; }   // a writer of an older build holds it exclusively
  })();

  try {
    bc = new BroadcastChannel('blockcache');
    bc.onmessage = async e => {
      const d = e.data ?? {};
      if (d.ping && writable) announce();
      if (d.missing && d.id != null && writable) bc.postMessage({ id: d.id, missing: d.missing.filter(p => !whole(p)) });
      if (d.stats && d.id != null && writable) bc.postMessage({ id: d.id, stats: { files: files.size, bytes: end } });
      // The writer answers once it has kept it; the others leave it to the writer, or become it
      // when it is gone.
      if (d.store && d.bytes && blocks && !writable) await promote();
      if (d.store && d.bytes && writable) {
        try { const b = new Uint8Array(d.bytes); keep(d.store, b, b.length); } catch (x) {}
        bc.postMessage({ stored: d.store });
      }
    };
  } catch (e) {}

  // A response DuckDB reads as if it came from a server: status, bytes and the headers it asks.
  function answer(xhr, status, body, headers = {}) {
    const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const text = { 200: 'OK', 206: 'Partial Content', 403: 'Forbidden', 404: 'Not Found' }[status] ?? '';
    const props = { status, readyState: 4, statusText: text, response: body, responseURL: xhr.__bcU };
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

  // Keeps a whole file, `body` of `size` bytes, as blocks (the writer only).
  function keep(path, body, size) {
    if (!writable) return;
    if (end > CAP_BYTES) reset();   // before the size is recorded: a reset clears it
    if (!files.has(path)) { files.set(path, { size }); log({ f: path, s: size }); }
    for (let n = 0; n * BLOCK < size; n++) {
      const key = `${path}#${n}`;
      const len = Math.min(BLOCK, size - n * BLOCK);
      if (where.has(key)) continue;
      blocks.write(body.subarray(n * BLOCK, n * BLOCK + len), { at: end });
      where.set(key, [end, len]);
      log({ k: key, o: end, l: len });
      end += len;
    }
    blocks.flush(); index.flush();
  }

  // A store.local read, answered from the store: a HEAD (its size; 206 when asked with a
  // range, as duckdb-wasm checks), a range, or the whole file. Not held: 404.
  function local(xhr) {
    if (!blocks || (xhr.__bcM !== 'GET' && xhr.__bcM !== 'HEAD')) return answer(xhr, 404, null);
    const path = storeKey(xhr.__bcU);
    let f = files.get(path);
    if (!f || !whole(path)) { freshIndex(); f = files.get(path); }   // the writer may have it by now
    if (!f || !whole(path)) return answer(xhr, 404, null);
    const r = /^bytes=(\d+)-(\d*)$/.exec(xhr.__bcR || '');
    if (xhr.__bcM === 'HEAD') return answer(xhr, r ? 206 : 200, null, { 'Content-Length': f.size, 'Accept-Ranges': 'bytes' });
    const a = r ? Number(r[1]) : 0, b = r && r[2] !== '' ? Math.min(Number(r[2]), f.size - 1) : f.size - 1;
    if (a > b) return answer(xhr, 404, null);
    const out = fromStore(path, a, b);
    if (!out) return answer(xhr, 404, null);
    return answer(xhr, r ? 206 : 200, out.buffer, { 'Content-Length': out.length, 'Accept-Ranges': 'bytes',
      ...(r ? { 'Content-Range': `bytes ${a}-${b}/${f.size}` } : {}) });
  }

  P.open = function (m, u, ...r) {
    this.__bcM = String(m).toUpperCase(); this.__bcU = String(u); this.__bcR = null;
    return open.call(this, m, u, ...r);
  };
  P.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'range') this.__bcR = String(v);
    return set.call(this, k, v);
  };
  P.send = function (body) {
    if (isLocal(this.__bcU)) return local(this);
    if (!isExtension(this.__bcU)) return answer(this, 403, null);   // nothing else leaves this worker
    // An extension: from the store, else from DuckDB's repository, then kept.
    const path = pathOf(this.__bcU);
    try {
      if (blocks && this.__bcM === 'GET' && !this.__bcR && (whole(path) || (freshIndex() && whole(path)))) {
        const out = fromStore(path, 0, files.get(path).size - 1);
        if (out) return answer(this, 200, out.buffer, { 'Content-Length': out.length });
      }
    } catch (e) {}
    const r = send.call(this, body);
    try {
      if (blocks && this.__bcM === 'GET' && !this.__bcR && this.status === 200 && this.response?.byteLength) {
        const bytes = new Uint8Array(this.response);
        if (writable) keep(path, bytes, bytes.length);
        else bc?.postMessage({ store: path, bytes });   // the writer keeps it
      }
    } catch (e) {}
    return r;
  };
})();
