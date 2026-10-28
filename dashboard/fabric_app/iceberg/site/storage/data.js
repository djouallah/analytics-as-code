// =============================================================================
// data.js — DataSource: the catalog's tables, read by DuckDB-WASM from a local store
// =============================================================================
// The Iceberg backend of the Fabric app. Its inputs are the semantic model and a OneLake
// Iceberg catalog, nothing else: no import, no file written for it. The model names the
// tables (an Ossie dataset's `source`, or a TMSL table's Direct Lake partition: schema.table);
// the function says where each one is now and signs a read-only SAS (catalog.js).
// The page is the only thing that reads OneLake, and the SAS never leaves it: it plans each
// table itself (metadata.json, manifest list, manifests: prefetch.js's planTable) and
// downloads every file a table's view reads into the local store (OPFS, blockcache.js) before
// the view is created. DuckDB reads only that store, by names registered to
// https://store.local/... (duckdb-wasm's own file system): no httpfs, no SAS in any view, and
// its worker refuses every other request (blockcache.js). The engine is duckdb-wasm's npm
// release (DuckDB 1.5), from jsDelivr, the GitHub page's pin, with two of DuckDB's signed
// extensions: parquet, and icu for the session's time zone.
//
// A table is opened when a query first names its view, v_<table>, so the first paint pays only
// for the tables it reads. Opening it: its record (the snapshot's live data and delete files),
// planned by the page at load, or kept from an earlier visit in this browser (snapshots.js,
// keyed by the metadata location the function gave: a commit always writes a new one); then
// the files the store lacks downloaded, six at a time; then its view, on each engine. A table
// whose files are small (SMALL_BYTES, from its metadata.json) is copied into the engine's memory
// and its view reads that; a larger one is read in place, read_parquet over its files. A
// table's position deletes are applied by its view. A table the page cannot plan, or that a
// view cannot read (equality deletes, a deletion vector), fails: there is no other way in.
// After the first paint the rest are opened in the background, small ones first, behind
// whatever the page asks.
// Each view is at the snapshot the catalog named (catalog.js keeps that answer up to ~55
// minutes, so a reload within it reads the same snapshots).
// DuckDB-WASM runs single-threaded here, so the page runs a pool of engines (ENGINES, each its
// own worker and memory, 2 by default (3 measured no faster, 2026-10-28); `?engines=N` in the
// URL, 1 to 4, to compare), fed by one queue: a free engine takes the next query, so a
// render's queries run side by side and a long one holds up only its own engine. A table is planned
// and its files downloaded once, whichever engine opens it first; each engine then has its own
// view (and its own copy of a small table). All the workers share the store.
//
// The members are the ones the page calls on the other hosts:
//   init            sign in, locate the tables, size them; nothing opened yet
//   attachAgg       starts opening the rest in the background; nothing for the page to redraw
//   ensureHistory   nothing to attach: every view reads its table whole
//   query, views, has, needs
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
// The Arrow that duckdb-wasm's own module imports (the same URL: the same module), for the
// saved results.
import { tableToIPC, tableFromIPC } from "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm";
import { Skipped } from "./queue.js";
import { createAuth } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { createSnapshots } from "./snapshots.js";
import { planTable, prefetchFiles, prioritize } from "./prefetch.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const MODEL = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);
const SMALL_BYTES = 32 * 1024 * 1024;   // a table up to this much Parquet is copied into memory
// The extensions DuckDB installs, from DuckDB's repository: Parquet, and icu for the session's
// time zone. No httpfs: DuckDB reads only the local store.
const EXTENSIONS = ['parquet', 'icu'];
// The local store DuckDB reads from, and its worker's only way out (blockcache.js).
const BLOCKCACHE = new URL('./blockcache.js' + new URL(import.meta.url).search, import.meta.url).href;
const ENGINES = (() => {
  try { const n = Number(new URLSearchParams(location.search).get('engines')); if (n >= 1 && n <= 4) return Math.floor(n); } catch (e) {}
  return 2;
})();
const STORE_WAIT = 30000;   // how long the page waits for the store's writer to answer

