// =============================================================================
// views.js — the base views over the attached .duckdb files
// =============================================================================
// The same file for every host. A host's data.js fetches and attaches the databases (`dim`,
// `today`, `agg`, and the 5-minute history however it stores it), then calls refresh() with
// what is attached by now. model.js and index.html read these views, never an attached table:
//   v_scada           DUID, date, time, mw                                        5-minute
//   v_price           REGIONID, date, time, price, demand, net_interchange        5-minute
//   v_scada_daily     DUID, date, mwh
//   v_price_daily     REGIONID, date, price, demand, net_interchange, demand_mwh
//   v_interconnector  interconnector, date, time, mw, export_limit, import_limit  5-minute
//   v_scada_today     DUID, date, time, mw             the newest days, for "latest interval"
//   v_price_today     REGIONID, date, time, price, demand, net_interchange, wind_available,
//                     wind_curtailed, solar_available, solar_curtailed
//   v_duid            dim_duid, under the names the    has(view, column) says whether a
//                     export gives its columns         deployed file carries a newer column
//   v_calendar        dim_calendar: date, year, month
//   v_scada_hourly, v_price_hourly, v_month_days       agg's hour-of-day x month tables;
//                                                      absent (has(view) false) until agg is
//                                                      attached and deployed with them
//   v_curtailment_daily  DUID, date, curtailed_mwh, available_mwh   agg's, the same way:
//                     semi-scheduled units, per day, up to the newest complete next-day file
// =============================================================================

// SQL date: rows from this day on are read from `today`, older ones from history / agg.
// CURRENT_DATE is the NEM's day: the host sets the session to Brisbane time for it.
export const RECENT_CUT = 'CURRENT_DATE - INTERVAL 5 DAY';

