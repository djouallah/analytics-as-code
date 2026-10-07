// =============================================================================
// page_queries.mjs — the page's queries, as the page builds them, through the compiler, over
// the deployed files
// =============================================================================
//   cd scripts/parity && npm ci && node page_queries.mjs <data dir> <out.json>
//
// <data dir> holds the files the page attaches (mart_dim, mart_today, mart_agg and the
// half-years mart_<YYYY>_h<N>), as deployed. For a set of page states (a date range, a
// region, a fuel, units picked) every member of frontend/queries.js is called with the
// arguments index.html gives it; each query becomes DAX (toDax) and SQL (toSQL) as in the
// browser, and the SQL runs on the files in native DuckDB. The output holds, per query, the
// DAX, the SQL and the rows: scripts/parity_model.py asks the deployed model the same DAX and
// compares its rows with these. Nothing here decides what the page asks: it is the page's own
// code, run outside the browser.
//
// The states end two days before the newest day the files hold: the files are a copy taken
// at one time and the model reads the live tables, so the days still filling differ. The
// queries that read the newest interval or day are left out for the same reason.
// =============================================================================

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [dataDir, out] = process.argv.slice(2);
if (!dataDir || !out) { console.error('usage: node page_queries.mjs <data dir> <out.json>'); process.exit(2); }

// compiler.js fetches model.bim from next to itself, where the builds copy it.
const bim = JSON.parse(readFileSync(path.join(ROOT, 'semantic_model/model.bim'), 'utf8'));
globalThis.fetch = async url => {
  if (!String(url).includes('model.bim')) throw new Error(`no fetch here: ${url}`);
  return { ok: true, json: async () => bim };
};
const { createModel } = await import(pathToFileURL(path.join(ROOT, 'dashboard/github/semantic/compiler.js')));
const { createQueries } = await import(pathToFileURL(path.join(ROOT, 'dashboard/github/frontend/queries.js')));

// --- The engine: the files attached as data.js attaches them, every half-year at once ---
const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();
const file = name => path.resolve(dataDir, name).replace(/\\/g, '/');
const attach = (name, alias) => conn.run(`ATTACH '${file(name)}' AS ${alias} (READ_ONLY)`);
async function run(sql) {
  let reader;
  for (const s of sql.split(';\n')) reader = await conn.runAndReadAll(s);
  return reader.getRowObjectsJson();
}
const source = {
  async init() {
    await attach('mart_dim.duckdb', 'dim');
    await attach('mart_today.duckdb', 'today');
    for (const f of readdirSync(dataDir).filter(f => /^mart_\d{4}_h[12]\.duckdb$/.test(f)))
      await attach(f, `p${f.slice(5, 12)}`);
  },
  attachAgg: () => attach('mart_agg.duckdb', 'agg'),
  ensureHistory: async () => false,
  query: async sql => { const rows = await run(sql); return { toArray: () => rows }; },
};
const model = createModel(source);
await model.init();
await model.attachAgg();
const rows = q => run(model.toSQL(model.toDax(q)));

// --- The page's state, as index.html gives it to createQueries ---
const UNKNOWN = 'Unknown', ROOFTOP = 'Rooftop solar';
const fuelName = fuel => fuel ?? UNKNOWN;
const shiftDate = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const allDuids = (await rows({ select: { DUID: 'dim_duid.DUID', Region: 'dim_duid.Region', fuel: 'dim_duid.FuelSourceDescriptor' }, orderBy: ['DUID'] }))
  .map(d => ({ ...d, fuel: fuelName(d.fuel) }));
const [{ d: newest }] = await rows({ select: { d: { max: 'fct_summary.date' } } });
const [{ d: oldest }] = await rows({ select: { d: { min: 'dim_calendar.date' } } });
const to = shiftDate(newest, -2);
let state;
const queries = createQueries({
  range: () => state.range, intraday: () => days(state.range) <= 30, region: () => state.region,
  fuel: () => state.fuel, picked: () => state.picked, units: () => allDuids, newestDate: () => newest,
  shiftDate, UNKNOWN, ROOFTOP });
const days = ({ from, to }) => Math.round((new Date(to) - new Date(from)) / 86400000);
await queries.readWholeDays(rows);

const RANGES = { '3 days': shiftDate(to, -2), '30 days': shiftDate(to, -30), '1 year': shiftDate(to, -365) };
const FILTERS = { all: {}, 'region SA1': { region: 'SA1' }, 'fuel Wind': { fuel: 'Wind' },
  'units HPR1 BALDHWF1': { picked: ['HPR1', 'BALDHWF1'] } };