// The model's tables: name -> { source: schema.table, columns }. Ossie: a dataset's `source`
// and its fields' columns. TMSL (model.bim): a table's Direct Lake partition and its columns.
function modelTables(model) {
  const out = new Map();
  const column = f => f.expression?.dialects?.[0]?.expression ?? f.name;
  for (const d of model.datasets ?? [])
    if (d.source) out.set(d.name, { source: d.source, columns: new Set((d.fields ?? []).map(column)) });
  for (const t of (model.model ?? model).tables ?? []) {
    const s = t.partitions?.[0]?.source;
    if (s?.entityName) out.set(t.name, { source: `${s.schemaName ?? 'dbo'}.${s.entityName}`,
      columns: new Set((t.columns ?? []).map(c => c.sourceColumn ?? c.name)) });
  }
  return out;
}

const ident = s => `"${String(s).replace(/"/g, '""')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
// A OneLake file, abfss://<ws>@onelake.dfs.fabric.microsoft.com/<lh>/..., as
//   https    the URL the page downloads it with (the SAS: the page's alone);
//   storePath its key in the store (blockcache.js), the URL without the SAS;
//   localName the name DuckDB reads it by, registered to localUrl, which the store answers.
const ABFSS = /^abfss:\/\/([^@/]+)@([^/]+)\//;
const https = (abfss, sas) => `${abfss.replace(ABFSS, 'https://$2/$1/')}?${sas}`;
const storePath = abfss => abfss.replace(ABFSS, 'https://$2/$1/');
const localName = abfss => abfss.replace(ABFSS, 'store/$1/');
const localUrl = abfss => abfss.replace(ABFSS, 'https://store.local/$1/');

// DuckDB downloads its extensions one at a time. On a browser's first load the page fetches
// them all at once, as soon as the engine says its version, into the browser's cache, where
// DuckDB's own request finds them. After that the store answers DuckDB (blockcache.js), and the
// page fetches nothing (the version it loaded is remembered).
const EXT_KEY = 'duckdb_extensions';
const extensionUrl = (version, e) => `https://extensions.duckdb.org/${version}/wasm_eh/${e}.duckdb_extension.wasm`;
function warmExtensions(version) {
  let known = null; try { known = localStorage.getItem(EXT_KEY); } catch (e) {}
  if (known === version) return;
  const t0 = performance.now();
  Promise.all(EXTENSIONS.map(e => fetch(extensionUrl(version, e)).then(r => r.arrayBuffer())))
    .then(f => perf.log('fetch', `prefetch extensions: ${f.length} files`, { ms: performance.now() - t0 }))
    .catch(e => perf.log('info', `prefetch extensions: ${e?.message || e}`));
}

// The page's main thread blocked 100 ms or more (a long task: rendering, parsing, a large
// result turned into rows): one line in the Logs tab, 20 s after the page started, with how
// many, their total and the longest (a line each was noise).
try {
  const blocks = [];
  new PerformanceObserver(list => { for (const t of list.getEntries()) if (t.duration >= 100) blocks.push(t); })
    .observe({ type: 'longtask', buffered: true });
  setTimeout(() => {
    if (!blocks.length) return;
    const longest = blocks.reduce((a, b) => b.duration > a.duration ? b : a);
    perf.log('info', `main thread: ${blocks.length} blocks of 100 ms or more in the first 20 s, ${(blocks.reduce((s, b) => s + b.duration, 0) / 1000).toFixed(1)} s in all, the longest ${longest.duration.toFixed(0)} ms from ${(longest.startTime / 1000).toFixed(2)} s`);
  }, Math.max(20000 - performance.now(), 0));
} catch (e) {}

// What happened before this module ran (its long tasks are not kept by the browser): the
// navigation, and every download of 200 ms or more until now, in the order they started.
try {
  const at = s => `${(s / 1000).toFixed(2)} s`;
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) perf.log('info', `page: HTML in at ${at(nav.responseEnd)}, DOM parsed at ${at(nav.domInteractive)}, data.js running at ${at(performance.now())}`);
  for (const r of performance.getEntriesByType('resource').filter(r => r.duration >= 200).sort((a, b) => a.startTime - b.startTime))
    perf.log('info', `loaded ${r.name.split('?')[0].split('/').slice(-2).join('/')} (${r.initiatorType}): ${at(r.startTime)} to ${at(r.responseEnd)}, ${(r.transferSize / 1024).toFixed(0)} KB${r.transferSize === 0 ? ' (cache)' : ''}`, { ms: r.duration });
} catch (e) {}

