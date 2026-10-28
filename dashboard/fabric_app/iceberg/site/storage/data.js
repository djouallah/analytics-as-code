// =============================================================================
// data.js — DataSource: the catalog's tables, read by DuckDB-WASM
// =============================================================================
// The Iceberg backend of the Fabric app. Its inputs are the semantic model and a OneLake
// Iceberg catalog, nothing else: no import, no file written for it. The model names the
// tables (an Ossie dataset's `source`, or a TMSL table's Direct Lake partition: schema.table);
// the function says where each one is now and signs a read-only SAS (catalog.js); DuckDB-WASM
// reads them with the `iceberg` extension and `azure_wasm` (abfss:// paths to https with the
// SAS, as the official `azure` extension has no WASM build).
// The engine is duckdb-wasm's npm release (DuckDB 1.5), from jsDelivr, the GitHub page's pin,
// with DuckDB's signed extensions (azure_wasm from the community repository). Nothing a query
// reads depends on the engine's Iceberg scan: the extension plans a table (iceberg_metadata),
// and the views are plain Parquet, delete files applied by the view itself.
//
// A table is opened when a query first names its view, v_<table>, so the first paint pays only
// for the tables it reads. A table is planned once: the snapshot's live data files, from its
// metadata.json, manifest list and manifests, read by the page at load, many at once and off
// every engine (prefetch.js's planTable; DuckDB's PLAN only for a table it cannot). What that
// gives is kept in this browser as the client's own catalog (snapshots.js, keyed by the
// metadata location the function gave: a commit always writes a new one), and a table whose
// location is the same is opened from its record, nothing read. A table whose files are small
// (SMALL_BYTES, from its metadata.json) is copied into DuckDB's memory and its view reads
// that: later queries do not go back to OneLake. A larger one is read in place, its view
// read_parquet over the files, as https URLs with the SAS (azure_wasm cannot glob, which
// read_parquet does to every path), written again on a new SAS. A table's position deletes are
// applied by its view (the engine's iceberg_scan is never what a query reads). After the first
// paint the rest are opened in the background, small ones first, behind whatever the page
// asks.
// For a new snapshot the page fetches ahead of DuckDB, many at once (prefetch.js): the
// manifests it has not read before (kept in Cache Storage), a small table's files, and a
// large table's new Parquet files whole, into the browser's HTTP cache, where DuckDB's
// one-at-a-time requests find them, and the worker keeps every file it reads whole in OPFS
// (blockcache.js: Parquet, manifests, metadata.json, every one immutable; it never seeks
// OneLake, as a request costs ~0.5 s whatever its size).
// Each view is at the snapshot the catalog named (catalog.js keeps that answer up to ~55
// minutes, so a reload within it reads the same snapshots).
// DuckDB-WASM runs single-threaded here, so the page runs a pool of engines (ENGINES, each its
// own worker and memory; `?engines=N` in the URL, 1 to 4, to compare): a query goes to the
// engine with the fewest waiting, so a render's queries run side by side. A table is planned
// and its files downloaded once, by the engine that opens it first; each engine then has its
// own view (and its own copy of a small table). All the workers share the block store.
//
// The members are the ones the page calls on the other hosts:
//   init            sign in, locate the tables, size them; nothing opened yet
//   attachAgg       starts opening the rest in the background; nothing for the page to redraw
//   ensureHistory   nothing to attach: every view reads its table whole
//   query, views, has, needs
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
import { serialQueue } from "./queue.js";
import { createAuth } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { createSnapshots } from "./snapshots.js";
import { planTable, prefetchFiles, prioritize } from "./prefetch.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const MODEL = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);
const SMALL_BYTES = 32 * 1024 * 1024;   // a table up to this much Parquet is copied into memory
// The extensions DuckDB installs, in that order (iceberg loads parquet itself), and where from:
// azure_wasm is a community extension.
const EXTENSIONS = { httpfs: 'core', avro: 'core', iceberg: 'core', azure_wasm: 'community', icu: 'core' };
// The worker's reads of Parquet files, kept in OPFS by block, and no If-Match (blockcache.js).
const BLOCKCACHE = new URL('./blockcache.js' + new URL(import.meta.url).search, import.meta.url).href;
const ENGINES = (() => {
  try { const n = Number(new URLSearchParams(location.search).get('engines')); if (n >= 1 && n <= 4) return Math.floor(n); } catch (e) {}
  return 2;
})();

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
// abfss://<ws>@onelake.dfs.fabric.microsoft.com/<lh>/... -> https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>/...
const https = (abfss, sas) => `${abfss.replace(/^abfss:\/\/([^@/]+)@([^/]+)\//, 'https://$2/$1/')}?${sas}`;

