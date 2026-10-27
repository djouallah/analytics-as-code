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
//
// Two OPFS files, in blockcache/: blocks.bin (the blocks, appended) and index.jsonl (where
// each block is, and each file's size and validators), read back at start. Over CAP_BYTES the
// store starts over. A second tab cannot open them (an OPFS access handle is exclusive): its
// reads go to OneLake as before. Until the store is open, likewise.
//
// Also: no If-Match. DuckDB 2.0 sends every ranged read with it (the ETag of its HEAD), and the
// browser's cache answers no request that carries it; an Iceberg file never changes, so the
// check guards nothing. (The engine also URL-encodes it, which OneLake answers with HTTP 412:
// duckdb/duckdb-wasm#2297.)
// =============================================================================
(() => {
  const BLOCK = 256 * 1024;
  const CAP_BYTES = 2 * 1024 * 1024 * 1024;
  const VERSION = 1;

  const P = XMLHttpRequest.prototype, open = P.open, set = P.setRequestHeader, send = P.send;
  let blocks = null, index = null;   // OPFS access handles, once open
  const where = new Map();           // `${path}#${n}` -> [offset, length] in blocks.bin
  const files = new Map();           // path -> { size, etag, lastModified }
  let end = 0;                       // bytes in blocks.bin
  const enc = new TextEncoder();

  const pathOf = u => String(u).split('?')[0];
  const cacheable = (m, u) => (m === 'GET' || m === 'HEAD') && /\.parquet$/i.test(pathOf(u));

  function log(entry) {
    const b = enc.encode(JSON.stringify(entry) + '\n');
    index.write(b, { at: index.getSize() });
  }
  function reset() {
    blocks.truncate(0); index.truncate(0); where.clear(); files.clear(); end = 0;
    log({ v: VERSION, block: BLOCK });
  }

  (async () => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('blockcache', { create: true });
      const b = await (await dir.getFileHandle('blocks.bin', { create: true })).createSyncAccessHandle();
      const i = await (await dir.getFileHandle('index.jsonl', { create: true })).createSyncAccessHandle();
      const buf = new Uint8Array(i.getSize());
      i.read(buf, { at: 0 });
      blocks = b; index = i; end = b.getSize();
      const lines = new TextDecoder().decode(buf).split('\n').filter(Boolean);
      let ok = false;
      try {
        const head = JSON.parse(lines[0] || '{}');
        ok = head.v === VERSION && head.block === BLOCK;
        if (ok) for (const l of lines.slice(1)) {
          const e = JSON.parse(l);
          if (e.k) where.set(e.k, [e.o, e.l]);
          else if (e.f) files.set(e.f, { size: e.s, etag: e.e, lastModified: e.m });
        }
      } catch (e) { ok = false; }
      if (!ok || end > CAP_BYTES) reset();
    } catch (e) { blocks = index = null; }   // a second tab, or no OPFS: reads go to OneLake
  })();

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
    if (!known) {
      const f = { size, etag: x.getResponseHeader('ETag'), lastModified: x.getResponseHeader('Last-Modified') };
      files.set(path, f);
      log({ f: path, s: f.size, e: f.etag, m: f.lastModified });
    }
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
    return true;
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
          if (r) {
            const a = Number(r[1]);
            const b = r[2] === '' ? (f ? f.size - 1 : NaN) : (f ? Math.min(Number(r[2]), f.size - 1) : Number(r[2]));
            if (Number.isFinite(b) && b >= a) {
              let out = fromStore(path, a, b);
              if (!out) {
                let first = Math.floor(a / BLOCK), last = Math.floor(b / BLOCK);
                while (first <= last && where.has(`${path}#${first}`)) first++;
                while (last >= first && where.has(`${path}#${last}`)) last--;
                if (fetchBlocks(this.__bcU, path, first, last)) out = fromStore(path, a, Math.min(b, files.get(path).size - 1));
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