// onProgress({ label, done, total, detail }) while a long download runs, null when it ends.
// timeZone: the session's, which CURRENT_DATE follows; the page's to say (none: DuckDB's own).
export function createDataSource({ onStatus = () => {}, onProgress = () => {}, timeZone = null } = {}) {
  const catalog = createCatalog(() => auth.client());
  const snapshots = createSnapshots();
  // A kept answer from the function needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: catalog.fresh });
  let tables = new Map();
  // table name -> { location, bytes, planning, record, stored, ready, whenReady, isReady }.
  // `ready`: the table's record, its files all in the store: once for every engine.
  const located = new Map();

  // The engines: each its worker, connection, the tables opened on it (`opened`: name ->
  // promise of its opening) and the files registered on it; `busy` while it runs a job.
  // One queue for all of them, as queue.js's for one engine: `early` jobs first, `later` ones
  // when nothing else waits, and one whose `stale()` holds when its turn comes dropped unrun
  // (Skipped). A free engine takes the next job; a query is not given an engine when it is
  // sent (a query sent to an engine behind an 18 s scan waited 14 s there while the other
  // engine sat idle, 2026-10-28). Of the free engines, a query goes to the one with more of
  // its tables open. A job with an `engine` (an engine's own setup, its background openings)
  // runs on that one.
  let engines = [];
  const jobs = { early: [], normal: [], later: [] };
  function submit(fn, { engine = null, names = [], stale = null, early = false, later = false } = {}) {
    return new Promise((resolve, reject) => {
      jobs[early ? 'early' : later ? 'later' : 'normal'].push({ fn, engine, names, stale, resolve, reject });
      dispatch();
    });
  }
  function dispatch() {
    for (;;) {
      const free = engines.filter(e => e && !e.busy);
      if (!free.length) return;
      let job = null, e = null;
      for (const k of ['early', 'normal', 'later']) {
        const i = jobs[k].findIndex(j => !j.engine || free.includes(j.engine));
        if (i < 0) continue;
        [job] = jobs[k].splice(i, 1);
        break;
      }
      if (!job) return;
      if (job.stale?.()) { job.reject(new Skipped()); continue; }
      e = job.engine ?? free.reduce((a, b) => job.names.filter(n => b.opened.has(n)).length > job.names.filter(n => a.opened.has(n)).length ? b : a);
      e.busy = true;
      (async () => {
        try { job.resolve(await job.fn(e)); } catch (err) { job.reject(err); }
        finally { e.busy = false; dispatch(); }
      })();
    }
  }
  const q = (e, sql) => submit(() => e.conn.query(sql), { engine: e });
  const tag = e => ENGINES > 1 ? ` [engine ${e.i + 1}]` : '';

  // The SAS from the function: the page's downloads use it, and nothing else does. A page open
  // longer than it gets a new one shortly before it expires (a failed renewal is tried again a
  // minute later); the views read the store, so no view changes.
  let sas = '';
  function renewLater(sources) {
    setTimeout(async () => {
      try { sas = (await catalog.open(sources, { renew: true })).sas; renewLater(sources); }
      catch (e) { perf.log('error', 'SAS renewal', { status: String(e?.message || e) }); setTimeout(() => renewLater(sources), 60000); }
    }, Math.max(catalog.renewAt() - Date.now(), 0));
  }

  // The store, over its channel (blockcache.js): its writer says it is there ({ writer }), what
  // it lacks ({ missing, id }), and that a file handed to it is kept ({ stored }).
  const channel = new BroadcastChannel('blockcache');
  let storeUp;
  const storeReady = new Promise(r => { storeUp = r; });
  const answers = new Map();   // id -> resolve, for { missing } and { stats }
  const stored = new Map();    // store path -> resolve, for { store }
  channel.onmessage = ({ data: d }) => {
    if (d?.writer) storeUp();
    if (d?.id != null && answers.has(d.id)) { answers.get(d.id)(d); answers.delete(d.id); }
    if (d?.stored && stored.has(d.stored)) { stored.get(d.stored)(); stored.delete(d.stored); }
  };
  const waitFor = (map, key, send, what) => new Promise((resolve, reject) => {
    map.set(key, resolve);
    send();
    setTimeout(() => { if (map.get(key) === resolve) { map.delete(key); reject(new Error(`the local store did not answer (${what})`)); } }, STORE_WAIT);
  });
  // The files of `paths` (abfss) the store does not hold whole.
  async function lacking(paths) {
    const id = `${Date.now()}-${Math.random()}`;
    const missing = new Set((await waitFor(answers, id, () => channel.postMessage({ missing: paths.map(storePath), id }), 'what it holds')).missing);
    return paths.filter(p => missing.has(storePath(p)));
  }
  // What the store holds, for the Logs tab.
  async function logStore(when) {
    const id = `${Date.now()}-${Math.random()}`;
    const { stats } = await waitFor(answers, id, () => channel.postMessage({ stats: true, id }), 'its size');
    perf.log('info', `store ${when}: ${stats.files} files, ${(stats.bytes / 1073741824).toFixed(2)} GB`);
  }
  // A whole file the page downloaded, handed to the store: resolved once the writer keeps it.
  const toStore = (path, bytes) =>
    waitFor(stored, storePath(path), () => channel.postMessage({ store: storePath(path), bytes }), path.split('/').pop());

  // Opens a table: its view, over a copy in memory or over the files. Runs inside a queued
  // job, so it calls the connection itself. One opening per table and engine, whoever asks; a
  // failed one can be asked for again.
  // A view over iceberg_scan would plan the table again for every query that reads it
  // (metadata.json, the manifest list and every manifest, one request at a time). So a table
  // is planned once, by the page, and its record kept: the view is read_parquet over the
  // snapshot's files, written as literals, and a query reads only Parquet (footers held by
  // parquet_metadata_cache). The columns are the files' own: a table's columns change only
  // with a rebuild, never in place.
  // A record kept from an earlier visit that fails to open (a file gone, a record of another
  // build) is dropped and the table planned again, once.
  function open(e, name) {
    const t = located.get(name);
    return e.opened.get(name) ?? e.opened.set(name, (async () => {
      prioritize(name);
      try { await bind(e, name, t, await readyOf(name, t)); }
      catch (err) {
        if (!t.stored) throw err;
        perf.log('info', `OPEN ${name} from its record failed (${err?.message || err}): planned again`);
        snapshots.drop(name); t.record = null; t.stored = false; t.ready = null;
        t.planning = planFor(t);
        await bind(e, name, t, await readyOf(name, t));
      }
    })().catch(err => { e.opened.delete(name); throw err; })).get(name);
  }
  const readyOf = (name, t) => t.ready ??= (async () => {
    const record = t.record ?? await planned(name, t);
    await local(name, t, record);
    t.whenReady();
    return record;
  })().catch(err => { t.ready = null; throw err; });

  // The table's record, planned by the page (`planning`, started at load).
  async function planned(name, t) {
    const record = { location: t.location, bytes: t.bytes, ...(await t.planning).record };
    snapshots.put(name, record);
    t.record = record;
    return record;
  }
  // Every file of the record in the store: the ones it lacks downloaded, six at a time, and
  // checked kept. A large table shows how far it has got (onProgress): a first visit
  // downloads it whole before its charts draw.
  async function local(name, t, record) {
    const all = [...record.files, ...record.deleteFiles];
    const missing = new Set(await lacking(all.map(f => f.path)));
    if (!missing.size) return;
    const fresh = all.filter(f => missing.has(f.path));
    const t0 = performance.now();
    const shown = !(t.bytes != null && t.bytes <= SMALL_BYTES);
    let done = 0, got = 0;
    const progress = () => shown && onProgress({ label: `Downloading ${name}`, done, total: fresh.length,
      detail: `${done} of ${fresh.length} files, ${(got / 1048576).toFixed(0)} MB${t.bytes && fresh.length === all.length ? ` of ${(t.bytes / 1048576).toFixed(0)} MB` : ''}. Kept in this browser for the next visit.` });
    progress();
    try {
      await prefetchFiles(name, fresh, f => https(f, sas), toStore, n => { done++; got += n; progress(); });
    } finally { if (shown) onProgress(null); }
    const still = await lacking(fresh.map(f => f.path));
    if (still.length) throw new Error(`${name}: ${still.length} files not in the local store after their download`);
    perf.log('fetch', `download ${name}: ${fresh.length} files, ${(got / 1048576).toFixed(0)} MB`, { ms: performance.now() - t0 });
    logStore(`after ${name}`).catch(() => {});
  }
  // The table's view on engine `e`, over a copy in its memory or over the files.
  async function bind(e, name, t, record) {
    const mb = t.bytes == null ? '?' : (t.bytes / 1048576).toFixed(1);
    const small = t.bytes != null && t.bytes <= SMALL_BYTES;
    // What a view cannot read (no data file, a file that is not Parquet such as a deletion
    // vector, an equality delete) is an error: there is no other way in.
    if (record.scan) throw new Error(`${name}: not readable as Parquet with position deletes (no data file, equality deletes or a deletion vector)`);
    for (const f of [...record.files, ...record.deleteFiles]) {
      if (e.registered.has(f.path)) continue;
      await e.db.registerFileURL(localName(f.path), localUrl(f.path), duckdb.DuckDBDataProtocol.HTTP, false);
      e.registered.add(f.path);
    }
    // The positions the delete files remove, read once per session into memory.
    if (record.deleteFiles.length)
      await perf.time('attach', `DELETES ${name} (${record.deleteFiles.length} delete files)${tag(e)}`, () => e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(deletesOf(name))} AS
         SELECT DISTINCT regexp_replace(file_path, '^abfss://([^@/]+)@([^/]+)/', 'store/\\1/') AS path, pos
         FROM read_parquet([${record.deleteFiles.map(f => lit(localName(f.path))).join(', ')}])`));
    const how = `${record.files.length} Parquet files${record.deleteFiles.length ? `, ${record.deleteFiles.length} delete files applied` : ''}`;
    if (small)
      await perf.time('attach', `OPEN ${name} (${mb} MB, copied into memory, ${how})${tag(e)}`, () => e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(name)} AS ${selectOf(name, record)}; CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${ident(name)}`));
    else
      await perf.time('attach', `OPEN ${name} (${mb} MB, read in place, ${how})${tag(e)}`, () => e.conn.query(
        `CREATE OR REPLACE VIEW ${ident('v_' + name)} AS ${selectOf(name, record)}`));
  }
  // What a view reads: read_parquet over the files' local names. With delete files, the rows
  // whose file and position (file_row_number, 0-based as Iceberg's pos) a delete file names are
  // left out: `filename` is the local name, the delete file's file_path written the same way.
  const deletesOf = name => `__deletes_${name}`;
  const selectOf = (name, record) => {
    const files = `[${record.files.map(f => lit(localName(f.path))).join(', ')}]`;
    if (!record.deleteFiles.length) return `SELECT * FROM read_parquet(${files})`;
    return `SELECT * EXCLUDE (__file, file_row_number)
      FROM read_parquet(${files}, filename = '__file', file_row_number = true) AS d
      ANTI JOIN ${ident(deletesOf(name))} AS x ON x.path = d.__file AND x.pos = d.file_row_number`;
  };
  // The tables a query names (v_<table>) that are not open yet, opened first.
  const namedIn = sql => [...new Set([...sql.matchAll(/\bv_(\w+)\b/g)].map(m => m[1]))].filter(n => located.has(n));
  async function openFor(e, sql) {
    const names = namedIn(sql);
    prioritize(...names.filter(n => !e.opened.has(n)));   // their files first, in the downloads
    for (const name of names) await open(e, name);
  }

  // A new snapshot planned by the page, at once, off every engine: opening the table waits for it.
  let access = null;
  function planFor(t) {
    const t0 = performance.now();
    const planning = (t.m ? Promise.resolve(t.m) : metadataOf(t.location)).then(m => planTable(t.name, m, f => https(f, sas || access.sas)));
    planning.then(p => perf.log('attach', `PLAN ${t.name} (in the page: ${p.manifests} manifests, ${p.fetched} read, ${p.record.files.length} files)`, { ms: performance.now() - t0 }),
                  e => perf.log('error', `PLAN ${t.name}`, { status: String(e?.message || e) }));
    return planning;
  }
  async function metadataOf(location) {
    const r = await fetch(https(location, sas || access.sas));
    if (!r.ok) throw new Error(`metadata.json: HTTP ${r.status}`);
    return r.json();
  }
  // Each table's size, from its metadata.json, all at once (the page's own requests, in
  // parallel): the current snapshot's total-files-size; and its plan, started, not awaited.
  // A table whose location has a record (the same snapshot as last planned) fetches nothing:
  // its size is the record's, and it opens from it.
  async function sizeAll() {
    const metas = await Promise.all([...tables].map(async ([name, t]) => {
      const location = access.metadata[t.source];
      if (!location) return null;
      const record = snapshots.get(name, location);
      if (record) return { name, location, m: null, bytes: record.bytes, record };
      try {
        const m = await metadataOf(location);
        const s = (m.snapshots ?? []).find(s => String(s['snapshot-id']) === String(m['current-snapshot-id']));
        const bytes = s ? Number(s.summary?.['total-files-size'] ?? NaN) : 0;
        return { name, location, m, bytes: Number.isNaN(bytes) ? null : bytes };
      } catch (e) {
        return { name, location, m: null, bytes: null, error: e };   // the table fails when opened
      }
    }));
    // Smallest first: the downloads are served first come, first served, and a small table's
    // few files would otherwise wait behind a large one's.
    let kept = 0;
    for (const t of metas.filter(Boolean).sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))) {
      if (t.record) kept++;
      const planning = t.record ? null : t.error ? Promise.reject(t.error) : planFor(t);
      planning?.catch(() => {});   // logged by planFor, thrown when the table opens
      let whenReady;
      const isReady = new Promise(r => { whenReady = r; });
      located.set(t.name, { name: t.name, location: t.location, bytes: t.bytes, planning, record: t.record ?? null,
        stored: !!t.record, ready: null, whenReady, isReady });
    }
    if (kept) perf.log('info', `snapshots: ${kept} of ${metas.filter(Boolean).length} tables unchanged, opened from their records`);
  }


  async function init() {
    await auth.signIn();
    onStatus("Loading DuckDB WASM...");
    // The model, the function's answer, the tables' sizes and their plans, while DuckDB's
    // bundle loads: none of them needs it.
    const ready = fetch(MODEL).then(r => r.json()).then(async model => {
      tables = modelTables(model);
      access = await catalog.open([...new Set([...tables.values()].map(t => t.source))]);
      sas = access.sas;
      await sizeAll();
    });
    ready.catch(() => {});   // awaited below

    // Single-threaded (the eh bundle): the page is not cross-origin isolated. ENGINES of them,
    // started together.
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests (the store's answers) for the Logs tab.
      new Blob([`importScripts("${BLOCKCACHE}");
`, HTTP_TRACE_SHIM, `
importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    let warmed = false;
    engines = new Array(ENGINES).fill(null);
    await Promise.all(Array.from({ length: ENGINES }, async (_, i) => {
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
      // Its worker script and WASM module fetched and compiled: the Logs tab says how long.
      await perf.time('attach', `START engine ${i + 1} (worker + WASM instantiate)`, () => db.instantiate(bundle.mainModule, bundle.pthreadWorker));
      // Its file system reads a registered https file by range, after a HEAD with
      // Range: bytes=0- that the store answers 206; never the whole file at once. All three are
      // needed: with forceFullHTTPReads left out (on), a file opens with no request and fails.
      await db.open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false } });
      const version = await db.getVersion();
      if (!warmed) { warmed = true; warmExtensions(version); }
      const e = { i, db, conn: await db.connect(), busy: false, opened: new Map(), registered: new Set() };
      engines[i] = e;   // its setup below runs through the queue, on it
      // Installing needs a home directory.
      await perf.time('attach', `LOAD ${EXTENSIONS.join(', ')} (DuckDB ${version})${ENGINES > 1 ? ` [engine ${i + 1}]` : ''}`, () =>
        q(e, `SET home_directory = '/tmp'; ${EXTENSIONS.map(x => `INSTALL ${x}; LOAD ${x};`).join(' ')}`));
      try { localStorage.setItem(EXT_KEY, version); } catch (x) {}
      // Iceberg's files never change once written: a Parquet footer read holds for the session.
      await q(e, 'SET parquet_metadata_cache = true;');
      if (timeZone) await q(e, `SET TimeZone = ${lit(timeZone)};`);
      await q(e, "SET preserve_insertion_order = false;");
      return e;
    }));
    URL.revokeObjectURL(workerUrl);
    // The store: there is no other way to the data, so no store, no page.
    channel.postMessage({ ping: true });
    await Promise.race([storeReady, new Promise((_, reject) => setTimeout(() =>
      reject(new Error('no local store in this browser (OPFS with shared access handles, Chrome or Edge 121+)')), STORE_WAIT))]);
    logStore('at start').catch(() => {});

    onStatus('Locating the tables in the catalog...');
    await ready;
    renewLater([...new Set([...tables.values()].map(t => t.source))]);
    // The page's CSV export runs its SQL on a connection of its own: the first engine's, with
    // the tables the SQL names opened there first.
    const e0 = engines[0];
    const db = { connect: async () => {
      const c = await e0.db.connect();
      return { send: async sql => { await submit(() => openFor(e0, sql), { engine: e0 }); return c.send(sql); }, close: () => c.close() };
    } };
    return { db };
  }

  // After the first paint: the tables not opened yet, on every engine, small ones first, each
  // its own job at the back of its queue, so whatever the page asks goes first. A table not
  // ready yet is made ready (planned, downloaded) by the first engine; the others open it once
  // it is, so none of them waits on it with a job of its queue. Not awaited: the page does not
  // wait for them, and opening a table changes no result it holds.
  // --- Saved results: a query's result kept in this browser (IndexedDB), as Arrow IPC ---
  // Its key is the SQL and the metadata location of every table it names: a new snapshot of
  // a table is a new key, so a result is never served over newer data. Not kept: a query that
  // reads the clock or today's date (current_date, now(), random(), ...), one that is not a
  // read, a result over RESULT_MAX; the least recently used go past RESULTS_MAX in all.
  // Best-effort: storage refused or failing, a query just runs.
  const RESULT_MAX = 8 * 1024 * 1024, RESULTS_MAX = 256 * 1024 * 1024;
  const VOLATILE = /\bcurrent_(date|time|timestamp)\b|\b(now|today|random|uuid|gen_random_uuid|setseed|nextval|get_current_time|timezone)\s*\(/i;
  function resultKey(sql) {
    if (!/^\s*(select|with|from)\b/i.test(sql) || VOLATILE.test(sql)) return null;
    return [sql, ...namedIn(sql).sort().map(n => `${n} ${located.get(n)?.location}`)].join('\n');
  }
  const asPromise = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  let resultsDb = null;
  const resultStore = () => resultsDb ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('iceberg-results', 1);
    // `bytes`: key -> the IPC; `meta`: key -> its size and when last used (for the cap).
    open.onupgradeneeded = () => { open.result.createObjectStore('bytes'); open.result.createObjectStore('meta').createIndex('at', 'at'); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).catch(() => null);
  async function savedResult(key) {
    try {
      const db = await resultStore();
      if (!db) return null;
      const bytes = await asPromise(db.transaction('bytes').objectStore('bytes').get(key));
      if (!bytes) return null;
      const meta = db.transaction('meta', 'readwrite').objectStore('meta');
      meta.get(key).onsuccess = ev => { const m = ev.target.result; if (m) meta.put({ ...m, at: Date.now() }, key); };
      return tableFromIPC(bytes);
    } catch (e) { return null; }
  }
  let pruning = null;
  async function saveResult(key, table) {
    try {
      const bytes = tableToIPC(table);
      if (bytes.byteLength > RESULT_MAX) return;
      const db = await resultStore();
      if (!db) return;
      const tx = db.transaction(['bytes', 'meta'], 'readwrite');
      tx.objectStore('bytes').put(bytes, key);
      tx.objectStore('meta').put({ size: bytes.byteLength, at: Date.now() }, key);
      pruning ??= new Promise(r => setTimeout(r, 5000)).then(() => prune(db)).finally(() => { pruning = null; });
    } catch (e) {}
  }
  // The least recently used results out, past RESULTS_MAX in all.
  async function prune(db) {
    const all = [];
    await new Promise(resolve => {
      const cur = db.transaction('meta').objectStore('meta').index('at').openCursor(null, 'prev');
      cur.onsuccess = () => { const c = cur.result; if (!c) return resolve(); all.push([c.primaryKey, c.value.size]); c.continue(); };
      cur.onerror = () => resolve();
    });
    let total = 0;
    const out = all.filter(([, size]) => (total += size) > RESULTS_MAX).map(([k]) => k);
    if (!out.length) return;
    const tx = db.transaction(['bytes', 'meta'], 'readwrite');
    for (const k of out) { tx.objectStore('bytes').delete(k); tx.objectStore('meta').delete(k); }
    perf.log('info', `saved results: ${out.length} dropped (over ${RESULTS_MAX / 1048576} MB)`);
  }

  let _warming = false;
  function attachAgg() {
    if (!_warming) {
      _warming = true;
      const order = [...located].sort(([, a], [, b]) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
      for (const e of engines)
        for (const [name, t] of order) {
          if (e.opened.has(name)) continue;
          const job = () => submit(() => e.opened.has(name) ? null : open(e, name), { engine: e, later: true });
          (e === engines[0] ? job() : t.isReady.then(job)).catch(err =>
            perf.log('error', `OPEN ${name}${tag(e)}`, { status: String(err?.message || err) }));
        }
    }
    return Promise.resolve(false);
  }

  return {
    init, attachAgg,
    ensureHistory: async () => false,
    // `dax`: the query as the page wrote it, for the Logs tab (the compiler passes it).
    // `options`: the page's for the queue (queue.js): `stale`, `early`, `later`.
    // Timed here, not by perf.query: its wait assumes one worker. `wait`: in the queue, until
    // an engine took it; `ms`: the query itself (opening its tables is logged as OPEN); the
    // engine in its status.
    // A result already computed on these snapshots, on this visit or an earlier one, is read
    // back from this browser (savedResult) instead: the page's own cache (runQuery) holds the
    // last 200 for the visit, this one survives a reload.
    query: async (sql, dax, options) => {
      const t0 = performance.now();
      const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();
      const key = resultKey(sql);
      const saved = key && await savedResult(key);
      if (saved) {
        perf.log('query', flat(sql), { wait: 0, ms: performance.now() - t0, status: `${saved.numRows} rows (saved)`, dax: flat(dax) });
        return saved;
      }
      let started = null, ran = null, used = null;
      return submit(async e => {
        used = e; started = performance.now();
        await openFor(e, sql);
        ran = performance.now();
        return e.conn.query(sql);
      }, { ...options, names: namedIn(sql) }).then(r => {
        perf.log('query', flat(sql), { wait: started - t0, ms: performance.now() - ran, status: `${r.numRows} rows${tag(used)}`, dax: flat(dax) });
        if (key) saveResult(key, r);
        return r;
      }, err => {
        if (err?.skipped) perf.log('skip', flat(sql), { status: 'replaced by a newer render', dax: flat(dax) });
        else perf.log('error', flat(sql), { wait: started == null ? null : started - t0, ms: started == null ? null : performance.now() - (ran ?? started),
                                            status: `${err?.message || err}${used ? tag(used) : ''}`, dax: flat(dax) });
        throw err;
      });
    },
    // The tables the catalog has, with the model's columns (opening is not needed to list them).
    views: () => [...located.keys()].map(name => ({ name: 'v_' + name, columns: [...tables.get(name).columns] })),
    has: (view, column) => {
      const name = view.replace(/^v_/, '');
      return located.has(name) && (!column || tables.get(name).columns.has(column));
    },
    // Every view reads its table whole: a query needs nothing attached.
    needs: () => ({ history: false, agg: false }),
  };
}
