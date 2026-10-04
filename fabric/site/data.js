// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with the OneLake data attached
// =============================================================================
// The Fabric version: the counterpart of ../../dashboard/data.js (GitHub Pages), with the same
// members (init, attachAgg, ensureHistory, has, query) over the same views.js, so index.html
// and model.js are the same files on both hosts. What differs is where the files are and how
// they are read. Here they are in a lakehouse, behind a Fabric sign-in (auth.js), and OneLake
// has no file-size limit, so the 5-minute history is one file, read in place:
//   1. resolve the latest import from the OneLake `latest.txt` pointer (data_<ts>.duckdb),
//   2. download the small files of that import whole (parallel Range fetches, cached in OPFS by
//      name — names are immutable) and ATTACH them from memory:
//        dim_<ts>.duckdb   as `dim`    dim_calendar, dim_duid
//        today_<ts>.duckdb as `today`  scada_today, price_today, interconnector_today (last 14 days, 5-min)
//        agg_<ts>.duckdb   as `agg`    daily and hour-of-day rollups — attachAgg(), after first paint
//   3. on demand only (ensureHistory), ATTACH the full data_<ts>.duckdb in place over HTTP as
//      `history` — scada, price, interconnector, all 5-min history, read by Range requests
//      (~700 ms a seek). The file is sorted by date, so a date range is a few of them.
// The files are built and uploaded by import_onelake.yml (scripts/cache_catalog.py with
// MAX_FILE_MB=unlimited, scripts/deploy_onelake.py). Every read goes to the OneLake data/
// folder with a read-only SAS from the getDataSas function.
//
// SAS handling: the full file is registered by a URL without the SAS; a shim in the DuckDB worker
// appends the current SAS to every request; the page renews it ~10 min before expiry and pushes
// it to the worker, so the hourly rotation never touches an attached database. A read that still
// fails (403 after sleep/wake, or the "Corrupt database file" it leaves behind in duckdb-wasm's
// read-ahead cache) is recovered by one DETACH/ATTACH under a new file name, then retried
// (query).
//
// Progress is reported through the injected `onStatus` callback, and what is fetched,
// attached and run is timed in perflog.js, for the Logs tab. The sign-in gate (auth.js)
// is this host's own: the page has none.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
import { createViews, RECENT_CUT } from "./views.js";
import { createAuth } from "./auth.js";
import { perf, HTTP_TRACE_SHIM } from "./perflog.js";

const SAS_CHANNEL = 'duckdb-sas';
const RENEW_AHEAD_MS = 10 * 60 * 1000;   // renew this long before the SAS expires (covers background-tab timer throttling)
const CHUNK = 2 * 1024 * 1024;           // whole-file download: Range size per request ...
const PARALLEL = 6;                      // ... and how many in flight (a 14 MB file needs small chunks to use them all)

// The data is read from OneLake: open the connection while the page and the WASM bundle load.
document.head.append(Object.assign(document.createElement('link'),
  { rel: 'preconnect', href: 'https://onelake.dfs.fabric.microsoft.com', crossOrigin: '' }));

// Prepended to the DuckDB worker (before the trace shim and importScripts): every request under
// DIR gets the current SAS appended. The first SAS is inlined so ATTACH cannot race a message;
// renewals arrive on the BroadcastChannel.
const sasShim = (dir, sas) => `(() => {
  const DIR = ${JSON.stringify(dir)};
  let sas = ${JSON.stringify(sas)};
  try { new BroadcastChannel(${JSON.stringify(SAS_CHANNEL)}).onmessage = ({ data }) => { sas = data; }; } catch (e) {}
  const sign = (u) => (typeof u === 'string' && u.startsWith(DIR)) ? u + (u.includes('?') ? '&' : '?') + sas : u;
  const X = self.XMLHttpRequest;
  if (X) self.XMLHttpRequest = class extends X { open(m, u, ...r) { return super.open(m, sign(u), ...r); } };
  const F = self.fetch;
  if (F) self.fetch = (input, init) => F(typeof input === 'string' ? sign(input) : input, init);
})();`;

