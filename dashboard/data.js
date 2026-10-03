// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with the dashboard's .duckdb files attached
// =============================================================================
// The GitHub Pages version. The files sit next to the page in data/ and are downloaded whole
// into OPFS; GitHub caps a file at 100 MB, hence the half-year split of the 5-minute history:
//   energy_dim.duckdb               as `dim`          dim_calendar, dim_duid
//   energy_today.duckdb             as `today`        scada_today, price_today, interconnector_today (last 14 days, 5-min)
//   energy_daily_agg.duckdb         as `agg`          daily and hour-of-day rollups: attachAgg(), after first paint
//   energy_data_<YYYY>_h<N>.duckdb  as `p<YYYY>_h<N>` scada, price, interconnector: ensureHistory(), only the
//                                                     half-years a 5-minute range needs
// index.html knows none of this: it calls the members createDataSource returns and builds its
// views from history() and recentCut. A host that stores the files differently (the Fabric app
// reads one history file over HTTP) swaps this file for its own with the same members.
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";

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
      return { source: 'no-opfs', buffer: new Uint8Array(await resp.arrayBuffer()) };
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
        return { source: 'opfs-hit', buffer: null };
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
      return { source, buffer };
    }
    if (remoteTag) localStorage.setItem(cacheKey, remoteTag);
    console.log(`[OPFS] Cached ${filename} (${sizeMB} MB) in OPFS`);
    return { source, buffer: null };
  }

  // ATTACH a cached file READ_ONLY. Preferred: DuckDB reads it in place from OPFS, pulling
  // only the pages a query touches, instead of the whole file being copied into the WASM heap.
  // That needs an exclusive sync access handle, which a second tab on the same origin can't
  // get, so fall back to copying the file into memory. `buffer` is set when cacheInOPFS
  // couldn't write the file to OPFS.
  async function attachCached(db, filename, alias, buffer) {
    if (!buffer) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(filename);
      try {
        // Registered under the plain name, not opfs://: an opfs:// ATTACH also opens
        // opfs://<file>.wal, which is never registered, and the ATTACH fails.
        await db.registerFileHandle(filename, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
        await conn.query(`ATTACH '${filename}' AS ${alias} (READ_ONLY);`);
        return 'in place';
      } catch (e) {
        console.log(`[OPFS] In-place read failed for ${filename} (${e}), loading into memory`);
        try { await db.dropFile(filename); } catch (_) {}
        buffer = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      }
    }
    await db.registerFileBuffer(filename, buffer);
    await conn.query(`ATTACH '${filename}' AS ${alias} (READ_ONLY);`);
    return 'in memory';
  }

  // Download (or reuse from OPFS) data/<file> and ATTACH it as <alias>.
  const SOURCE_LABEL = { 'opfs-hit': 'cached', 'opfs-miss': 'downloaded', 'opfs-refresh': 'refreshed', 'no-opfs': 'downloaded, not cached' };
  async function loadDb(file, alias) {
    const res = await cacheInOPFS(`${_baseUrl}/data/${file}`, file);
    const mode = await attachCached(_db, file, alias, res.buffer);
    console.log(`[OPFS] ${alias}: ${SOURCE_LABEL[res.source]} (${mode})`);
  }

  let _db = null;
  let _baseUrl = '';

  // DuckDB-WASM up, `dim` + `today` attached: enough for the default "Last 3 days" view.
  async function init() {
    onStatus("Loading DuckDB WASM...");
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    _db = new duckdb.AsyncDuckDB(logger, worker);
    await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    conn = await _db.connect();
    _baseUrl = window.location.href.replace(/\/[^/]*$/, "");

    onStatus("Loading today's data...");
    await Promise.all([loadDb('energy_dim.duckdb', 'dim'), loadDb('energy_today.duckdb', 'today')]);
    return { db: _db, conn };
  }

  async function attachAgg() {
    await loadDb('energy_daily_agg.duckdb', 'agg');
  }

  let _manifest = null;
  const _attachedPeriods = new Set();

  // Attach one half-year period. A period the manifest advertises but whose .duckdb
  // didn't deploy is skipped instead of breaking the whole query: recent days still
  // come from `today` and the other periods still load.
  async function attachPeriod(p) {
    try {
      await loadDb(`energy_data_${p}.duckdb`, `p${p}`);
      _attachedPeriods.add(p);
    } catch (e) {
      console.warn(`[OPFS] skipping period ${p}: ${e}`);
    }
  }

  function periodsForRange(from, to) {
    const periods = [];
    let d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const y = d.getUTCFullYear();
      const h = d.getUTCMonth() < 6 ? 1 : 2;
      const tag = `${y}_h${h}`;
      if (!periods.includes(tag)) periods.push(tag);
      d = new Date(h === 1 ? `${y}-07-01` : `${y + 1}-01-01`);
    }
    return periods;
  }

  // Attach the half-year periods of a date range that exist and aren't attached yet.
  // True if there were any: the caller's views must then be rebuilt.
  async function ensureHistory(from, to, msg) {
    _manifest ??= await (await fetch(`${_baseUrl}/data/daily_manifest.json`)).json();
    const needed = periodsForRange(from, to)
      .filter(p => _manifest.periods.includes(p) && !_attachedPeriods.has(p));
    if (!needed.length) return false;
    onStatus(msg);
    await Promise.all(needed.map(attachPeriod));
    return true;
  }

  return {
    init, attachAgg, ensureHistory,
    // Aliases of the attached databases that hold the 5-minute history.
    history: () => [..._attachedPeriods].map(p => `p${p}`),
    // SQL date: rows from this day on are read from `today`, older ones from history / agg.
    recentCut: 'CURRENT_DATE - INTERVAL 5 DAY',
    query: sql => conn.query(sql),
  };
}
