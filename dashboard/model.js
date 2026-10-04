// =============================================================================
// model.js — the dashboard's semantic layer: dimensions and measures over views.js's views
// =============================================================================
// data.js says where the files are, views.js merges them into the base views; this file
// says what the data means. It wraps a data
// source (same members, plus `needs`) and builds, on top of the source's views, the views
// and macros index.html reads. The page joins nothing: it picks columns from these views,
// filters and groups them.
//   v_unit            DUID, fuel_source, region, state, station, owner, cap_mw, storage_mwh,
//                     renewable, lat, lon, fuel, storage, generator   one row per unit (dim_duid)
//                     (fuel: the name the charts use; fuel_source: as registered, may be NULL;
//                     state: the region's name; renewable: as dim_duid says, the rule is in
//                     the dbt model; storage: a battery; generator: anything else; cap_mw:
//                     registered capacity; storage_mwh: a battery's storage)
//   v_gen             v_scada         + the unit's columns     per unit and 5 minutes
//   v_gen_daily       v_scada_daily   + the unit's columns     per unit and day
//   v_gen_hourly      v_scada_hourly  + the unit's columns     per unit, month and hour of day;
//                                                              once agg carries the table
//   v_gen_today       v_scada_today   + the unit's columns     as v_gen, the newest 14 days
//   v_gen_latest      v_gen_today, the newest interval only
//   v_curtailment     v_curtailment_daily + the unit's columns   per wind/solar farm and day:
//                                                              curtailed_mwh, available_mwh;
//                                                              once agg carries the table
//   v_curtailment_recent  region, date, fuel, curtailed_mwh, available_mwh   the days after
//                     v_curtailment's newest, per region, from AEMO's regional figures in today
//   v_gen_price      v_gen       + price, the price of the unit's region in that interval
//   v_gen_price_daily v_gen_daily + price, the day's
//   v_price_latest    v_price_today, the newest interval only
//   v_region          region                                   the NEM regions
// Measures (macros, worked out at whatever grain the query groups by; how to call each is
// said where it is defined below):
//   generated(v), renewable_share(v, renewable, generator), capture_price(v, price),
//   capacity_factor(mwh, cap, hours)
//   (fuel_name(duid, descr) is this file's own: it names the `fuel` column.)
// The fact views of views.js stay readable as they are: a query that needs nothing about the
// unit reads them and pays for no join.
//   v_scada, v_scada_today   DUID, date, time, mw
//   v_scada_daily            DUID, date, mwh
//   v_scada_hourly           DUID, month, hour, mwh
//   v_price, v_price_today   REGIONID, date, time, price, demand, net_interchange
//                            (v_price_today also wind_available, wind_curtailed,
//                            solar_available, solar_curtailed: MW, the region's semi-scheduled)
//   v_price_daily            REGIONID, date, price, demand, net_interchange, demand_mwh
//   v_price_hourly           REGIONID, month, hour, price, n (the intervals averaged)
//   v_month_days             month, days (the days of the month that have data)
//   v_interconnector         interconnector, date, time, mw, export_limit, import_limit
//   v_calendar               date, year, month (the first date is where the history starts)
//   v_curtailment_daily      DUID, date, curtailed_mwh, available_mwh
//
// What the columns hold, in every view that has them:
//   date, time       NEM time (AEST all year). time is HHMM as a number: 1435 is 14:35, and
//                    the hour is time // 100.
//   mw               MW in that 5 minutes; a battery charging is negative. Energy in MWh is
//                    SUM(mw) / 12. An interval at 0 MW is not stored, so AVG(mw) and COUNT(*)
//                    only see the others: the intervals of a range are counted in v_price.
//   mwh              energy. Daily: the day's, net of charging. Hourly: that hour of the day
//                    over the month, output only (charging is left out).
//   month, hour      the month's first day; hour of day, 0-23. The average MW at an hour over
//                    a range is SUM(mwh) / SUM(v_month_days.days) over its months.
//   price            the regional reference price (AEMO's RRP), $/MWh; in the daily and
//                    hourly views the plain average of the intervals.
//   demand           operational demand in MW: rooftop solar is not in it. Daily: the
//                    average MW, and demand_mwh the day's energy.
//   net_interchange  MW, positive when the region exports.
//   interconnector   mw is positive from the first region in the name to the second
//                    (T-V-MNSP1 > 0: Tasmania to Victoria); export_limit and import_limit
//                    bound it, in the same sign.
//   region, REGIONID NSW1, QLD1, SA1, TAS1, VIC1. v_unit also holds the units of WA1
//                    (Western Australia, another market), which v_region leaves out.
//
// Before a query: a view only holds what is attached, and a query over the rest runs and
// returns the newest days alone, with no error. needs(sql) says what a query reads. The
// 5-minute views (v_gen, v_gen_price, v_scada, v_price, v_interconnector) hold the last 5 days
// (v_interconnector 14) until ensureHistory(from, to) has attached the half-years of the
// range; the daily views hold the last 14 days, and the hourly ones do not exist, until
// attachAgg().
//
// Host-independent: it only reads the views listed at the top of views.js, so a host that
// ships its own data.js keeps this file as it is.
// =============================================================================