// DuckDB downloads its extensions one at a time (3.2 s cold on 1.5.6). On a browser's first
// load the page fetches them all at once, as soon as the engine says its version, into the
// browser's cache, where DuckDB's own request finds them. After that the worker answers DuckDB
// from OPFS (blockcache.js), and the page fetches nothing (the version it loaded is remembered).
const EXT_KEY = 'duckdb_extensions';
const extensionUrl = (version, e) =>
  `https://${EXTENSIONS[e] === 'community' ? 'community-' : ''}extensions.duckdb.org/${version}/wasm_eh/${e}.duckdb_extension.wasm`;
function warmExtensions(version) {
  let known = null; try { known = localStorage.getItem(EXT_KEY); } catch (e) {}
  if (known === version) return;
  const t0 = performance.now();
  Promise.all([...Object.keys(EXTENSIONS), 'parquet'].map(e => fetch(extensionUrl(version, e)).then(r => r.arrayBuffer())))
    .then(f => perf.log('fetch', `prefetch extensions: ${f.length} files`, { ms: performance.now() - t0 }))
    .catch(e => perf.log('info', `prefetch extensions: ${e?.message || e}`));
}

// onProgress({ label, done, total, detail }) while a long download runs, null when it ends.
// timeZone: the session's, which CURRENT_DATE follows; the page's to say (none: DuckDB's own).
export function createDataSource({ onStatus = () => {}, onProgress = () => {}, timeZone = null } = {}) {
  const catalog = createCatalog(() => auth.client());
  const snapshots = createSnapshots();
  // A kept answer from the function needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: catalog.fresh });
  let tables = new Map();
  // table name -> { location, bytes, prefetch, record, stored, ready, whenReady }: in the catalog.
  // `ready`: the table planned and its new files downloaded, once for every engine.
  const located = new Map();

  // The engines: each its worker, connection, queue, and the tables opened on it
  // (`opened`: name -> promise of its opening; `inPlace`: the views over the files, written
  // again on a new SAS). `waiting`: its queries sent and not done (the background openings
  // not counted), which is how a query picks its engine.
  let engines = [];
  const run = (e, fn, options) => {
    const counted = !options?.later;
    if (counted) e.waiting++;
    return e.serial(fn, options).finally(() => { if (counted) e.waiting--; });
  };
  const q = (e, sql) => run(e, () => e.conn.query(sql));
  const tag = e => engines.length > 1 ? ` [engine ${e.i + 1}]` : '';

  // The secret azure_wasm reads the files with: the SAS from the function. The page's own
  // fetches (the prefetch) use the same one, the newest.
  // A view read in place over read_parquet carries the SAS in its URLs (fromOf), so a new SAS
  // writes those views again, on every engine.
  let sas = '';
  async function useSas(s) {
    sas = s;
    await Promise.all(engines.map(async e => {
      await q(e, `CREATE OR REPLACE SECRET onelake (TYPE azure, PROVIDER config, ACCOUNT_NAME 'onelake',
        CONNECTION_STRING ${lit(`AccountName=onelake;SharedAccessSignature=${sas}`)})`);
      for (const [name, t] of e.inPlace) await q(e, viewOf(name, t, t.record));
    }));
  }

  // A page open longer than its SAS: a new one shortly before it expires. The views stay on
  // the snapshots they were created on; only the SAS is replaced. A failed renewal is tried
  // again a minute later.
  function renewLater(sources) {
    setTimeout(async () => {
      try { await useSas((await catalog.open(sources, { renew: true })).sas); renewLater(sources); }
      catch (e) { perf.log('error', 'SAS renewal', { status: String(e?.message || e) }); setTimeout(() => renewLater(sources), 60000); }
    }, Math.max(catalog.renewAt() - Date.now(), 0));
  }

  // Opens a table: its view, over a copy in memory or over the files. Runs inside a queued
  // job, so it calls the connection itself. One opening per table, whoever asks; a failed one
  // can be asked for again.
  // A view over iceberg_scan is planned again by every query that reads it: metadata.json, the
  // manifest list and every manifest, one request at a time (hundreds on a large table, one
  // manifest per hourly commit). So a table is planned once (PLAN), and its record kept: the
  // view is read_parquet over the snapshot's files, written as a literal, and a query reads
  // only Parquet (footers held by parquet_metadata_cache, files by blockcache.js). A table
  // with delete files is read the same way, its position deletes applied by the view
  // (deletesOf): iceberg_scan is never what a query reads, as how it plans differs by version
  // (DuckDB 1.5's plans a table with delete files again on every scan, every delete file one
  // request). The columns are the files' own: a table's columns change only with a rebuild,
  // never in place.
  // A large table's new files (all of them on a first visit, delete files included) are
  // fetched whole ahead, six at a time, before the view binds (the worker fetches a file whole
  // on its first read, one at a time); the sizes learnt go into the record, so a HEAD of them
  // needs no request.
  // A record kept from an earlier visit that fails to open (a file gone, a record of another
  // build) is dropped and the table planned again, once.
  // Planning and the download are the table's, done once by the engine that opens it first
  // (readyOf); the view is each engine's (bind).
  function open(e, name) {
    const t = located.get(name);
    return e.opened.get(name) ?? e.opened.set(name, (async () => {
      prioritize(name);
      try { await bind(e, name, t, await readyOf(e, name, t)); }
      catch (err) {
        if (!t.stored) throw err;
        perf.log('info', `OPEN ${name} from its record failed (${err?.message || err}): planned again`);
        snapshots.drop(name); t.record = null; t.stored = false; t.ready = null;
        await bind(e, name, t, await readyOf(e, name, t));
      }
    })().catch(err => { e.opened.delete(name); throw err; })).get(name);
  }
  const readyOf = (e, name, t) => t.ready ??= (t.record ? Promise.resolve(t.record) : planned(name, t))
    .then(record => { t.whenReady(); return record; }, err => { t.ready = null; throw err; });
  // The worker's store answers a HEAD of a file whose size it knows: the sizes of the record's
  // files, sent before the view binds.
  const channel = (() => { try { return new BroadcastChannel('blockcache'); } catch (e) { return null; } })();
  const storePath = p => p.replace(/^abfss:\/\/([^@/]+)@([^/]+)\//, 'https://$2/$1/');
  function tellSizes(record) {
    const sizes = Object.fromEntries([...record.files, ...record.deleteFiles].filter(f => f.size).map(f => [storePath(f.path), f.size]));
    if (channel && Object.keys(sizes).length) channel.postMessage({ sizes });
  }
  // A whole file the page downloaded, handed to the worker's store; resolved when the writer
  // says it is kept, or after STORE_WAIT (no store: the worker fetches it itself on a miss).
  const STORE_WAIT = 30000;
  const stored = new Map();   // store path -> resolve
  if (channel) channel.onmessage = e => { const p = e.data?.stored; if (p && stored.has(p)) { stored.get(p)(); stored.delete(p); } };
  const toStore = (path, bytes) => !channel ? Promise.resolve() : new Promise(resolve => {
    const key = storePath(path);
    stored.set(key, resolve);
    channel.postMessage({ store: key, bytes });
    setTimeout(() => { if (stored.get(key) === resolve) { stored.delete(key); resolve(); } }, STORE_WAIT);
  });
  // The table's record, and a large table's new files downloaded. The page planned it
  // (`planning`, prefetch.js's planTable, started at load): a table it could not plan fails.
  async function planned(name, t) {
    const small = t.bytes != null && t.bytes <= SMALL_BYTES;
    const record = { location: t.location, bytes: t.bytes, ...(await t.planning).record };
    const last = snapshots.previous(name);
    const before = new Set([...last?.files ?? [], ...last?.deleteFiles ?? []].map(f => f.path));
    const fresh = [...record.files, ...record.deleteFiles].filter(f => !before.has(f.path));
    if (!small && fresh.length) {
      const t0 = performance.now();
      // The page shows how far it has got (onProgress): a first visit downloads a large
      // table whole before its charts draw.
      let done = 0, got = 0;
      const progress = () => onProgress({ label: `Downloading ${name}`, done, total: fresh.length,
        detail: `${done} of ${fresh.length} files, ${(got / 1048576).toFixed(0)} MB${t.bytes && fresh.length === record.files.length ? ` of ${(t.bytes / 1048576).toFixed(0)} MB` : ''}. Kept in this browser for the next visit.` });
      progress();
      let sizes;
      try {
        sizes = new Map((await prefetchFiles(name, fresh, f => https(f, sas), toStore,
          n => { done++; got += n; progress(); })).map(f => [f.path, f.size]));
      } finally { onProgress(null); }
      for (const f of [...record.files, ...record.deleteFiles]) if (sizes.get(f.path)) f.size = sizes.get(f.path);
      perf.log('fetch', `prefetch ${name}: ${fresh.length} files`, { ms: performance.now() - t0 });
    }
    snapshots.put(name, record);
    t.record = record;
    return record;
  }
  // The table's view on engine `e`, over a copy in its memory or over the files.
  async function bind(e, name, t, record) {
    const mb = t.bytes == null ? '?' : (t.bytes / 1048576).toFixed(1);
    const small = t.bytes != null && t.bytes <= SMALL_BYTES;
    // What a view cannot read (no data file, a file that is not Parquet such as a deletion
    // vector, an equality delete) is an error: there is no other way in.
    if (record.scan) throw new Error(`${name}: not readable as Parquet with position deletes (no data file, equality deletes or a deletion vector)`);
    tellSizes(record);
    // The positions the delete files remove, read once per session into memory.
    if (record.deleteFiles.length)
      await perf.time('attach', `DELETES ${name} (${record.deleteFiles.length} delete files)${tag(e)}`, () => e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(deletesOf(name))} AS
         SELECT DISTINCT regexp_replace(file_path, '^abfss://([^@/]+)@([^/]+)/', 'https://\\2/\\1/') AS path, pos
         FROM read_parquet([${record.deleteFiles.map(f => lit(https(f.path, sas))).join(', ')}])`));
    const how = `${record.files.length} Parquet files${record.deleteFiles.length ? `, ${record.deleteFiles.length} delete files applied` : ''}`;
    if (small)
      await perf.time('attach', `OPEN ${name} (${mb} MB, copied into memory, ${how})${tag(e)}`, () => e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(name)} AS ${selectOf(name, t, record)}; CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${ident(name)}`));
    else {
      await perf.time('attach', `OPEN ${name} (${mb} MB, read in place, ${how})${tag(e)}`, () => e.conn.query(viewOf(name, t, record)));
      e.inPlace.set(name, { location: t.location, record });
    }
  }
  // What a view reads: read_parquet over the files as https URLs with the SAS. Not abfss://:
  // read_parquet globs every path it is given, wildcard or not, and azure_wasm implements no
  // glob ("Globbing Azure paths is not supported"); httpfs takes an https URL as it is. They
  // are the URLs the prefetch fetched, so DuckDB's requests find them in the browser's cache.
  // With delete files, the rows whose file and position (file_row_number, 0-based as Iceberg's
  // pos) a delete file names are left out: the file is its URL without the SAS, the delete
  // file's file_path written the same way.
  const deletesOf = name => `__deletes_${name}`;
  const selectOf = (name, t, record) => {
    const files = `[${record.files.map(f => lit(https(f.path, sas))).join(', ')}]`;
    if (!record.deleteFiles.length) return `SELECT * FROM read_parquet(${files})`;
    return `SELECT * EXCLUDE (__file, file_row_number)
      FROM read_parquet(${files}, filename = '__file', file_row_number = true) AS d
      ANTI JOIN ${ident(deletesOf(name))} AS x ON x.path = split_part(d.__file, '?', 1) AND x.pos = d.file_row_number`;
  };
  const viewOf = (name, t, record) => `CREATE OR REPLACE VIEW ${ident('v_' + name)} AS ${selectOf(name, t, record)}`;
  // The tables a query names (v_<table>) that are not open yet, opened first.
  const namedIn = sql => [...new Set([...sql.matchAll(/\bv_(\w+)\b/g)].map(m => m[1]))].filter(n => located.has(n));
  async function openFor(e, sql) {
    const names = namedIn(sql);
    prioritize(...names.filter(n => !e.opened.has(n)));   // their files first, in the prefetch
    for (const name of names) await open(e, name);
  }
  // The engine a query goes to: the one with the fewest queries waiting, and of those, the one
  // with more of its tables open.
  function pick(sql) {
    const names = namedIn(sql);
    const score = e => e.waiting * 1000 - names.filter(n => e.opened.has(n)).length;
    return engines.reduce((a, b) => score(b) < score(a) ? b : a);
  }

  // Each table's size, from its metadata.json, all at once (the page's own requests, in
  // parallel): the current snapshot's total-files-size. And its prefetch, started, not awaited:
  // opening the table waits for it, and a failed prefetch only costs time.
  // A table whose location has a record (the same snapshot as last planned) fetches nothing:
  // its size is the record's, and it opens from it.
  async function sizeAll(access) {
    const metas = await Promise.all([...tables].map(async ([name, t]) => {
      const location = access.metadata[t.source];
      if (!location) return null;
      const record = snapshots.get(name, location);
      if (record) return { name, location, m: null, bytes: record.bytes, record };
      try {
        const r = await fetch(https(location, access.sas));
        if (!r.ok) throw new Error(`metadata.json: HTTP ${r.status}`);
        const m = await r.json();
        const s = (m.snapshots ?? []).find(s => String(s['snapshot-id']) === String(m['current-snapshot-id']));
        const bytes = s ? Number(s.summary?.['total-files-size'] ?? NaN) : 0;
        return { name, location, m, bytes: Number.isNaN(bytes) ? null : bytes };
      } catch (e) {
        return { name, location, m: null, bytes: null, error: e };   // the table fails when opened
      }
    }));
    // Smallest first: the prefetch's queues are first come, first served, and a small table's
    // few files would otherwise wait behind a large one's manifests.
    let kept = 0;
    for (const t of metas.filter(Boolean).sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))) {
      const t0 = performance.now();
      if (t.record) kept++;
      // A new snapshot is planned here, at once, off every engine (and a small table's files
      // fetched into the HTTP cache): opening the table waits for it.
      const planning = t.record ? null
        : t.m ? planTable(t.name, t.m, f => https(f, access.sas), { data: t.bytes != null && t.bytes <= SMALL_BYTES })
        : Promise.reject(t.error);
      planning?.then(p => perf.log('attach', `PLAN ${t.name} (in the page: ${p.manifests} manifests, ${p.fetched} read, ${p.record.files.length} files)`, { ms: performance.now() - t0 }),
                     e => perf.log('error', `PLAN ${t.name}`, { status: String(e?.message || e) }));
      let whenReady;
      const ready = new Promise(r => { whenReady = r; });
      located.set(t.name, { location: t.location, bytes: t.bytes, planning, record: t.record ?? null,
        stored: !!t.record, ready: null, whenReady, isReady: ready });
    }
    if (kept) perf.log('info', `snapshots: ${kept} of ${metas.filter(Boolean).length} tables unchanged, opened from their records`);
  }


  async function init() {
    await auth.signIn();
    onStatus("Loading DuckDB WASM...");
    // The model, the function's answer, the tables' sizes and their prefetch, while DuckDB's
    // bundle loads: none of them needs it.
    const ready = fetch(MODEL).then(r => r.json()).then(async model => {
      tables = modelTables(model);
      const access = await catalog.open([...new Set([...tables.values()].map(t => t.source))]);
      await sizeAll(access);
      return access;
    });
    ready.catch(() => {});   // awaited below

    // Single-threaded (the eh bundle): the page is not cross-origin isolated. ENGINES of them,
    // started together.
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([`importScripts("${BLOCKCACHE}");
`, HTTP_TRACE_SHIM, `
importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    let warmed = false;
    engines = await Promise.all(Array.from({ length: ENGINES }, async (_, i) => {
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      const version = await db.getVersion();
      if (!warmed) { warmed = true; warmExtensions(version); }
      const e = { i, db, conn: await db.connect(), serial: serialQueue(), waiting: 0, opened: new Map(), inPlace: new Map() };
      // Installing needs a home directory. azure_wasm is loaded before the first scan: it
      // claims abfss://, or DuckDB tries to autoload the official azure extension, which has no
      // WASM build. icu is the time zones.
      await perf.time('attach', `LOAD ${Object.keys(EXTENSIONS).join(', ')} (DuckDB ${version})${ENGINES > 1 ? ` [engine ${i + 1}]` : ''}`, () =>
        q(e, `SET home_directory = '/tmp';
           ${Object.entries(EXTENSIONS).map(([x, repo]) => `INSTALL ${x}${repo === 'core' ? '' : ` FROM ${repo}`}; LOAD ${x};`).join(' ')}`));
      try { localStorage.setItem(EXT_KEY, version); } catch (x) {}
      // Iceberg's files never change once written: what DuckDB learnt of one (its size, its
      // Parquet footer) holds for the session. A setting this build lacks is left as it is.
      for (const s of ['SET enable_http_metadata_cache = true', 'SET parquet_metadata_cache = true',
                       "SET validate_external_file_cache = 'NO_VALIDATION'"])
        await q(e, s).catch(x => perf.log('info', `${s}: ${x?.message || x}`));
      if (timeZone) await q(e, `SET TimeZone = ${lit(timeZone)};`);
      await q(e, "SET preserve_insertion_order = false;");
      return e;
    }));
    URL.revokeObjectURL(workerUrl);

    onStatus('Locating the tables in the catalog...');
    const access = await ready;
    await useSas(access.sas);
    renewLater([...new Set([...tables.values()].map(t => t.source))]);
    // The page's CSV export runs its SQL on a connection of its own: the first engine's, with
    // the tables the SQL names opened there first.
    const e0 = engines[0];
    const db = { connect: async () => {
      const c = await e0.db.connect();
      return { send: async sql => { await run(e0, () => openFor(e0, sql)); return c.send(sql); }, close: () => c.close() };
    } };
    return { db };
  }

  // After the first paint: the tables not opened yet, on every engine, small ones first, each
  // its own job at the back of its queue, so whatever the page asks goes first. A table not
  // planned yet is planned (and downloaded) by the first engine; the others open it once it
  // is, so none of them waits on it with a job of its queue. Not awaited: the page does not
  // wait for them, and opening a table changes no result it holds.
  let _warming = false;
  function attachAgg() {
    if (!_warming) {
      _warming = true;
      const order = [...located].sort(([, a], [, b]) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
      for (const e of engines)
        for (const [name, t] of order) {
          if (e.opened.has(name)) continue;
          const job = () => run(e, () => e.opened.has(name) ? null : open(e, name), { later: true });
          (e === engines[0] || t.record ? job() : t.isReady.then(job)).catch(err =>
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
    query: (sql, dax, options) => perf.query(sql, () => {
      const e = pick(sql);
      return run(e, async () => { await openFor(e, sql); return e.conn.query(sql); }, options);
    }, dax),
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
