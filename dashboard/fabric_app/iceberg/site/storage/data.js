// =============================================================================
// data.js — DataSource: the catalog's tables, read by DuckDB-WASM
// =============================================================================
// The Iceberg backend of the Fabric app. Its inputs are the semantic model and a OneLake
// Iceberg catalog, nothing else: no import, no file written for it. The model names the
// tables (an Ossie dataset's `source`, or a TMSL table's Direct Lake partition: schema.table);
// the function says where each one is now and signs a read-only SAS (catalog.js); DuckDB-WASM
// reads them with the `iceberg` extension and `azure_wasm` (abfss:// paths to https with the
// SAS, as the official `azure` extension has no WASM build).
// The engine is DuckDB 2.0, served by the app with its extensions (../duckdb/, fetched by
// ../../duckdb.mjs at build: duckdb-wasm has no 2.0 release yet). They are relabelled for the
// engine, so unsigned: DuckDB is opened with unsigned extensions allowed and installs them from
// the app's own ext/ repository only.
//
// A table is opened when a query first names its view, v_<table>: opening reads the table's
// metadata (a few requests, one at a time), so the first paint pays only for the tables it
// reads. A table whose files are small (SMALL_BYTES, from its metadata.json) is copied into
// DuckDB's memory and its view reads that: later queries do not go back to OneLake. A larger
// one stays a view over iceberg_scan, read in place. After the first paint the rest are
// opened in the background, small ones first, behind whatever the page asks.
// At start the page also fetches every table's Iceberg files, many at once (prefetch.js: the
// metadata layers, then a small table's data files), into the browser's HTTP cache, where
// DuckDB's one-at-a-time requests then find them.
// Nothing is stored between visits: each view is at the snapshot the catalog named (catalog.js
// keeps that answer up to ~55 minutes, so a reload within it reads the same snapshots).
//
// The members are the ones the page calls on the other hosts:
//   init            sign in, locate the tables, size them; nothing opened yet
//   attachAgg       starts opening the rest in the background; nothing for the page to redraw
//   ensureHistory   nothing to attach: every view reads its table whole
//   query, views, has, needs
// =============================================================================

import * as duckdb from "../duckdb/duckdb-browser.mjs";
import { serialQueue } from "./queue.js";
import { createAuth } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { prefetchTable, prioritize } from "./prefetch.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const MODEL = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);
const SMALL_BYTES = 32 * 1024 * 1024;   // a table up to this much Parquet is copied into memory
const ENGINE = new URL('../duckdb/', import.meta.url).href;
// The extensions DuckDB installs, in that order (iceberg loads parquet itself).
const EXTENSIONS = ['httpfs', 'avro', 'iceberg', 'azure_wasm', 'icu'];
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

// The engine's pins (../../duckdb.mjs), with the extensions' folder, ext-<hash of the pins>: its
// files never change, so the worker keeps them in OPFS for good (blockcache.js).
const PINS = fetch(`${ENGINE}pins.json`).then(r => r.json());
PINS.catch(() => {});   // awaited by init, which reports it
// DuckDB downloads its extensions one at a time, ~11 MB served uncompressed (13 s live on
// 2026-10-27). On a browser's first load the page fetches them all at once at the start, while
// the sign-in and the function run, into the browser's cache, where DuckDB's own request finds
// them. After that the worker answers DuckDB from OPFS, and the page fetches nothing (the
// folder it loaded is remembered in localStorage).
const EXT_KEY = 'duckdb_extensions';
function warmExtensions() {
  const t0 = performance.now();
  PINS.then(p => {
    let known = null; try { known = localStorage.getItem(EXT_KEY); } catch (e) {}
    if (known === p.ext) return;
    return Promise.all([...EXTENSIONS, 'parquet'].map(e =>
      fetch(`${ENGINE}${p.ext}/${p.label}/${p.platform}/${e}.duckdb_extension.wasm`).then(r => r.arrayBuffer())))
      .then(f => perf.log('fetch', `prefetch extensions: ${f.length} files`, { ms: performance.now() - t0 }));
  }).catch(e => perf.log('info', `prefetch extensions: ${e?.message || e}`));
}

