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
// model.js and index.html know none of this: model.js wraps the members createDataSource
// returns and reads the views built here (refreshViews), never an attached table. A host
// that stores the files differently (the Fabric app reads one history file over HTTP) swaps
// this file for its own with the same members and the same views:
//   v_scada           DUID, date, time, mw                                        5-minute
//   v_price           REGIONID, date, time, price, demand, net_interchange        5-minute
//   v_scada_daily     DUID, date, mwh
//   v_price_daily     REGIONID, date, price, demand, net_interchange, demand_mwh
//   v_interconnector  interconnector, date, time, mw, export_limit, import_limit  5-minute
//   v_scada_today     DUID, date, time, mw             the newest days, for "latest interval"
//   v_price_today     REGIONID, date, time, price, demand, net_interchange
//   v_duid            dim_duid, under the names the    has(view, column) says whether a
//                     export gives its columns         deployed file carries a newer column
//   v_calendar        dim_calendar: date, year, month
//   v_scada_hourly, v_price_hourly, v_month_days       agg's hour-of-day x month tables;
//                                                      absent (has(view) false) until agg is
//                                                      attached and deployed with them
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
    await conn.query("SET TimeZone = 'Australia/Brisbane';");
    await conn.query("SET preserve_insertion_order = false;");
    await refreshViews();
    return { db: _db };
  }

  let _aggLoaded = false;
  async function attachAgg() {
    await loadDb('energy_daily_agg.duckdb', 'agg');
    _aggLoaded = true;
    await refreshViews();
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
      await loadDb(`energy_data_${p}.duckdb`, `p${p}`);
      _attachedPeriods.add(p);
      _failedPeriods.delete(p);
      return true;
    } catch (e) {
      console.warn(`[OPFS] skipping period ${p}: ${e}`);
      _failedPeriods.set(p, Date.now());
      return false;
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

  // SQL date: rows from this day on are read from `today`, older ones from history / agg.
  // CURRENT_DATE is the NEM's day: init() sets the session to Brisbane time for it.
  const RECENT_CUT = 'CURRENT_DATE - INTERVAL 5 DAY';

  // Attach the half-year periods of a date range that exist and aren't attached yet.
  // True if any was attached: the views were rebuilt, so results the caller cached are stale.
  async function ensureHistory(from, to, msg) {
    // A range that starts on or after the cut is read from `today` alone (refreshViews): no
    // half-year file has a row it would show, so none is downloaded. That is the default
    // "Last 3 days" view.
    const cut = (await conn.query(`SELECT CAST(CAST(${RECENT_CUT} AS DATE) AS VARCHAR) AS d`)).toArray()[0].d;
    if (from >= cut) return false;
    if (!_manifest) {
      // no-store: a manifest from the HTTP cache can predate a half-year rollover.
      const resp = await fetch(`${_baseUrl}/data/daily_manifest.json`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`Failed to fetch daily_manifest.json: HTTP ${resp.status}`);
      _manifest = await resp.json();
    }
    const needed = periodsForRange(from, to).filter(p => _manifest.periods.includes(p)
      && !_attachedPeriods.has(p) && !(Date.now() - _failedPeriods.get(p) < RETRY_MS));
    if (!needed.length) return false;
    onStatus(msg);
    const attached = await Promise.all(needed.map(attachPeriod));
    if (!attached.includes(true)) return false;
    await refreshViews();
    return true;
  }

  // Aliases of the attached databases that hold the 5-minute history.
  const history = () => [..._attachedPeriods].map(p => `p${p}`);

  // Columns of each attached table (`<db>.<table>`) and of each view (plain name), read at
  // both ends of refreshViews. Files deployed before 2026-10-02 have no demand/net_interchange
  // (and agg no hourly tables); a column a file lacks reads as NULL, which the charts show as
  // "no data", never as a number.
  let _columns = new Map();
  async function loadColumns() {
    const r = await conn.query(`SELECT CASE WHEN table_catalog = current_database() THEN table_name
        ELSE table_catalog || '.' || table_name END AS t, column_name AS c
      FROM information_schema.columns`);
    _columns = new Map();
    for (const { t, c } of r.toArray()) {
      if (!_columns.has(t)) _columns.set(t, new Set());
      _columns.get(t).add(c);
    }
  }
  const hasTable = t => _columns.has(t);
  const colOrNull = (t, c, expr = c, alias = c) => _columns.get(t)?.has(c) ? `${expr} AS ${alias}` : `NULL::REAL AS ${alias}`;

  // The views every query reads. The days from RECENT_CUT on come from `today` (refreshed
  // intraday), everything older from the attached history databases (5-min) or agg (daily).
  // Until agg is attached, the daily views only cover `today`.
  async function refreshViews() {
    await loadColumns();
    const OLD = `date < ${RECENT_CUT}`, RECENT = `date >= ${RECENT_CUT}`;
    const raw = (cols, table, extra = []) => [
      ...history().map(db => [db, table]), ['today', `${table}_today`],
    ].map(([db, t]) => `SELECT ${[cols, ...extra.map(c => colOrNull(`${db}.${t}`, c))].join(', ')}
        FROM ${db}.${t} WHERE ${db === 'today' ? RECENT : OLD}`).join(' UNION ALL ');
    const daily = (aggSql, todaySql) => _aggLoaded
      ? `${aggSql} WHERE ${OLD} UNION ALL ${todaySql} WHERE ${RECENT} GROUP BY ALL`
      : `${todaySql} GROUP BY ALL`;
    const DEMAND_COLS = ['demand', 'net_interchange'];

    await conn.query(`CREATE OR REPLACE VIEW v_scada AS ${raw('DUID, date, time, mw', 'scada')}`);
    await conn.query(`CREATE OR REPLACE VIEW v_price AS ${raw('REGIONID, date, time, price', 'price', DEMAND_COLS)}`);
    await conn.query(`CREATE OR REPLACE VIEW v_scada_daily AS ${daily(
      'SELECT DUID, date, mwh FROM agg.scada_daily',
      'SELECT DUID, date, CAST(SUM(mw) / 12.0 AS REAL) AS mwh FROM today.scada_today')}`);
    // Daily demand/net_interchange are average MW; demand_mwh is the day's energy (a whole
    // day in agg, the intervals so far today, like v_scada_daily.mwh). A day from `today`
    // with any interval missing demand (fct_regionsum_today still filling) stays NULL.
    const complete = (c, agg) => `CASE WHEN COUNT(${c}) = COUNT(*) THEN ${agg} END`;
    await conn.query(`CREATE OR REPLACE VIEW v_price_daily AS ${daily(
      `SELECT REGIONID, date, price, ${DEMAND_COLS.map(c => colOrNull('agg.price_daily', c)).join(', ')},
        ${colOrNull('agg.price_daily', 'demand', 'demand * 24', 'demand_mwh')}
        FROM agg.price_daily`,
      `SELECT REGIONID, date, CAST(AVG(price) AS REAL) AS price,
        ${DEMAND_COLS.map(c => colOrNull('today.price_today', c, `CAST(${complete(c, `AVG(${c})`)} AS REAL)`)).join(', ')},
        ${colOrNull('today.price_today', 'demand', complete('demand', 'SUM(demand) / 12.0'), 'demand_mwh')}
        FROM today.price_today`)}`);
    // Link flows: the half-year files carry them back to 2018 (files built before
    // 2026-10-03 have no such table), `today` the last 14 days. `today` supplies whatever
    // is newer than the attached files hold, so a file without the table, or a daily
    // import that is behind, leaves no hole in the last 14 days.
    const FLOW_COLS = 'interconnector, date, time, mw, export_limit, import_limit';
    const flowPeriods = history().filter(db => hasTable(`${db}.interconnector`))
      .map(db => `SELECT ${FLOW_COLS} FROM ${db}.interconnector WHERE ${OLD}`).join(' UNION ALL ');
    const flowToday = hasTable('today.interconnector_today')
      ? `SELECT ${FLOW_COLS} FROM today.interconnector_today`
      : `SELECT NULL::VARCHAR AS interconnector, NULL::DATE AS date, NULL::SMALLINT AS time,
          NULL::REAL AS mw, NULL::REAL AS export_limit, NULL::REAL AS import_limit WHERE false`;
    await conn.query(`CREATE OR REPLACE VIEW v_interconnector AS ${flowPeriods
      ? `${flowPeriods} UNION ALL SELECT * FROM (${flowToday})
          WHERE date > (SELECT COALESCE(MAX(date), DATE '1900-01-01') FROM (${flowPeriods}))`
      : flowToday}`);
    // The tables the page reads as they are. A table a deployed file lacks gets no view.
    for (const [view, table] of [
      ['v_duid', 'dim.dim_duid'], ['v_calendar', 'dim.dim_calendar'],
      ['v_scada_today', 'today.scada_today'], ['v_price_today', 'today.price_today'],
      ['v_scada_hourly', 'agg.scada_hourly'], ['v_price_hourly', 'agg.price_hourly'],
      ['v_month_days', 'agg.month_days'],
    ]) if (hasTable(table)) await conn.query(`CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${table}`);
    await loadColumns();
  }

  return {
    init, attachAgg, ensureHistory,
    // Whether a view exists and, given a column, whether it has it.
    has: (view, column) => column ? !!_columns.get(view)?.has(column) : _columns.has(view),
    query: sql => conn.query(sql),
  };
}
