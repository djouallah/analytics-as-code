// =============================================================================
// model.js — the dashboard's semantic layer: dimensions and measures over data.js's views
// =============================================================================
// data.js says where the files are; this file says what the data means. It wraps a data
// source (same members, plus `needs`) and builds, on top of the source's views, the views
// and macros index.html reads. The page joins nothing: it picks columns from these views,
// filters and groups them.
//   v_unit            DUID, fuel_source, region, station, owner, cap_mw, storage_mwh, lat, lon,
//                     fuel, renewable, storage, generator      one row per unit (dim_duid)
//                     (fuel: the name the charts use; fuel_source: as registered, may be NULL;
//                     storage: a battery; generator: anything else)
//   v_gen             v_scada         + the unit's columns     5-minute
//   v_gen_daily       v_scada_daily   + the unit's columns
//   v_gen_hourly      v_scada_hourly  + the unit's columns     once agg carries the table
//   v_gen_today       v_scada_today   + the unit's columns
//   v_gen_latest      v_gen_today, the newest interval only
//   v_gen_price       v_gen       + price, the price of the unit's region in that interval
//   v_gen_price_daily v_gen_daily + price, the day's
//   v_price_latest    v_price_today, the newest interval only
//   v_region          region                                   the NEM regions
// Measures (macros, worked out at whatever grain the query groups by):
//   generated(v), renewable_share(v, fuel), capture_price(v, price),
//   capacity_factor(mwh, cap, hours)
// The fact views of data.js (v_scada, v_price, v_interconnector, ...) stay readable as they
// are: a query that needs nothing about the unit reads them and pays for no join.
//
// Host-independent: it only reads the views listed at the top of data.js, so a host that
// ships its own data.js keeps this file as it is.
// =============================================================================

// dim_duid holds the units on AEMO's registration list plus the ones in the data that are
// not on it (retired plant, replaced DUIDs). A unit in neither, e.g. one the list hasn't
// caught up with yet, is missing: facts are LEFT JOINed to it so those still count toward
// totals, with the fuel "Unregistered"; units that are in it without a fuel are "Unknown".
export const UNREGISTERED = 'Unregistered';
// 'Rooftop solar' is the fuel of the rooftop pseudo-units (AEMO's regional estimate,
// scripts/cache_catalog.py rooftop_units).
export const ROOFTOP = 'Rooftop solar';
// Renewable fuels as AEMO describes them. 'Grid' (batteries) is storage: neither side.
const RENEWABLE_FUELS = ['Solar', ROOFTOP, 'Wind', 'Water', 'Bagasse', 'Biogas - sludge',
  'Landfill methane / landfill gas', 'Sewerage / waste water'];
const STORAGE_FUEL = 'Grid';

const sqlStr = v => `'${String(v).replace(/'/g, "''")}'`;

const MACROS = [
  // The name a unit's fuel goes by on the page.
  `fuel_name(duid, descr) AS CASE WHEN duid IS NULL THEN ${sqlStr(UNREGISTERED)} ELSE COALESCE(descr, 'Unknown') END`,
  `is_renewable(fuel) AS fuel IN (${RENEWABLE_FUELS.map(sqlStr).join(',')})`,
  // Output only: a unit that is charging (negative) generates nothing.
  `generated(v) AS GREATEST(v, 0)`,
  // Renewable share of the output, in %.
  `renewable_share(v, fuel) AS 100 * SUM(CASE WHEN is_renewable(fuel) THEN generated(v) ELSE 0 END)
    / NULLIF(SUM(CASE WHEN fuel <> ${sqlStr(STORAGE_FUEL)} THEN generated(v) ELSE 0 END), 0)`,
  // The price a volume earned: the prices weighted by it.
  `capture_price(v, price) AS SUM(v * price) / NULLIF(SUM(v), 0)`,
  // Capacity factor in %: energy over what the registered capacity could make in the hours.
  `capacity_factor(mwh, cap, hours) AS 100 * SUM(mwh) / (SUM(cap) * hours)`,
];

// dim_duid columns that files deployed before 2026-10-01 lack: [column, name here, type].
const OPTIONAL_UNIT_COLS = [
  ['StationName', 'station', 'VARCHAR'], ['Participant', 'owner', 'VARCHAR'],
  ['RegCapMW', 'cap_mw', 'REAL'], ['StorageMWh', 'storage_mwh', 'REAL'],
];

