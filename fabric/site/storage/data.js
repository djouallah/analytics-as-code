// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with the OneLake data attached
// =============================================================================
// The Fabric version: the counterpart of ../../../dashboard/storage/data.js (GitHub Pages),
// with the same members (init, attachAgg, ensureHistory, query) over the same history.js, so
// index.html and the semantic model are the same files on both hosts. The data files are the
// same too; what differs is where they are: in a lakehouse, behind a Fabric sign-in (auth.js).
//   1. resolve the latest import from the OneLake `latest.json` pointer
//      ({"ts": "<ts>", "periods": ["2018_h1", ...]}),
//   2. download the files of that import whole (parallel Range fetches, cached in OPFS by
//      name — names are immutable) and ATTACH them:
//        dim_<ts>.duckdb          as `dim`          dim_calendar, dim_duid
//        today_<ts>.duckdb        as `today`        scada_today, price_today, interconnector_today (last 14 days, 5-min)
//        agg_<ts>.duckdb          as `agg`          daily and hour-of-day rollups — attachAgg(), after first paint
//        <YYYY>_h<N>_<ts>.duckdb  as `p<YYYY>_h<N>` scada, price, interconnector, 5-min — ensureHistory(),
//                                                   only the half-years a range needs
//      The history is downloaded, not read in place over HTTP: OneLake answers each Range read
//      in ~700 ms whatever its size, so whole files in parallel beat a block at a time.
// The files are built and uploaded by import_onelake.yml (scripts/cache_catalog.py,
// scripts/deploy_onelake.py). Every read goes to the OneLake data/ folder with a read-only SAS
// from the getDataSas function; auth.dataAccess() signs a new one when it is about to expire.
//
// Progress is reported through the injected `onStatus` callback, and what is fetched,
// attached and run is timed in perflog.js, for the Logs tab. The sign-in gate (auth.js)
// is this host's own: the page has none.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
import { periodsForRange, attachCached } from "./history.js";
import { createAuth } from "./auth.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const CHUNK = 2 * 1024 * 1024;           // whole-file download: Range size per request ...
const PARALLEL = 6;                      // ... and how many in flight (a 14 MB file needs small chunks to use them all)

// The data is read from OneLake: open the connection while the page and the WASM bundle load.
document.head.append(Object.assign(document.createElement('link'),
  { rel: 'preconnect', href: 'https://onelake.dfs.fabric.microsoft.com', crossOrigin: '' }));