// `query` runs SQL on the host's connection.
export function createViews(query) {
  // Columns of each attached table (`<db>.<table>`) and of each view (plain name), read at
  // both ends of refresh. Files deployed before 2026-10-02 have no demand/net_interchange
  // (and agg no hourly tables); a column a file lacks reads as NULL, which the charts show as
  // "no data", never as a number.
  let _columns = new Map();
  async function loadColumns() {
    const r = await query(`SELECT CASE WHEN table_catalog = current_database() THEN table_name
        ELSE table_catalog || '.' || table_name END AS t, column_name AS c
      FROM information_schema.columns`);
    _columns = new Map();
    for (const { t, c } of r.toArray()) {
      if (!_columns.has(t)) _columns.set(t, new Set());
      _columns.get(t).add(c);
    }
  }
  const hasTable = t => _columns.has(t);
  const colOrNull = (t, c, expr = c, alias = c) => _columns.get(t)?.has(c) ? `${expr} AS ${alias}` : `NULL::REAL AS ${alias}`;

  // The views every query reads. The days from RECENT_CUT on come from `today` (refreshed
  // intraday), everything older from the attached history databases (5-min) or agg (daily).
  // `history`: the aliases of the attached databases that hold the 5-minute history (tables
  // scada, price, interconnector). Until `agg` is attached, the daily views only cover `today`.
  async function refresh({ history = [], agg = false } = {}) {
    await loadColumns();
    const OLD = `date < ${RECENT_CUT}`, RECENT = `date >= ${RECENT_CUT}`;
    const raw = (cols, table, extra = []) => [
      ...history.map(db => [db, table]), ['today', `${table}_today`],
    ].map(([db, t]) => `SELECT ${[cols, ...extra.map(c => colOrNull(`${db}.${t}`, c))].join(', ')}
        FROM ${db}.${t} WHERE ${db === 'today' ? RECENT : OLD}`).join(' UNION ALL ');
    const daily = (aggSql, todaySql) => agg
      ? `${aggSql} WHERE ${OLD} UNION ALL ${todaySql} WHERE ${RECENT} GROUP BY ALL`
      : `${todaySql} GROUP BY ALL`;
    const DEMAND_COLS = ['demand', 'net_interchange'];

    await query(`CREATE OR REPLACE VIEW v_scada AS ${raw('DUID, date, time, mw', 'scada')}`);
    await query(`CREATE OR REPLACE VIEW v_price AS ${raw('REGIONID, date, time, price', 'price', DEMAND_COLS)}`);
    await query(`CREATE OR REPLACE VIEW v_scada_daily AS ${daily(
      'SELECT DUID, date, mwh FROM agg.scada_daily',
      'SELECT DUID, date, CAST(SUM(mw) / 12.0 AS REAL) AS mwh FROM today.scada_today')}`);
    // Daily demand/net_interchange are average MW; demand_mwh is the day's energy (a whole
    // day in agg, the intervals so far today, like v_scada_daily.mwh). A day from `today`
    // with any interval missing demand (fct_regionsum_today still filling) stays NULL.
    const complete = (c, agg) => `CASE WHEN COUNT(${c}) = COUNT(*) THEN ${agg} END`;
    await query(`CREATE OR REPLACE VIEW v_price_daily AS ${daily(
      `SELECT REGIONID, date, price, ${DEMAND_COLS.map(c => colOrNull('agg.price_daily', c)).join(', ')},
        ${colOrNull('agg.price_daily', 'demand', 'demand * 24', 'demand_mwh')}
        FROM agg.price_daily`,
      `SELECT REGIONID, date, CAST(AVG(price) AS REAL) AS price,
        ${DEMAND_COLS.map(c => colOrNull('today.price_today', c, `CAST(${complete(c, `AVG(${c})`)} AS REAL)`)).join(', ')},
        ${colOrNull('today.price_today', 'demand', complete('demand', 'SUM(demand) / 12.0'), 'demand_mwh')}
        FROM today.price_today`)}`);
    // Link flows: the history files carry them back to 2018 (files built before
    // 2026-10-03 have no such table), `today` the last 14 days. `today` supplies whatever
    // is newer than the attached files hold, so a file without the table, or a daily
    // import that is behind, leaves no hole in the last 14 days.
    const FLOW_COLS = 'interconnector, date, time, mw, export_limit, import_limit';
    const flowPeriods = history.filter(db => hasTable(`${db}.interconnector`))
      .map(db => `SELECT ${FLOW_COLS} FROM ${db}.interconnector WHERE ${OLD}`).join(' UNION ALL ');
    const flowToday = hasTable('today.interconnector_today')
      ? `SELECT ${FLOW_COLS} FROM today.interconnector_today`
      : `SELECT NULL::VARCHAR AS interconnector, NULL::DATE AS date, NULL::SMALLINT AS time,
          NULL::REAL AS mw, NULL::REAL AS export_limit, NULL::REAL AS import_limit WHERE false`;
    await query(`CREATE OR REPLACE VIEW v_interconnector AS ${flowPeriods
      ? `${flowPeriods} UNION ALL SELECT * FROM (${flowToday})
          WHERE date > (SELECT COALESCE(MAX(date), DATE '1900-01-01') FROM (${flowPeriods}))`
      : flowToday}`);
    // The tables the page reads as they are. A table a deployed file lacks gets no view.
    for (const [view, table] of [
      ['v_duid', 'dim.dim_duid'], ['v_calendar', 'dim.dim_calendar'],
      ['v_scada_today', 'today.scada_today'], ['v_price_today', 'today.price_today'],
      ['v_scada_hourly', 'agg.scada_hourly'], ['v_price_hourly', 'agg.price_hourly'],
      ['v_month_days', 'agg.month_days'], ['v_curtailment_daily', 'agg.curtailment_daily'],
    ]) if (hasTable(table)) await query(`CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${table}`);
    await loadColumns();
  }

  return {
    refresh,
    // Whether a view exists and, given a column, whether it has it.
    has: (view, column) => column ? !!_columns.get(view)?.has(column) : _columns.has(view),
  };
}
