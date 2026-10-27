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
// for the tables it reads. Opening plans the table once: the snapshot's live data files, from
// its metadata.json, manifest list and manifests (PLAN, one request at a time). What that
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
// For a new snapshot the page fetches ahead of DuckDB, many at once (prefetch.js): its new
// manifests (the old ones are in the worker's store), a small table's new data files, and a
// large table's new Parquet files whole, into the browser's HTTP cache, where DuckDB's
// one-at-a-time requests find them, and the worker keeps every file it reads whole in OPFS
// (blockcache.js: Parquet, manifests, metadata.json, every one immutable; it never seeks
// OneLake, as a request costs ~0.5 s whatever its size).
// Each view is at the snapshot the catalog named (catalog.js keeps that answer up to ~55
// minutes, so a reload within it reads the same snapshots).
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
import { prefetchTable, prefetchFiles, prioritize } from "./prefetch.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const MODEL = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);
const SMALL_BYTES = 32 * 1024 * 1024;   // a table up to this much Parquet is copied into memory
// The extensions DuckDB installs, in that order (iceberg loads parquet itself), and where from:
// azure_wasm is a community extension.
const EXTENSIONS = { httpfs: 'core', avro: 'core', iceberg: 'core', azure_wasm: 'community', icu: 'core' };
// The worker's reads of Parquet files, kept in OPFS by block, and no If-Match (blockcache.js).
const BLOCKCACHE = new URL('./blockcache.js' + new URL(import.meta.url).search, import.meta.url).href;

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
  let conn, tables = new Map();
  const located = new Map();   // table name -> { location, bytes, prefetch, record }: in the catalog
  const opened = new Map();    // table name -> promise of its opening

  const serial = serialQueue();
  const q = sql => serial(() => conn.query(sql));

  // The secret azure_wasm reads the files with: the SAS from the function. The page's own
  // fetches (the prefetch) use the same one, the newest.
  // A view read in place over read_parquet carries the SAS in its URLs (fromOf), so a new SAS
  // writes those views again: the tables opened that way, name -> { location, record }.
  let sas = '';
  const inPlace = new Map();
  async function useSas(s) {
    await q(`CREATE OR REPLACE SECRET onelake (TYPE azure, PROVIDER config, ACCOUNT_NAME 'onelake',
      CONNECTION_STRING ${lit(`AccountName=onelake;SharedAccessSignature=${sas = s}`)})`);
    for (const [name, t] of inPlace) await q(viewOf(name, t, t.record));
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

  // The snapshot planned from Iceberg: its live data files, its delete files (applied by the
  // view itself, deletesOf), and the manifests read. The record snapshots.js keeps.
  // A delete file is listed by a manifest of deletes: manifest_content says which, 'DATA' or
  // 'DELETES', on every DuckDB (its `content` is 'EXISTING' for a data file on 1.5 and 'DATA' on
  // 2.0). file_format is 'parquet', lower case. `scan`: what the view cannot read itself (no
  // data file, or a file that is not Parquet: a deletion vector), left to iceberg_scan.
  async function plan(t) {
    const rows = (await conn.query(`SELECT manifest_path, file_path, manifest_content, file_format
      FROM iceberg_metadata(${lit(t.location)}) WHERE status <> 'DELETED'`)).toArray();
    const isData = r => String(r.manifest_content).toUpperCase() === 'DATA';
    const paths = rs => [...new Set(rs.map(r => r.file_path))].map(path => ({ path, size: null }));
    return {
      location: t.location, bytes: t.bytes,
      scan: !rows.some(isData) || !rows.every(r => String(r.file_format).toLowerCase() === 'parquet'),
      files: paths(rows.filter(isData)),
      deleteFiles: paths(rows.filter(r => !isData(r))),
      manifests: [...new Set(rows.map(r => r.manifest_path))],
    };
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
  // A record that fails to open (a file gone, a record of another build) is dropped and the
  // table planned again, once.
  function open(name) {
    const t = located.get(name);
    return opened.get(name) ?? opened.set(name, (async () => {
      prioritize(name);
      await t.prefetch;
      try { await openWith(name, t, t.record); }
      catch (e) {
        if (!t.record) throw e;
        perf.log('info', `OPEN ${name} from its record failed (${e?.message || e}): planned again`);
        snapshots.drop(name); t.record = null;
        await openWith(name, t, null);
      }
    })().catch(e => { opened.delete(name); throw e; })).get(name);
  }
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
  async function openWith(name, t, record) {
    const mb = t.bytes == null ? '?' : (t.bytes / 1048576).toFixed(1);
    const small = t.bytes != null && t.bytes <= SMALL_BYTES;
    if (!record) {
      record = await perf.time('attach', `PLAN ${name}`, () => plan(t));
      const last = snapshots.previous(name);
      const before = new Set([...last?.files ?? [], ...last?.deleteFiles ?? []].map(f => f.path));
      const fresh = [...record.files, ...record.deleteFiles].filter(f => !before.has(f.path));
      if (!record.scan && !small && fresh.length) {
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
    }
    tellSizes(record);
    // The positions the delete files remove, read once per session into memory. A delete file
    // with no file_path and pos is an equality delete, which the view cannot apply: the table
    // goes to iceberg_scan, and its record says so.
    if (!record.scan && record.deleteFiles.length)
      await perf.time('attach', `DELETES ${name} (${record.deleteFiles.length} delete files)`, () => conn.query(
        `CREATE OR REPLACE TABLE ${ident(deletesOf(name))} AS
         SELECT DISTINCT regexp_replace(file_path, '^abfss://([^@/]+)@([^/]+)/', 'https://\\2/\\1/') AS path, pos
         FROM read_parquet([${record.deleteFiles.map(f => lit(https(f.path, sas))).join(', ')}])`))
        .catch(e => {
          perf.log('info', `${name}: delete files not applied (${e?.message || e}), read with iceberg_scan`);
          record.scan = true; snapshots.put(name, record);
        });
    const how = record.scan ? 'iceberg_scan'
      : `${record.files.length} Parquet files${record.deleteFiles.length ? `, ${record.deleteFiles.length} delete files applied` : ''}`;
    if (small)
      await perf.time('attach', `OPEN ${name} (${mb} MB, copied into memory, ${how})`, () => conn.query(
        `CREATE OR REPLACE TABLE ${ident(name)} AS ${selectOf(name, t, record)}; CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${ident(name)}`));
    else {
      await perf.time('attach', `OPEN ${name} (${mb} MB, read in place, ${how})`, () => conn.query(viewOf(name, t, record)));
      if (!record.scan) inPlace.set(name, { location: t.location, record });
    }
  }
  // What a view reads: read_parquet over the files as https URLs with the SAS. Not abfss://:
  // read_parquet globs every path it is given, wildcard or not, and azure_wasm implements no
  // glob ("Globbing Azure paths is not supported"); httpfs takes an https URL as it is. They
  // are the URLs the prefetch fetched, so DuckDB's requests find them in the browser's cache.
  // With delete files, the rows whose file and position (file_row_number, 0-based as Iceberg's
  // pos) a delete file names are left out: the file is its URL without the SAS, the delete
  // file's file_path written the same way. iceberg_scan over abfss:// only for `scan`.
  const deletesOf = name => `__deletes_${name}`;
  const selectOf = (name, t, record) => {
    if (record.scan) return `SELECT * FROM iceberg_scan(${lit(t.location)})`;
    const files = `[${record.files.map(f => lit(https(f.path, sas))).join(', ')}]`;
    if (!record.deleteFiles.length) return `SELECT * FROM read_parquet(${files})`;
    return `SELECT * EXCLUDE (__file, file_row_number)
      FROM read_parquet(${files}, filename = '__file', file_row_number = true) AS d
      ANTI JOIN ${ident(deletesOf(name))} AS x ON x.path = split_part(d.__file, '?', 1) AND x.pos = d.file_row_number`;
  };
  const viewOf = (name, t, record) => `CREATE OR REPLACE VIEW ${ident('v_' + name)} AS ${selectOf(name, t, record)}`;
  // The tables a query names (v_<table>) that are not open yet, opened first.
  async function openFor(sql) {
    const names = [...new Set([...sql.matchAll(/\bv_(\w+)\b/g)].map(m => m[1]))].filter(n => located.has(n));
    prioritize(...names.filter(n => !opened.has(n)));   // their files first, in the prefetch
    for (const name of names) await open(name);
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
        const m = await (await fetch(https(location, access.sas))).json();
        const s = (m.snapshots ?? []).find(s => String(s['snapshot-id']) === String(m['current-snapshot-id']));
        const bytes = s ? Number(s.summary?.['total-files-size'] ?? NaN) : 0;
        return { name, location, m, bytes: Number.isNaN(bytes) ? null : bytes };
      } catch (e) {
        perf.log('info', `${name}: size unknown (${e?.message || e}), read in place`);
        return { name, location, m: null, bytes: null };
      }
    }));
    // Smallest first: the prefetch's queues are first come, first served, and a small table's
    // few files would otherwise wait behind a large one's manifests.
    let kept = 0;
    for (const t of metas.filter(Boolean).sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))) {
      const t0 = performance.now();
      if (t.record) kept++;
      const known = new Set(snapshots.previous(t.name)?.manifests ?? []);
      const prefetch = t.m && prefetchTable(t.name, t.m, f => https(f, access.sas), { data: t.bytes != null && t.bytes <= SMALL_BYTES, known })
        .then(n => perf.log('fetch', `prefetch ${t.name}: ${n} files${known.size ? ` (${known.size} manifests kept)` : ''}`, { ms: performance.now() - t0 }),
              e => perf.log('info', `prefetch ${t.name}: ${e?.message || e}`));
      located.set(t.name, { location: t.location, bytes: t.bytes, prefetch, record: t.record ?? null });
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

    // Single-threaded (the eh bundle): the page is not cross-origin isolated.
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([`importScripts("${BLOCKCACHE}");
`, HTTP_TRACE_SHIM, `
importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    const version = await db.getVersion();
    warmExtensions(version);
    conn = await db.connect();

    // Installing needs a home directory. azure_wasm is loaded before the first scan: it claims
    // abfss://, or DuckDB tries to autoload the official azure extension, which has no WASM
    // build. icu is the time zones.
    await perf.time('attach', `LOAD ${Object.keys(EXTENSIONS).join(', ')} (DuckDB ${version})`, () =>
      q(`SET home_directory = '/tmp';
         ${Object.entries(EXTENSIONS).map(([e, repo]) => `INSTALL ${e}${repo === 'core' ? '' : ` FROM ${repo}`}; LOAD ${e};`).join(' ')}`));
    try { localStorage.setItem(EXT_KEY, version); } catch (e) {}
    // Iceberg's files never change once written: what DuckDB learnt of one (its size, its
    // Parquet footer) holds for the session. A setting this build lacks is left as it is.
    for (const s of ['SET enable_http_metadata_cache = true', 'SET parquet_metadata_cache = true',
                     "SET validate_external_file_cache = 'NO_VALIDATION'"])
      await q(s).catch(e => perf.log('info', `${s}: ${e?.message || e}`));
    if (timeZone) await q(`SET TimeZone = ${lit(timeZone)};`);
    await q("SET preserve_insertion_order = false;");

    onStatus('Locating the tables in the catalog...');
    const access = await ready;
    await useSas(access.sas);
    renewLater([...new Set([...tables.values()].map(t => t.source))]);
    return { db };
  }

  // After the first paint: the tables not opened yet, small ones first, each its own job at
  // the back of the queue, so whatever the page asks goes first. Not awaited: the page does
  // not wait for them, and opening a table changes no result it holds.
  let _warming = false;
  function attachAgg() {
    if (!_warming) {
      _warming = true;
      const rest = [...located].filter(([name]) => !opened.has(name))
        .sort(([, a], [, b]) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity)).map(([name]) => name);
      for (const name of rest)
        serial(() => opened.has(name) ? null : open(name), { later: true }).catch(e =>
          perf.log('error', `OPEN ${name}`, { status: String(e?.message || e) }));
    }
    return Promise.resolve(false);
  }

  return {
    init, attachAgg,
    ensureHistory: async () => false,
    // `dax`: the query as the page wrote it, for the Logs tab (the compiler passes it).
    // `options`: the page's for the queue (queue.js): `stale`, `early`, `later`.
    query: (sql, dax, options) => perf.query(sql, () => serial(async () => { await openFor(sql); return conn.query(sql); }, options), dax),
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