export function createDataSource({ onStatus = () => {} } = {}) {
  const auth = createAuth();
  let db, conn;   // set by init()

  const signedUrl = async (name) => { const { baseUrl, sas } = await auth.dataAccess(); return `${baseUrl}/${name}?${sas}`; };

  // Resolve the moving `latest.json` pointer: the import's timestamp and its half-years.
  async function resolveLatest() {
    // no-store: latest.json is a moving pointer; a cached copy would name a stale import and
    // the dashboard would never pick up a fresh one.
    const fetchLatest = async () => {
      const t = performance.now();
      const r = await fetch(await signedUrl('latest.json'), { cache: 'no-store' });
      perf.log('fetch', 'GET latest.json', { ms: performance.now() - t, status: r.status });
      return r;
    };
    let resp = await fetchLatest();
    if (resp.status === 403) { await auth.refresh(); resp = await fetchLatest(); }   // expired SAS
    if (!resp.ok) throw new Error(`Failed to read data/latest.json: HTTP ${resp.status}`);
    const latest = await resp.json();
    if (!latest.ts) throw new Error('data/latest.json names no import');
    console.log(`[data] latest import: ${latest.ts}, ${latest.periods.length} half-years`);
    return latest;
  }
  let _latest = null;   // promise of latest.json
  const latest = () => _latest ??= resolveLatest();

  // --- Whole-file download (parallel Ranges) + OPFS cache keyed by the immutable name ---
  async function download(name) {
    const head = await fetch(await signedUrl(name), { method: 'HEAD', cache: 'no-store' });
    if (!head.ok) throw new Error(`HEAD ${name}: HTTP ${head.status}`);
    const size = Number(head.headers.get('content-length'));
    if (!size) throw new Error(`HEAD ${name}: no Content-Length`);
    const out = new Uint8Array(size);
    const ranges = [];
    for (let o = 0; o < size; o += CHUNK) ranges.push([o, Math.min(o + CHUNK, size) - 1]);
    let next = 0, done = 0;
    const mb = (size / 1048576).toFixed(0);
    const pull = async () => {
      while (next < ranges.length) {
        const [a, b] = ranges[next++];
        const r = await fetch(await signedUrl(name), { headers: { Range: `bytes=${a}-${b}` }, cache: 'no-store' });
        if (r.status !== 206) throw new Error(`GET ${name} bytes=${a}-${b}: HTTP ${r.status}`);
        out.set(new Uint8Array(await r.arrayBuffer()), a);
        onStatus(`Downloading data (${++done}/${ranges.length} of ${mb} MB)...`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ranges.length) }, pull));
    return out;
  }

  // OPFS is a best-effort cache: unavailable (private mode, old Safari) just means a re-download.
  async function opfsRead(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) { return null; }
  }
  async function opfsHas(name) {
    try { await (await navigator.storage.getDirectory()).getFileHandle(name); return true; }
    catch (e) { return false; }
  }
  // True if the file is in OPFS now.
  async function opfsWrite(name, bytes) {
    try {
      const root = await navigator.storage.getDirectory();
      const w = await (await root.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      // One import per browser: drop the cached .duckdb files of every other import.
      const stamp = `_${(await latest()).ts}.duckdb`;
      for await (const [n] of root.entries()) {
        if (n.endsWith('.duckdb') && !n.endsWith(stamp)) await root.removeEntry(n).catch(() => {});
      }
      return true;
    } catch (e) { console.warn('[data] OPFS cache unavailable:', e?.message || e); return false; }
  }

  // One of the import's small files (dim / today / agg), whole. Needs no DuckDB: init() starts
  // the first two while the WASM bundle is still loading.
  async function loadLocal(prefix) {
    const name = `${prefix}_${(await latest()).ts}.duckdb`;
    let bytes = await opfsRead(name);
    const source = bytes ? 'OPFS' : 'download';
    if (!bytes) {
      bytes = await perf.time('fetch', `GET ${name} (whole, ${PARALLEL} parallel)`, () => download(name));
      // Awaited: registerFileBuffer transfers (detaches) the buffer to the worker afterwards.
      await opfsWrite(name, bytes);
    }
    perf.log('info', `${name}: ${(bytes.length / 1048576).toFixed(1)} MB from ${source}`);
    return { name, bytes };
  }

  async function attachLocal({ name, bytes }, alias) {
    await db.registerFileBuffer(name, bytes);
    await perf.time('attach', `ATTACH ${name} (local)`, () => conn.query(`ATTACH '${name}' AS ${alias} (READ_ONLY);`));
  }

  const _attachedPeriods = new Set();

  // The rollups only feed ranges over 30 days: attached after the first paint. One attach,
  // whoever asks; a failed one can be asked for again.
  let _agg = null;
  function attachAgg() {
    return _agg ??= (async () => attachLocal(await loadLocal('agg'), 'agg'))().catch(e => { _agg = null; throw e; });
  }

  // --- The 5-minute history: the half-year files a range needs, downloaded into OPFS ---
  // Periods that failed to attach, and when: left alone for a minute, so a file that is
  // missing is not fetched again by every render.
  const _failedPeriods = new Map();
  const RETRY_MS = 60000;

  // Attach one half-year period; true if it is attached now. One that fails is skipped
  // instead of breaking the whole query: recent days still come from `today`.
  async function attachPeriod(p) {
    const name = `${p}_${(await latest()).ts}.duckdb`;
    try {
      let bytes = null;
      if (await opfsHas(name)) perf.log('info', `${name}: from OPFS`);
      else {
        bytes = await perf.time('fetch', `GET ${name} (whole, ${PARALLEL} parallel)`, () => download(name));
        perf.log('info', `${name}: ${(bytes.length / 1048576).toFixed(1)} MB downloaded`);
        if (await opfsWrite(name, bytes)) bytes = null;
      }
      const t = performance.now();
      const mode = await attachCached(db, conn, name, `p${p}`, bytes);
      perf.log('attach', `ATTACH ${name} AS p${p}`, { ms: performance.now() - t, status: mode });
      _attachedPeriods.add(p);
      _failedPeriods.delete(p);
      return true;
    } catch (e) {
      console.warn(`[data] skipping period ${p}: ${e}`);
      perf.log('error', `ATTACH ${name}`, { status: String(e?.message || e) });
      _failedPeriods.set(p, Date.now());
      return false;
    }
  }

  // Attach the half-year periods of a date range that exist and aren't attached yet.
  // True if any was attached. The caller (the compiler) asks only for a range that reaches
  // back past the days `today` covers.
  async function ensureHistory(from, to, msg) {
    const { periods } = await latest();
    const needed = periodsForRange(from, to).filter(p => periods.includes(p)
      && !_attachedPeriods.has(p) && !(Date.now() - _failedPeriods.get(p) < RETRY_MS));
    if (!needed.length) return false;
    onStatus(msg);
    return (await Promise.all(needed.map(attachPeriod))).includes(true);
  }

  // Signed in, DuckDB-WASM up, `dim` + `today` attached: enough for the default "Last 3 days" view.
  async function init() {
    await auth.signIn();
    onStatus("Loading DuckDB WASM...");
    // latest.json + dim + today don't need DuckDB: fetch them while the WASM bundle boots.
    // No fallback: if OneLake is unreachable the dashboard must say so (the await below rethrows).
    const local = Promise.all([loadLocal('dim'), loadLocal('today')]);
    local.catch(() => {});

    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    conn = await db.connect();

    onStatus('Downloading data...');
    const [dim, today] = await local;
    onStatus('Opening database...');
    await attachLocal(dim, 'dim');
    await attachLocal(today, 'today');
    // Brisbane time, for CURRENT_DATE alone (the NEM's day): the files carry date and time.
    await conn.query("SET TimeZone = 'Australia/Brisbane';");
    await conn.query("SET preserve_insertion_order = false;");
    return { db };
  }

  return { init, attachAgg, ensureHistory, query: sql => perf.query(sql, () => conn.query(sql)) };
}
