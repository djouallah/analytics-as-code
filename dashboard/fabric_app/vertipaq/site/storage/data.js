// =============================================================================
// data.js — DataSource: the deployed semantic model, queried in DAX
// =============================================================================
// The VertiPaq backend of the Fabric app. The page's queries go to the semantic model `nem`
// (semantic_model/, deployed by deploy_model.yml) as the DAX the compiler writes for them
// (`engine: 'dax'`: ../semantic/query.js stops at toDax), and Power BI runs it: the engine
// is VertiPaq, in Direct Lake over the `mart` tables. Nothing is downloaded or attached, and
// there is no SQL on this host: no DuckDB, no data files.
//
// How it reaches the model: the app's `nem` connector (rayfin/rayfin.yml, type
// fabric-semanticmodel). The browser calls the Fabric app's backend, which runs the query on
// the model as the signed-in user; the browser holds no Power BI token. So a reader sees what
// their own access to the model allows.
//
// The members are the ones the page calls on the other hosts, so index.html is the same file:
//   init            sign in (./auth.js, fabric_app/common's, shared with the other Fabric app)
//   query(dax)      run it; what comes back has the shape the page reads from DuckDB
//   attachAgg, ensureHistory   nothing to attach: the model holds every table
//   has             every table and column the page asks about is in the model
// There is no `needs`: it is what the Analyze tab (SQL) asks, and its absence is how the page
// knows to leave that tab out.
// =============================================================================

import { createAuth } from "./auth.js";
import { perf } from "../frontend/perflog.js";

// The same version as the SDK in auth.js.
const CONNECTOR_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-connector-fabric-semanticmodel@1.36.1/+esm";
const MODEL = "nem";   // the connector's name in rayfin/rayfin.yml

// A result as the page reads one. Power BI names a column `table[column]` or `[alias]`; the
// page asks for the bare name. A date comes back as a date and time with no zone
// ("2026-10-01T00:00:00.000"); the page wants the day. Whole numbers and decimals are
// already numbers (the connector's decoder), a blank is null.
const MIDNIGHT = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?$/;
const value = v => typeof v === "string" && MIDNIGHT.test(v) ? v.slice(0, 10) : v;
function table({ columns, rows }) {
  const names = columns.map(c => /\[([^\]]*)\]$/.exec(c.name)?.[1] ?? c.name);
  return {
    numRows: rows.length,
    schema: { fields: names.map(name => ({ name })) },
    getChild(name) {
      const j = names.indexOf(name), values = rows.map(r => value(r[j]));
      return { length: values.length, nullCount: 0, get: i => values[i], toArray: () => values };
    },
  };
}

export function createDataSource({ onStatus = () => {} } = {}) {
  const auth = createAuth({
    client: async (rayfin, config) => {
      const { fabricSemanticModel } = await import(CONNECTOR_ESM);
      // The second argument decodes the connector's answer (an Arrow stream).
      return new rayfin.ConnectorsRayfinClient(
        { ...config, connectors: { [MODEL]: { connector: "fabric-semanticmodel" } } },
        { [MODEL]: fabricSemanticModel() });
    },
  });
  let model;   // set by init()

  async function init() {
    await auth.signIn();
    onStatus("Connecting to the semantic model...");
    model = (await auth.client()).connectors[MODEL];
    return { db: null };
  }

  // A failure comes back as a result, not as a rejection: a DAX error, a refusal by the
  // service, a result over a row limit.
  async function run(dax) {
    const r = await model.executeQuery({ query: dax });
    if (r.status !== "success") throw new Error(`${r.error.category}: ${r.error.message}`);
    return table(r.table);
  }

  return {
    engine: "dax",
    init,
    attachAgg: async () => {},
    ensureHistory: async () => false,
    has: () => true,
    query: dax => perf.query(dax, () => run(dax)),
  };
}