export function createDataSource({ onStatus = () => {} } = {}) {
  const auth = createAuth();
  const views = createViews(sql => conn.query(sql));
  let db, conn, dir, fullFile;   // set by init()

  const signedUrl = async (name) => { const { sas } = await auth.dataAccess(); return `${dir}/${name}?${sas}`; };

  // Resolve the moving `latest.txt` pointer to a concrete db filename.
  async function resolveLatestDuckDB() {
    // no-store: latest.txt is a moving pointer; a cached copy would resolve to a stale db
    // filename and the dashboard would never pick up a fresh import.
    const fetchLatest = async () => {
      const t = performance.now();
      const r = await fetch(await signedUrl('latest.txt'), { cache: 'no-store' });
      perf.log('fetch', 'GET latest.txt', { ms: performance.now() - t, status: r.status });
      return r;
    };
    let resp = await fetchLatest();
    if (resp.status === 403) { await renew(); resp = await fetchLatest(); }   // expired SAS
    if (!resp.ok) throw new Error(`Failed to read data/latest.txt: HTTP ${resp.status}`);
    const fname = (await resp.text()).trim();
    if (!fname) throw new Error('data/latest.txt is empty');
    console.log(`[data] latest db: ${fname}`);
    return fname;
  }

  // --- SAS renewal: sign a new one and push it to the worker ---
  const sasChannel = new BroadcastChannel(SAS_CHANNEL);
  let _renewTimer = null;

  function scheduleRenew(expiresOn) {
    clearTimeout(_renewTimer);
    _renewTimer = setTimeout(() => renew().catch(e => console.error('[data] SAS renewal failed', e)),
                             Math.max(Date.parse(expiresOn) - Date.now() - RENEW_AHEAD_MS, 0));
  }

  async function renew() {
    await auth.refresh();
    const { sas, expiresOn } = await auth.dataAccess();
    sasChannel.postMessage(sas);
    scheduleRenew(expiresOn);
  }

  // --- Small files: whole-file download (parallel Ranges) + OPFS cache keyed by the immutable name ---
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
  async function opfsWrite(name, bytes) {
    try {
      const root = await navigator.storage.getDirectory();
      const w = await (await root.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      // One import per browser: drop the cached .duckdb files of every other import.
      const stamp = name.slice(name.indexOf('_'));   // "_<ts>.duckdb"
      for await (const [n] of root.entries()) {
        if (n.endsWith('.duckdb') && !n.endsWith(stamp)) await root.removeEntry(n).catch(() => {});
      }
    } catch (e) { console.warn('[data] OPFS cache unavailable:', e?.message || e); }
  }

  // One of the import's small files (dim / today / agg), whole. Needs no DuckDB: init() starts
  // the first two while the WASM bundle is still loading.
  let _latest = null;   // promise of the data_<ts>.duckdb name
  async function loadLocal(prefix) {
    fullFile = await (_latest ??= resolveLatestDuckDB());
    const name = fullFile.replace(/^data_/, `${prefix}_`);
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

  // The base views (views.js), over what is attached by now.
  let _aggLoaded = false;
  const refreshViews = () => views.refresh({ history: _full ? ['history'] : [], agg: _aggLoaded });

  // The rollups only feed ranges over 30 days: attached after the first paint. One attach,
  // whoever asks; a failed one can be asked for again.
  let _agg = null;
  function attachAgg() {
    return _agg ??= (async () => {
      await attachLocal(await loadLocal('agg'), 'agg');
      _aggLoaded = true;
      await refreshViews();
    })().catch(e => { _agg = null; throw e; });
  }

  // --- Full file: remote ATTACH, only when a query needs 5-min rows older than RECENT_CUT ---
  let _full = null;          // { name, n }
  let _attachingFull = null;
  let _recovering = null;

  async function attachRemote(n) {
    const name = `r${n}_${fullFile}`;
    // A distinct URL per registration (duckdb-wasm also indexes files by URL); the shim adds the SAS.
    const url = n ? `${dir}/${fullFile}?v=${n}` : `${dir}/${fullFile}`;
    await db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
    await perf.time('attach', `ATTACH ${fullFile} (remote, Range reads)`, () => conn.query(`ATTACH '${name}' AS history (READ_ONLY);`));
    const old = _full?.name;
    _full = { name, n };
    if (old) await db.dropFile(old).catch(() => {});
  }

  // Attach the 5-minute history if a date range needs it and it isn't attached yet. True if
  // it was attached: the views were rebuilt, so results the caller cached are stale. A range
  // that starts on or after the cut is read from `today` alone (the default "Last 3 days"
  // view), and the history is one file, so `to` decides nothing here.
  async function ensureHistory(from, to, msg) {
    if (_full) return false;
    const cut = (await conn.query(`SELECT CAST(CAST(${RECENT_CUT} AS DATE) AS VARCHAR) AS d`)).toArray()[0].d;
    if (from >= cut) return false;
    onStatus(msg);
    await (_attachingFull ??= attachRemote(0).finally(() => { _attachingFull = null; }));
    await refreshViews();
    return true;
  }

  // Fallback after a failed read: fresh SAS, then re-attach the full file under a NEW file name.
  // The new name gives duckdb-wasm a new file id, which orphans the read-ahead window the failed
  // read poisoned (that window is what yields "Corrupt database file ... stored checksum 0" on
  // the next reads). Concurrent callers share one recovery. The views name `history`, the
  // alias, so they follow the re-attach as they are.
  function recover() {
    _recovering ??= (async () => {
      await renew();
      if (!_full) return;
      const { n } = _full;
      await perf.time('attach', 'DETACH history (recover after failed read)', () => conn.query('DETACH history;'));
      await attachRemote(n + 1);
    })().finally(() => { _recovering = null; });
    return _recovering;
  }

  // `history` is read over HTTP. A failed read (HTTP 403 = SAS no longer valid) or the
  // "Corrupt database file ... stored checksum 0" it leaves in duckdb-wasm's read-ahead cache
  // for the queries queued behind it is recovered once and retried. The first failure is
  // logged here; the query's time, the retry included, by perf.query.
  const query = sql => perf.query(sql, async () => {
    try { return await conn.query(sql); }
    catch (e) {
      if (!/\b403\b|HTTP|Corrupt database file/i.test(String(e?.message))) throw e;
      perf.log('error', sql.replace(/\s+/g, ' ').trim(), { status: String(e?.message || e) });
      await recover();
      return conn.query(sql);
    }
  });

  // Signed in, DuckDB-WASM up, `dim` + `today` attached: enough for the default "Last 3 days" view.
  async function init() {
    await auth.signIn();
    onStatus("Loading DuckDB WASM...");
    // The worker shim needs the data dir + a SAS before the bundle loads.
    const access = await auth.dataAccess();
    dir = access.baseUrl;
    scheduleRenew(access.expiresOn);
    // latest.txt + dim + today don't need DuckDB: fetch them while the WASM bundle boots.
    // No fallback: if OneLake is unreachable the dashboard must say so (the await below rethrows).
    const local = Promise.all([loadLocal('dim'), loadLocal('today')]);
    local.catch(() => {});

    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      // sasShim signs every data request; HTTP_TRACE_SHIM (on top) times them for the Logs tab.
      new Blob([sasShim(dir, access.sas), '\n', HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    // duckdb-wasm defaults forceFullHTTPReads to TRUE: an HTTP file is then GET'd whole (1.5 GB)
    // instead of Range-read. Turn it off so the remote ATTACH only reads the blocks it touches.
    await db.open({ filesystem: { forceFullHTTPReads: false } });

    conn = await db.connect();
    // OneLake answers `HEAD` + Range with 200 (not 206). With reliable_head_requests on (default),
    // the Range probe never learns the file size and falls back to a full GET; off, it takes the
    // size from the HEAD Content-Length and uses Range reads.
    await conn.query("SET reliable_head_requests = false;");

    onStatus('Downloading data...');
    const [dim, today] = await local;
    onStatus('Opening database...');
    await attachLocal(dim, 'dim');
    await attachLocal(today, 'today');
    // Brisbane time, for CURRENT_DATE alone (the NEM's day): the files carry date and time.
    await conn.query("SET TimeZone = 'Australia/Brisbane';");
    await conn.query("SET preserve_insertion_order = false;");
    await refreshViews();
    return { db };
  }

  return { init, attachAgg, ensureHistory, has: views.has, query };
}