// What each chart asks in a state, with the arguments index.html passes.
function asked() {
  const intraday = days(state.range) <= 30, { from } = state.range;
  // The KPI deltas' span, as renderDeltas works it out.
  const last = state.range.to >= newest ? shiftDate(newest, -1) : state.range.to;
  const n = Math.round((new Date(last) - new Date(from)) / 86400000) + 1;
  const span = { from, prevFrom: shiftDate(from, -n), last };
  const now = { date: state.range.to, time: 1200 };
  const list = {
    'generation fuel': queries.generation('fuel', intraday),
    'generation duid': queries.generation('duid', intraday),
    'generation station': queries.generation('station', intraday),
    'averages fuel': queries.averages('fuel'),
    'averages station': queries.averages('station'),
    demand: queries.demand(intraday),
    price: queries.price(intraday),
    averagePrice: queries.averagePrice(),
    generatorCount: queries.generatorCount(),
    emissions: queries.emissions(intraday),
    renewableShareByPeriod: queries.renewableShareByPeriod(intraday),
    renewableShareOfRange: queries.renewableShareOfRange(),
    nowByFuel: queries.nowByFuel(now, state.region),
    nowShare: queries.nowShare(now, state.region),
    nowByRegion: queries.nowByRegion(now.date, now.time),
    mapScatter: queries.mapScatter(),
    profile: queries.profile(intraday),
    curtailment: queries.curtailment(days(state.range) > 120),
    curtailmentTotal: queries.curtailmentTotal(),
    curtailedFarms: queries.curtailedFarms(),
    heatmap: queries.heatmap(intraday),
    capture: queries.capture(),
    negativePrices: queries.negativePrices(intraday),
    netExports: queries.netExports(intraday),
    capacityFactor: queries.capacityFactor(),
    owners: queries.owners(),
    historyShare: queries.historyShare(),
    historyEnergy: queries.historyEnergy(),
    historyPrice: queries.historyPrice(),
  };
  if (!intraday) list.profileMonths = queries.profileMonths();
  if (span.prevFrom >= oldest)
    for (const k of ['deltaGeneration', 'deltaPrice', 'deltaRenewables', 'deltaEmissions'])
      queries[k](span).forEach((q, i) => { list[`${k} side ${1 - i}`] = q; });
  // Flows and Batteries draw up to 30 days.
  if (intraday) Object.assign(list, {
    batteryDay: queries.batteryDay(), batterySpread: queries.batterySpread(), batteryFleet: queries.batteryFleet(),
    flowGens: queries.flowGens(state.range.to), flows: queries.flows(state.range.from, state.range.to),
    flowPrices: queries.flowPrices(state.range.from, state.range.to) });
  return list;
}

// The columns a row is matched on: the select's columns and the totals' flags.
const keysOf = q => [...Object.entries(q.select).filter(([, f]) => typeof f === 'string' && f.includes('.')).map(([n]) => n),
  ...Object.keys(q.totals ?? {})];

const MAX_ROWS = 20000;
const results = [], seen = new Map();
const add = async (stateName, name, q) => {
  const dax = model.toDax(q);
  if (seen.has(dax)) { seen.get(dax).states.push(stateName); return; }
  const entry = { name, states: [stateName], keys: keysOf(q), dax };
  try {
    entry.sql = model.toSQL(dax);
    const found = await run(entry.sql);
    // The model answers at most 100,000 rows to a query (Power BI's limit for executeQueries,
    // and plenty to hold over XMLA): a bigger result is counted, not compared.
    if (found.length > MAX_ROWS) entry.rowCount = found.length; else entry.rows = found;
  } catch (e) { entry.error = String(e.message ?? e); }
  seen.set(dax, entry);
  results.push(entry);
};
for (const [n, q] of Object.entries({ regions: queries.regions, regionNames: queries.regionNames, fuels: queries.fuels,
  allDuids: queries.allDuids, oldestDate: queries.oldestDate, flowUnits: queries.flowUnits,
  interconnectors: queries.interconnectors, stationUnits: queries.stationUnits('Hornsdale Wind Farm') }))
  await add('lists', n, q);
for (const [r, from] of Object.entries(RANGES))
  for (const [f, filters] of Object.entries(FILTERS)) {
    state = { range: { from, to }, region: null, fuel: null, picked: [], ...filters };
    for (const [n, q] of Object.entries(asked())) await add(`${r}, ${f}`, n, q);
  }
writeFileSync(out, JSON.stringify({ newest, to, queries: results }, null, 1));
console.log(`${results.length} distinct queries, ${results.filter(r => r.error).length} failed in DuckDB; newest day ${newest}, states end ${to}`);