export function createModel(data) {
  // The views of this file, and the unit columns the deployed dim_duid lacks: such a column
  // is still there, reading NULL, and has() says it is not.
  const _views = new Set();
  let _missing = new Set();

  // Creates the views that can exist by now and don't yet, after `first` (the macros), as
  // one query. Each is created once: a view is bound again every time it is read, so it
  // follows data.js rebuilding the views under it. Only one over a table that was not
  // attached yet (v_gen_hourly) has to wait for a later call.
  async function refresh(first = []) {
    const lacks = ([c]) => !data.has('v_duid', c);
    // Two things here are for speed, both seen in EXPLAIN on 2026-10-04:
    // - `renewable` is list_contains(), not is_renewable(): an IN list runs as a hash join,
    //   which a query pays for whether it reads the column or not; a function call is dropped
    //   when the column is not read.
    // - `generator` (not storage) is its own column, `fuel <> 'Grid'`, and the charts that
    //   leave storage out filter on it, not on `NOT storage`: with the fuel filter on Grid
    //   the optimizer then sees `fuel = 'Grid' AND fuel <> 'Grid'`, selects nothing and
    //   reads nothing. It does not see through `NOT (fuel = 'Grid')`.
    const cols = (duid, source) => `
      fuel_name(${duid}, ${source}) AS fuel,
      list_contains([${RENEWABLE_FUELS.map(sqlStr).join(',')}], fuel_name(${duid}, ${source})) AS renewable,
      fuel_name(${duid}, ${source}) = ${sqlStr(STORAGE_FUEL)} AS storage,
      fuel_name(${duid}, ${source}) <> ${sqlStr(STORAGE_FUEL)} AS generator`;
    const unit = `SELECT d.DUID, d.FuelSourceDescriptor AS fuel_source, d.Region AS region,
      ${OPTIONAL_UNIT_COLS.map(o => lacks(o) ? `NULL::${o[2]} AS ${o[1]}` : `d.${o[0]} AS ${o[1]}`).join(', ')},
      d.latitude::DOUBLE AS lat, d.longitude::DOUBLE AS lon,
      ${cols('d.DUID', 'd.FuelSourceDescriptor')}
      FROM v_duid d`;
    // A fact with the unit's columns: a unit missing from dim_duid keeps its rows, with the
    // fuel "Unregistered" (fuel_name of a NULL DUID).
    const gen = fact => `SELECT sc.*, u.fuel_source, u.region,
      ${OPTIONAL_UNIT_COLS.map(o => `u.${o[1]}`).join(', ')}, u.lat, u.lon,
      ${cols('u.DUID', 'u.fuel_source')}
      FROM ${fact} sc LEFT JOIN v_unit u ON sc.DUID = u.DUID`;
    // The rows of `view` at the newest interval of `fact`.
    const latest = (view, fact) => `SELECT * FROM ${view} WHERE date = (SELECT MAX(date) FROM ${fact})
      AND time = (SELECT MAX(time) FROM ${fact} WHERE date = (SELECT MAX(date) FROM ${fact}))`;

    const views = [
      ['v_unit', unit],
      ['v_region', `SELECT DISTINCT Region AS region FROM v_duid WHERE Region IS NOT NULL AND Region != 'WA1'`],
      ['v_gen', gen('v_scada')],
      ['v_gen_daily', gen('v_scada_daily')],
      ['v_gen_today', gen('v_scada_today')],
      ['v_gen_latest', latest('v_gen_today', 'v_scada_today')],
      ['v_price_latest', latest('v_price_today', 'v_price_today')],
      ['v_gen_price', `SELECT g.*, p.price FROM v_gen g
        LEFT JOIN v_price p ON p.date = g.date AND p.time = g.time AND p.REGIONID = g.region`],
      ['v_gen_price_daily', `SELECT g.*, p.price FROM v_gen_daily g
        LEFT JOIN v_price_daily p ON p.date = g.date AND p.REGIONID = g.region`],
    ];
    if (data.has('v_scada_hourly')) views.push(['v_gen_hourly', gen('v_scada_hourly')]);

    const fresh = views.filter(([name]) => !_views.has(name));
    if (!first.length && !fresh.length) return;
    await data.query([...first, ...fresh.map(([name, sql]) => `CREATE OR REPLACE VIEW ${name} AS ${sql}`)].join(';\n'));
    for (const [name] of fresh) _views.add(name);
    _missing = new Set(OPTIONAL_UNIT_COLS.filter(lacks).map(o => o[1]));
  }

  return {
    async init() {
      const res = await data.init();
      await refresh(MACROS.map(macro => `CREATE OR REPLACE MACRO ${macro}`));
      return res;
    },
    async attachAgg() {
      await data.attachAgg();
      await refresh();
    },
    // True if more history was attached: results the caller cached are stale.
    async ensureHistory(from, to, msg) {
      const changed = await data.ensureHistory(from, to, msg);
      await refresh();
      return changed;
    },
    // Whether a view exists and, given a column, whether the deployed files carry it.
    has: (view, column) => _views.has(view) ? !_missing.has(column) : data.has(view, column),
    query: sql => data.query(sql),
    // What a query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the daily and hourly rollups (attachAgg).
    needs: sql => ({
      history: /\bv_(scada|price|interconnector|gen|gen_price)\b/i.test(sql),
      agg: /\bv_(scada|price|gen|gen_price)_(daily|hourly)\b|\bv_month_days\b/i.test(sql),
    }),
  };
}