export function createDataSource({ onStatus = () => {} } = {}) {
  const catalog = createCatalog(() => auth.client());
  // A kept answer from the function needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: catalog.fresh });
  let conn, tables = new Map();
  const located = new Map();   // table name -> { location, bytes, prefetch }: in the catalog
  const opened = new Map();    // table name -> promise of its opening

  const serial = serialQueue();
  const q = sql => serial(() => conn.query(sql));

  // The secret azure_wasm reads the files with: the SAS from the function.
  const useSas = sas => q(`CREATE OR REPLACE SECRET onelake (TYPE azure, PROVIDER config, ACCOUNT_NAME 'onelake',
      CONNECTION_STRING ${lit(`AccountName=onelake;SharedAccessSignature=${sas}`)})`);

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
  function open(name) {
    const t = located.get(name);
    return opened.get(name) ?? opened.set(name, (async () => {
      prioritize(name);
      await t.prefetch;
      const scan = `iceberg_scan(${lit(t.location)})`;
      const small = t.bytes != null && t.bytes <= SMALL_BYTES;
      const mb = t.bytes == null ? '?' : (t.bytes / 1048576).toFixed(1);
      await perf.time('attach', `OPEN ${name} (${mb} MB, ${small ? 'copied into memory' : 'read in place'})`, () => conn.query(small
        ? `CREATE OR REPLACE TABLE ${ident(name)} AS SELECT * FROM ${scan}; CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${ident(name)}`
        : `CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${scan}`));
    })().catch(e => { opened.delete(name); throw e; })).get(name);
  }
  // The tables a query names (v_<table>) that are not open yet, opened first.
  async function openFor(sql) {
    const names = [...new Set([...sql.matchAll(/\bv_(\w+)\b/g)].map(m => m[1]))].filter(n => located.has(n));
    prioritize(...names.filter(n => !opened.has(n)));   // their files first, in the prefetch
    for (const name of names) await open(name);
  }

  // Each table's size, from its metadata.json, all at once (the page's own requests, in
  // parallel): the current snapshot's total-files-size. And its prefetch, started, not awaited:
  // opening the table waits for it, and a failed prefetch only costs time.
  async function sizeAll(access) {
    const metas = await Promise.all([...tables].map(async ([name, t]) => {
      const location = access.metadata[t.source];
      if (!location) return null;
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
    // few files would otherwise wait behind a large one's manifests (on power's full data the
    // first query waited 30 s for dim_region's three files).
    for (const t of metas.filter(Boolean).sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))) {
      const t0 = performance.now();
      const prefetch = t.m && prefetchTable(t.name, t.m, f => https(f, access.sas), { data: t.bytes != null && t.bytes <= SMALL_BYTES })
        .then(n => perf.log('fetch', `prefetch ${t.name}: ${n} files`, { ms: performance.now() - t0 }),
              e => perf.log('info', `prefetch ${t.name}: ${e?.message || e}`));
      located.set(t.name, { location: t.location, bytes: t.bytes, prefetch });
    }
  }


  async function init() {
    warmExtensions();
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

    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([`importScripts("${BLOCKCACHE}");
`, HTTP_TRACE_SHIM, `
importScripts("${ENGINE}duckdb-browser-base.worker.js");`], { type: "text/javascript" }));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
    await db.instantiate(`${ENGINE}duckdb-base.wasm`);
    URL.revokeObjectURL(workerUrl);
    await db.open({ allowUnsignedExtensions: true });
    conn = await db.connect();

    // From the app's own repository (installing needs a home directory). azure_wasm is loaded
    // before the first scan: it claims abfss://, or DuckDB tries to autoload the official azure
    // extension, which has no WASM build. icu is the time zones.
    const pins = await PINS, repo = ENGINE + pins.ext;
    await perf.time('attach', `LOAD ${EXTENSIONS.join(', ')}`, () =>
      q(`SET home_directory = '/tmp'; SET custom_extension_repository = ${lit(repo)};
         SET autoinstall_extension_repository = ${lit(repo)};
         ${EXTENSIONS.map(e => `INSTALL ${e}; LOAD ${e};`).join(' ')}`));
    try { localStorage.setItem(EXT_KEY, pins.ext); } catch (e) {}
    // Iceberg's files never change once written: what DuckDB learnt of one (its size, its
    // Parquet footer) holds for the session. A setting this build lacks is left as it is.
    for (const s of ['SET enable_http_metadata_cache = true', 'SET parquet_metadata_cache = true',
                     "SET validate_external_file_cache = 'NO_VALIDATION'"])
      await q(s).catch(e => perf.log('info', `${s}: ${e?.message || e}`));
    // Brisbane time, for CURRENT_DATE alone (the NEM's day): the tables carry date and time.
    await q("SET TimeZone = 'Australia/Brisbane';");
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
