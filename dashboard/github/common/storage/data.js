// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with the dashboard's .duckdb files attached
// =============================================================================
// The GitHub Pages version. The files sit next to the page in data/ and are downloaded whole
// into OPFS; GitHub caps a file at 100 MB, hence the half-year split of the 5-minute history:
// They are the tables of the semantic model, copied as they are (scripts/cache_catalog.py):
//   mart_dim.duckdb            as `dim`          the dimensions
//   mart_today.duckdb          as `today`        the 5-minute tables, the newest 14 days
//   mart_agg.duckdb            as `agg`          the per-day and per-month tables: attachAgg(), after
//                                                first paint
//   mart_<YYYY>_h<N>.duckdb    as `p<YYYY>_h<N>` the 5-minute tables by half-year: ensureHistory(), only
//                                                the half-years a 5-minute range needs
// The page knows none of this: it reads a view per table, v_<table>, which views.js builds
// over the attached databases after every attach (they are found in the engine's catalog).
// A host that stores the files differently (the Fabric app,
// ../../../fabric_app/wasm/site/storage/data.js: a lakehouse behind a Fabric sign-in) has its own data.js with
// the same members, over the same history.js and views.js.
//
// DOM-free: progress is reported through the injected `onStatus` callback, and what is
// fetched, attached and run is timed in perflog.js, for the Logs tab.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
import { periodsForRange, attachCached } from "./history.js";
import { withViews } from "./views.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