// dim_duid holds the units on AEMO's registration list plus the ones in the data that are
// not on it (retired plant, replaced DUIDs). A unit in neither, e.g. one the list hasn't
// caught up with yet, is missing: facts are LEFT JOINed to it so those still count toward
// totals, with the fuel "Unregistered"; units that are in it without a fuel are "Unknown".
export const UNREGISTERED = 'Unregistered';
// 'Rooftop solar' is the fuel of the rooftop pseudo-units (AEMO's regional estimate,
// scripts/cache_catalog.py rooftop_units): QLD_PV, NSW_PV, VIC_PV, SA_PV, TAS_PV, one per
// region, with no capacity and no coordinates. The estimate is half-hourly, drawn as a
// straight line onto the 5-minute intervals.
export const ROOFTOP = 'Rooftop solar';
// Which fuels are renewable is not said here: dim_duid carries a Renewable column (the list
// is in the dbt model, the rooftop units get it in the export). 'Grid' (batteries) is
// storage, on neither side of the renewable share.
const STORAGE_FUEL = 'Grid';

const sqlStr = v => `'${String(v).replace(/'/g, "''")}'`;

const MACROS = [
  // The name a unit's fuel goes by on the page.
  `fuel_name(duid, descr) AS CASE WHEN duid IS NULL THEN ${sqlStr(UNREGISTERED)} ELSE COALESCE(descr, 'Unknown') END`,
  // Output only: a unit that is charging (negative) generates nothing. Given a daily mwh it
  // clips the day's net: a battery counts for its output less its charging, never below 0.
  `generated(v) AS GREATEST(v, 0)`,
  // Renewable share of the output, in %. Takes the raw mw or mwh and the `renewable` and
  // `generator` columns; batteries are in neither the renewables nor the total. A unit
  // missing from dim_duid (renewable NULL) is in the total only. NULL, not 0, when nothing
  // says what is renewable: a dim_duid deployed before the column existed.
  `renewable_share(v, renewable, generator) AS
    100 * SUM(CASE WHEN renewable THEN generated(v) WHEN NOT renewable THEN 0 END)
    / NULLIF(SUM(CASE WHEN generator THEN generated(v) ELSE 0 END), 0)`,
  // The price a volume earned: the prices weighted by it. Takes generated(mw) or
  // generated(mwh), over v_gen_price* with `price IS NOT NULL`: the join there is LEFT, and
  // a volume without a price would count below the line only.
  `capture_price(v, price) AS SUM(v * price) / NULLIF(SUM(v), 0)`,
  // Capacity factor in %: energy over what the registered capacity could make in the hours.
  // Takes one row per unit (its energy in the range, its cap_mw once) and the hours of the
  // range; a unit without a capacity (cap_mw NULL or 0, the rooftop ones) is filtered out
  // first, or its energy counts against no capacity. NULL when the range has no hours.
  `capacity_factor(mwh, cap, hours) AS 100 * SUM(mwh) / NULLIF(SUM(cap) * hours, 0)`,
];

// dim_duid columns that an older deployed file can lack: [column, name here, type].
// The capacity ones came on 2026-10-01, Renewable on 2026-10-04.
const OPTIONAL_UNIT_COLS = [
  ['State', 'state', 'VARCHAR'], ['StationName', 'station', 'VARCHAR'],
  ['Participant', 'owner', 'VARCHAR'], ['RegCapMW', 'cap_mw', 'REAL'],
  ['StorageMWh', 'storage_mwh', 'REAL'], ['Renewable', 'renewable', 'BOOLEAN'],
];

export function createModel(data) {
  // The views of this file, and the unit columns the deployed dim_duid lacks: such a column
  // is still there, reading NULL, and has() says it is not.
  const _views = new Set();
  let _missing = new Set();

  // Creates the views that can exist by now and don't yet, after `first` (the macros), as
  // one query. Each is created once: a view is bound again every time it is read, so it
  // follows views.js rebuilding the views under it. Only one over a table that was not
  // attached yet (v_gen_hourly) has to wait for a later call.
  async function refresh(first = []) {
    const lacks = ([c]) => !data.has('v_duid', c);
    // For speed, seen in EXPLAIN on 2026-10-04: `generator` (not storage) is its own column,
    // `fuel <> 'Grid'`, and the charts that leave storage out filter on it, not on
    // `NOT storage`: with the fuel filter on Grid the optimizer then sees
    // `fuel = 'Grid' AND fuel <> 'Grid'`, selects nothing and reads nothing. It does not see
    // through `NOT (fuel = 'Grid')`. That is why storage is still a rule on the fuel here
    // and not a column of dim_duid like `renewable`, which is read off the unit as it is: a
    // rule written as an IN list in a view runs as a hash join in every query, read or not.
    const cols = (duid, source) => `
      fuel_name(${duid}, ${source}) AS fuel,
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
    if (data.has('v_curtailment_daily')) views.push(['v_curtailment', gen('v_curtailment_daily')]);
    // The days after the newest next-day file, from AEMO's regional 5-minute figures in `today`:
    // per region, fuel and day, the same two measures. No unit, so no DUID.
    if (data.has('v_curtailment_daily') && data.has('v_price_today', 'wind_curtailed')) {
      const fuel = (name, col) => `SELECT REGIONID AS region, date, '${name}' AS fuel,
        SUM(${col}_curtailed) / 12.0 AS curtailed_mwh, SUM(${col}_available) / 12.0 AS available_mwh
        FROM v_price_today WHERE date > (SELECT MAX(date) FROM v_curtailment_daily) GROUP BY ALL`;
      views.push(['v_curtailment_recent', `${fuel('Wind', 'wind')} UNION ALL ${fuel('Solar', 'solar')}`]);
    }

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
      agg: /\bv_(scada|price|gen|gen_price)_(daily|hourly)\b|\bv_month_days\b|\bv_curtailment/i.test(sql),
    }),
  };
}
