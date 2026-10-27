// =============================================================================
// data.js — DataSource: the catalog's tables, read in place by DuckDB-WASM
// =============================================================================
// The Iceberg backend of the Fabric app. Its inputs are the semantic model and a OneLake
// Iceberg catalog, nothing else: no import, no file written for it. The model names the
// tables (an Ossie dataset's `source`, or a TMSL table's Direct Lake partition: schema.table);
// the function says where each one is now and signs a read-only SAS (catalog.js); DuckDB-WASM
// reads them with the `iceberg` extension and `azure_wasm` (a community extension: abfss://
// paths to https with the SAS, as the official `azure` extension has no WASM build).
//
// Nothing is stored: a view v_<table> per table over iceberg_scan, at the snapshot the
// catalog named (catalog.js keeps that answer up to ~55 minutes, so a reload within it reads
// the same snapshots and calls no function). A query reads the files it needs from OneLake; DuckDB
// keeps what it read for the session.
//
// The members are the ones the page calls on the other hosts:
//   init            sign in, locate the tables, create the views
//   attachAgg, ensureHistory   nothing to attach: every view reads its table whole
//   query, views, has, needs
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";
import { serialQueue } from "./queue.js";
import { createAuth } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { perf, HTTP_TRACE_SHIM } from "../frontend/perflog.js";

const MODEL = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);

// The model's tables: name -> schema.table. Ossie: a dataset's `source`. TMSL (model.bim):
// a table's Direct Lake partition.
function modelTables(model) {
  const out = new Map();
  for (const d of model.datasets ?? []) if (d.source) out.set(d.name, d.source);
  for (const t of (model.model ?? model).tables ?? []) {
    const s = t.partitions?.[0]?.source;
    if (s?.entityName) out.set(t.name, `${s.schemaName ?? 'dbo'}.${s.entityName}`);
  }
  return out;
}

const ident = s => `"${String(s).replace(/"/g, '""')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;

export function createDataSource({ onStatus = () => {} } = {}) {
  const catalog = createCatalog(() => auth.client());
  // A kept answer from the function needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: catalog.fresh });
  let conn;
  let _views = new Map();   // view name -> Set of columns

  const serial = serialQueue();
  const q = sql => serial(() => conn.query(sql));
  const rows = async sql => (await q(sql)).toArray().map(r => r.toJSON());

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

  async function init() {
    await auth.signIn();
    onStatus("Loading DuckDB WASM...");
    const model = fetch(MODEL).then(r => r.json());

    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM times the worker's own requests for the Logs tab.
      new Blob([HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();

    const tables = modelTables(await model);
    onStatus('Locating the tables in the catalog...');
    const sources = [...new Set(tables.values())];
    const access = await catalog.open(sources);

    // azure_wasm installs from the community repository, which needs a home directory; it is
    // loaded before the first scan: it claims abfss://, or DuckDB tries to autoload the
    // official azure extension, which has no WASM build.
    await perf.time('attach', 'LOAD httpfs, avro, iceberg, azure_wasm', () =>
      q(`SET home_directory = '/tmp'; INSTALL httpfs; LOAD httpfs; INSTALL avro; LOAD avro;
         INSTALL iceberg; LOAD iceberg; INSTALL azure_wasm FROM community; LOAD azure_wasm;`));
    await useSas(access.sas);
    renewLater(sources);

    // A view per table the catalog has. Creating it reads the table's metadata (a few
    // requests); a table that fails is left out, and the page shows no data where it reads it.
    onStatus('Opening the tables...');
    for (const [name, source] of tables) {
      const location = access.metadata[source];
      if (!location) continue;
      await perf.time('attach', `VIEW v_${name} over ${source}`, () =>
        q(`CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM iceberg_scan(${lit(location)})`)).catch(() => {});
    }
    const cols = await rows(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_name LIKE 'v\\_%' ESCAPE '\\'`);
    for (const { t, c } of cols) (_views.get(t) ?? _views.set(t, new Set()).get(t)).add(c);

    // Brisbane time, for CURRENT_DATE alone (the NEM's day): the tables carry date and time.
    await q("SET TimeZone = 'Australia/Brisbane';");
    await q("SET preserve_insertion_order = false;");
    return { db };
  }

  return {
    init,
    attachAgg: async () => false,
    ensureHistory: async () => false,
    // `dax`: the query as the page wrote it, for the Logs tab (the compiler passes it).
    // `options`: the page's for the queue (queue.js): `stale`, `early`, `later`.
    query: (sql, dax, options) => perf.query(sql, () => serial(() => conn.query(sql), options), dax),
    views: () => [..._views].map(([name, cols]) => ({ name, columns: [...cols] })),
    has: (name, column) => { const v = _views.get(name); return !!v && (!column || v.has(column)); },
    // Every view reads its table whole: a query needs nothing attached.
    needs: () => ({ history: false, agg: false }),
  };
}