export function createDataSource({ onStatus = () => {} } = {}) {
  let conn;

  // Cache a remote .duckdb file in OPFS. Downloads if missing or stale.
  // source: 'opfs-hit' | 'opfs-miss' | 'opfs-refresh'; buffer: the download, only if it couldn't be cached
  async function cacheInOPFS(url, filename) {
    let root;
    try {
      root = await navigator.storage.getDirectory();
    } catch (e) {
      // No OPFS (some private windows, older browsers): no cache, read from memory.
      console.log(`[OPFS] unavailable (${e}), loading ${filename} into memory`);
      onStatus("Downloading database...");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${resp.status}`);
      const buffer = new Uint8Array(await resp.arrayBuffer());
      return { source: 'no-opfs', buffer, bytes: buffer.byteLength };
    }
    const cacheKey = `opfs_etag_${filename}`;
    const cachedTag = localStorage.getItem(cacheKey);

    // HEAD request to check if remote file changed
    let remoteTag = null;
    try {
      // ETag first: a .duckdb file grows in 256 KB blocks, so a rebuilt file very often
      // keeps its exact size and a content-length key would keep serving the stale copy.
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      remoteTag = head.headers.get('etag') || head.headers.get('last-modified') || head.headers.get('content-length');
    } catch (e) {
      console.log(`[OPFS] HEAD request failed (offline?), will use cache if available`);
    }

    // Try cached version: valid if tags match, or if offline and we have a cache
    const cacheValid = cachedTag && (cachedTag === remoteTag || !remoteTag);
    if (cacheValid) {
      try {
        onStatus("Loading from cache...");
        const handle = await root.getFileHandle(filename);
        const file = await handle.getFile();
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        console.log(`[OPFS] Cache hit for ${filename} (${sizeMB} MB)`);
        return { source: 'opfs-hit', buffer: null, bytes: file.size };
      } catch (e) {
        console.log(`[OPFS] Cache entry missing from OPFS despite etag, will re-fetch`);
      }
    }

    // Fetch and cache in OPFS
    const reason = cachedTag ? 'file changed on server' : 'first download';
    console.log(`[OPFS] Fetching ${filename} (${reason})`);
    onStatus("Downloading database...");
    // no-store like the HEAD above: the HTTP cache may still hold the previous body (GitHub
    // Pages sends max-age=600), and storing that under the new ETag would keep a stale file
    // until the next change on the server.
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${resp.status}`);
    const buffer = new Uint8Array(await resp.arrayBuffer());
    if (buffer.byteLength < 100) throw new Error(`${filename} is too small (${buffer.byteLength} bytes), likely not a valid database`);
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);

    const source = cachedTag ? 'opfs-refresh' : 'opfs-miss';
    try {
      const handle = await root.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(buffer);
      await writable.close();
    } catch (e) {
      // Another tab reading the file in place holds its exclusive handle.
      console.log(`[OPFS] Could not write ${filename} (${e}), using the download in memory`);
      return { source, buffer, bytes: buffer.byteLength };
    }
    if (remoteTag) localStorage.setItem(cacheKey, remoteTag);
    console.log(`[OPFS] Cached ${filename} (${sizeMB} MB) in OPFS`);
    return { source, buffer: null, bytes: buffer.byteLength };
  }

  // Download (or reuse from OPFS) data/<file> and ATTACH it as <alias>.
  const SOURCE_LABEL = { 'opfs-hit': 'cached', 'opfs-miss': 'downloaded', 'opfs-refresh': 'refreshed', 'no-opfs': 'downloaded, not cached' };
  async function loadDb(file, alias) {
    let t = performance.now();
    const res = await cacheInOPFS(`${_baseUrl}/data/${file}`, file);
    perf.log('fetch', file, { ms: performance.now() - t, status: SOURCE_LABEL[res.source], bytes: res.bytes });
    t = performance.now();
    const mode = await attachCached(_db, conn, file, alias, res.buffer);
    perf.log('attach', `ATTACH ${file} AS ${alias}`, { ms: performance.now() - t, status: mode });
    console.log(`[OPFS] ${alias}: ${SOURCE_LABEL[res.source]} (${mode})`);
  }

  let _db = null;
  let _baseUrl = '';

  // DuckDB-WASM up, `dim` + `today` attached: enough for the default "Last 3 days" view.
  // `base`: where data/ is, relative to the page's folder (a page in a folder of the site
  // reads the site's files, '../').
  async function init({ base = '' } = {}) {
    onStatus("Loading DuckDB WASM...");
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    _db = new duckdb.AsyncDuckDB(logger, worker);
    await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    conn = await _db.connect();
    _baseUrl = new URL(base || '.', window.location.href).href.replace(/\/$/, "");

    onStatus("Loading today's data...");
    await Promise.all([loadDb('mart_dim.duckdb', 'dim'), loadDb('mart_today.duckdb', 'today')]);
    await conn.query("SET TimeZone = 'Australia/Brisbane';");
    await conn.query("SET preserve_insertion_order = false;");
    return { db: _db };
  }

  // One attach, whoever asks; a failed one can be asked for again.
  let _agg = null;
  function attachAgg() {
    return _agg ??= loadDb('mart_agg.duckdb', 'agg').catch(e => { _agg = null; throw e; });
  }

  let _manifest = null;
  const _attachedPeriods = new Set();
  // Periods that failed to attach, and when: left alone for a minute, so a file that is
  // missing is not fetched again by every render.
  const _failedPeriods = new Map();
  const RETRY_MS = 60000;

  // Attach one half-year period; true if it is attached now. A period the manifest
  // advertises but whose .duckdb didn't deploy is skipped instead of breaking the whole
  // query: recent days still come from `today` and the other periods still load.
  async function attachPeriod(p) {
    try {
      await loadDb(`mart_${p}.duckdb`, `p${p}`);
      _attachedPeriods.add(p);
      _failedPeriods.delete(p);
      return true;
    } catch (e) {
      console.warn(`[OPFS] skipping period ${p}: ${e}`);
      _failedPeriods.set(p, Date.now());
      return false;
    }
  }

  // One attach per period at a time: a second call while the first is still downloading
  // shares it. Attached twice, the second ATTACH fails and its fallback drops or replaces
  // the file registration the first one is reading (2026-10-07).
  const _attaching = new Map();
  const attachOnce = p => _attaching.get(p) ?? _attaching.set(p, attachPeriod(p).finally(() => _attaching.delete(p))).get(p);

  // Attach the half-year periods of a date range that exist and aren't attached yet.
  // True if any was attached. The caller (views.js) asks only for a range that reaches
  // back past the days `today` covers.
  async function ensureHistory(from, to, msg) {
    if (!_manifest) {
      // no-store: a manifest from the HTTP cache can predate a half-year rollover.
      const resp = await fetch(`${_baseUrl}/data/mart_manifest.json`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`Failed to fetch mart_manifest.json: HTTP ${resp.status}`);
      _manifest = await resp.json();
    }
    const needed = periodsForRange(from, to).filter(p => _manifest.periods.includes(p)
      && !_attachedPeriods.has(p) && !(Date.now() - _failedPeriods.get(p) < RETRY_MS));
    if (!needed.length) return false;
    onStatus(msg);
    return (await Promise.all(needed.map(attachOnce))).includes(true);
  }

  return withViews({
    init, attachAgg, ensureHistory,
    // `dax`: the query as the page wrote it, for the Logs tab (the compiler passes it).
    query: (sql, dax) => perf.query(sql, () => conn.query(sql), dax),
  });
}
