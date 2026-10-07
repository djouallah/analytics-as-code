// =============================================================================
// page_states.mjs — a page run outside the browser: the deployed files attached as data.js
// attaches them, the page's state as index.html gives it, and what each chart asks in it
// =============================================================================
// Shared by page_queries.mjs (the DAX page's queries, through the compiler) and sql_page.mjs
// (the SQL page's, in SQL, against the DAX page's).
// =============================================================================

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

export const UNKNOWN = 'Unknown', ROOFTOP = 'Rooftop solar';
export const shiftDate = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const days = ({ from, to }) => Math.round((new Date(to) - new Date(from)) / 86400000);

// --- The engine: the files of <dataDir> attached as data.js attaches them, every half-year
// at once. `source` has data.js's members (before views.js wraps them); `run` runs SQL.
export async function engine(dataDir) {
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
  return { run, source };
}

// --- The page's state, as index.html gives it to createQueries ---
// The states end two days before the newest day the files hold (`to`).
export function pageOf(createQueries, newest) {
  let state;
  const queries = createQueries({
    range: () => state.range, intraday: () => days(state.range) <= 30, region: () => state.region,
    fuel: () => state.fuel, picked: () => state.picked, newestDate: () => newest,
    shiftDate, UNKNOWN, ROOFTOP });
  return { queries, set: s => { state = s; }, get state() { return state; } };
}

// Every state: three ranges by five filters. The last sets two unit filters that no unit
// passes together (HPR1 is registered as Wind, BALDHWF1 is Wind): a regional query reads the
// regions of the units that pass both, none, not the regions of the units that pass each
// (2026-10-07).
export function states(to) {
  const RANGES = { '3 days': shiftDate(to, -2), '30 days': shiftDate(to, -30), '1 year': shiftDate(to, -365) };
  const FILTERS = { all: {}, 'region SA1': { region: 'SA1' }, 'fuel Wind': { fuel: 'Wind' },
    'units HPR1 BALDHWF1': { picked: ['HPR1', 'BALDHWF1'] },
    'fuel Solar, units HPR1 BALDHWF1': { fuel: 'Solar', picked: ['HPR1', 'BALDHWF1'] } };
  return Object.entries(RANGES).flatMap(([r, from]) => Object.entries(FILTERS).map(([f, filters]) =>
    [`${r}, ${f}`, { range: { from, to }, region: null, fuel: null, picked: [], ...filters }]));
}

// The queries that depend on no state: the filter lists.
export const lists = queries => ({ regions: queries.regions, regionNames: queries.regionNames, fuels: queries.fuels,
  allDuids: queries.allDuids, oldestDate: queries.oldestDate, flowUnits: queries.flowUnits,
  interconnectors: queries.interconnectors, stationUnits: queries.stationUnits('Hornsdale Power Reserve') });

// What each chart asks in a state, with the arguments index.html passes.
export function asked(queries, state) {
  const intraday = days(state.range) <= 30;
  const now = { date: state.range.to, time: 1200 };
  const list = {
    'generation fuel': queries.generation('fuel', intraday),
    'generation duid': queries.generation('duid', intraday),
    'generation station': queries.generation('station', intraday),
    'generationNotOf duid': queries.generationNotOf('duid', intraday, ['HPR1', 'BALDHWF1']),
    'generationOf fuel': queries.generationOf('fuel', intraday, ['Diesel', 'Unknown']),
    'averages fuel': queries.averages('fuel'),
    'averages station': queries.averages('station'),
    generationAverage: queries.generationAverage(),
    demand: queries.demand(intraday),
    demandPeak: queries.demandPeak(intraday),
    price: queries.price(intraday),
    averagePrice: queries.averagePrice(),
    generatorCount: queries.generatorCount(),
    emissions: queries.emissions(intraday),
    renewableShareByPeriod: queries.renewableShareByPeriod(intraday),
    renewableShareOfRange: queries.renewableShareOfRange(),
    nowByFuel: queries.nowByFuel(now, state.region),
    nowShare: queries.nowShare(now, state.region),
    nowOf: queries.nowOf(now, state.region, ['Diesel', 'Unknown']),
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
    ownerShares: queries.ownerShares(),
    historyShare: queries.historyShare(),
    historySolar: queries.historySolar(),
    historyWind: queries.historyWind(),
    historyPrice: queries.historyPrice(),
    changeGeneration: queries.changeGeneration(),
    changePrice: queries.changePrice(),
    changeRenewables: queries.changeRenewables(),
    changeEmissions: queries.changeEmissions(),
  };
  if (!intraday) list.profileMonths = queries.profileMonths();
  // Flows and Batteries draw up to 30 days.
  if (intraday) Object.assign(list, {
    batteryDay: queries.batteryDay(), batterySpread: queries.batterySpread(), batteryFleet: queries.batteryFleet(),
    flowGens: queries.flowGens(state.range.to), flowNow: queries.flowNow(state.range.to),
    flows: queries.flows(state.range.from, state.range.to), flowPrices: queries.flowPrices(state.range.from, state.range.to) });
  return list;
}

// The columns a row of a DAX page's query is matched on: the select's columns and the
// totals' flags.
export const keysOf = q => [...Object.entries(q.select).filter(([, f]) => typeof f === 'string' && f.includes('.')).map(([n]) => n),
  ...Object.keys(q.totals ?? {})];
