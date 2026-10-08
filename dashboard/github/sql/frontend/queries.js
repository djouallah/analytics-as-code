// =============================================================================
// queries.js — what each chart of the page asks DuckDB, in SQL
// =============================================================================
// The same members as ../../dax/frontend/queries.js, called the same way by the same
// index.html, and each returns one SELECT over the views of the attached files (v_<table>,
// common/storage/views.js): no semantic model, no DAX. A figure is written in SQL where a chart
// uses it; one that grows complicated becomes a column or a table in dbt, not page code.
// The joins are written out: `s` is the units' fact, `d` dim_duid, `r` a regional fact.
// The rows come back as the DAX page gets them: a date as text, a time as a whole
// number, a figure as a DOUBLE, a subtotal row flagged by a column of its own.
//
// What a date range reads: the 5-minute tables (fct_summary, fct_region) up to 30 days, the
// daily ones beyond (fct_summary_daily, fct_region_daily), cut to the days both daily tables
// hold (wholeDays): a day still filling is in the 5-minute tables only. A chart draws MW at
// 5 minutes and MWh a day.
// A filter on the units (region, fuel, units picked) reaches a regional table as the regions
// those units are in.
//
// createQueries(page) takes what the page's state is, as functions: range() { from, to },
// intraday(), region(), fuel(), picked() (the units picked), newestDate(), shiftDate(date, n),
// and the names UNKNOWN and ROOFTOP.
// connect(data) is what runs them: the data source as it is, its SQL run as written. The
// page is served in a folder of the site, sql/, and reads the site's files, one folder up.
// =============================================================================

export const connect = data => ({ ...data, init: () => data.init({ base: '../' }) });

export function createQueries(page) {
  const { UNKNOWN, ROOFTOP, shiftDate } = page;

  // --- SQL pieces ---
  const str = v => `'${String(v).replace(/'/g, "''")}'`;
  const day = v => `DATE ${str(v)}`;
  const list = vs => `(${vs.map(str).join(', ')})`;
  const where = conds => conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const between = (col, from, to) => `${col} BETWEEN ${day(from)} AND ${day(to)}`;
  // A units' table, joined to dim_duid when the query reads a column of it.
  const units = (table, ...sql) => `${table} s${/\bd\./.test(sql.join(' ')) ? ' LEFT JOIN v_dim_duid d ON d.DUID = s.DUID' : ''}`;
  // The date (and time) of a table as keys: what they are grouped by, selected and ordered.
  const at = (alias, intraday) => intraday
    ? { group: `${alias}.date, ${alias}.time`, select: `CAST(${alias}.date AS VARCHAR) AS date, CAST(${alias}.time AS INTEGER) AS time`, order: 'date, time' }
    : { group: `${alias}.date`, select: `CAST(${alias}.date AS VARCHAR) AS date`, order: 'date' };

  // --- The units' figures at a grain ---
  // At 5 minutes from fct_summary (MW, with the region's price on the row), a day from
  // fct_summary_daily (its sums). `mwh(cond)` is the energy of the rows that pass `cond`.
  const OUT = 'GREATEST(CAST(s.mw AS DOUBLE), 0)', IN = 'LEAST(CAST(s.mw AS DOUBLE), 0)';
  const filtered = cond => cond ? ` FILTER (WHERE ${cond})` : '';
  const FIVE = {
    units: 'v_fct_summary', regions: 'v_fct_region',
    output: `SUM(${OUT})`, charging: `SUM(${IN})`,
    mwh: cond => `SUM(${OUT})${filtered(cond)} / 12`,
    revenue: `SUM(${OUT} * s.price) / 12`,
    emissions: `SUM(${OUT} * d.CO2eFactor) / 12`,
    average: 'AVG(s.mw)',
  };
  const DAILY = {
    units: 'v_fct_summary_daily', regions: 'v_fct_region_daily',
    output: 'SUM(s.output_mwh)', charging: 'SUM(s.charging_mwh)',
    mwh: cond => `SUM(s.output_mwh)${filtered(cond)}`,
    revenue: 'SUM(s.revenue)',
    emissions: 'SUM(s.output_mwh * d.CO2eFactor)',
    average: 'AVG(s.output_mwh)',
  };
  const grain = () => page.intraday() ? FIVE : DAILY;
  // The renewable share of the generators' output.
  const renewableShare = g => `100 * COALESCE(${g.mwh('d.Renewable = TRUE')}, 0) / NULLIF(${g.mwh('d.Storage = FALSE')}, 0)`;

  // --- Filters ---
  const FUEL = 'd.FuelSourceDescriptor';
  const fuelIs = fuel => fuel === UNKNOWN ? `${FUEL} IS NULL` : `${FUEL} = ${str(fuel)}`;
  const fuelsIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN), blank = fuels.includes(UNKNOWN);
    const isIn = named.length ? `${FUEL} IN ${list(named)}` : null;
    return blank ? `(${[`${FUEL} IS NULL`, ...(isIn ? [isIn] : [])].join(' OR ')})` : isIn;
  };
  const fuelsNotIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN);
    return [...(named.length ? [`(${FUEL} NOT IN ${list(named)} OR ${FUEL} IS NULL)`] : []),
      ...(fuels.includes(UNKNOWN) ? [`${FUEL} IS NOT NULL`] : [])];
  };

  // The days the daily tables hold, `units` (fct_summary_daily) and `regions`
  // (fct_region_daily), read once the aggregates are attached (readWholeDays).
  let wholeDaysHeld = null;
  // The dates of the range at the grain, for the units' or the regions' table.
  const range = which => {
    const { from, to } = page.range();
    return page.intraday() ? { first: from, last: to } : queries.wholeDaysRange(which, from, to);
  };
  const dates = (alias, which) => { const { first, last } = range(which); return between(`${alias}.date`, first, last); };

  // The header's filters on the units: their region and fuel on dim_duid, the units picked.
  const unitFilters = (alias, withFuel = true) => {
    const region = page.region(), fuel = withFuel ? page.fuel() : null, picked = page.picked();
    return [...(region ? [`d.Region = ${str(region)}`] : []), ...(fuel ? [fuelIs(fuel)] : []),
      ...(picked.length ? [`${alias}.DUID IN ${list(picked)}`] : [])];
  };
  const whereGen = ({ withFuel = true } = {}) => [dates('s', 'units'), ...unitFilters('s', withFuel)];
  // A regional table under the region filter, and under conditions on dim_duid as the regions
  // of the units that pass them.
  const regionsOf = (col, duid) => duid.length ? [`${col} IN (SELECT d.Region FROM v_dim_duid d ${where(duid)})`] : [];
  const regionFilters = (col, duid) => [...(page.region() ? [`${col} = ${str(page.region())}`] : []), ...regionsOf(col, duid)];
  // The fuel and the units picked, as conditions on dim_duid.
  const pickedUnits = (withFuel = true) => {
    const fuel = withFuel ? page.fuel() : null, picked = page.picked();
    return [...(fuel ? [fuelIs(fuel)] : []), ...(picked.length ? [`d.DUID IN ${list(picked)}`] : [])];
  };
  const wherePrice = alias => [dates(alias, 'regions'), ...regionFilters(`${alias}.REGIONID`, pickedUnits())];

  // The hours the regions' data holds for the dates from..to (SQL dates), under the region
  // filter and conditions on dim_duid: what an average MW divides by.
  const hours = (from, to, duid, intraday = page.intraday()) => intraday
    ? `(SELECT COUNT(DISTINCT (r.date, r.time)) / 12 FROM v_fct_region r ${where([`r.date BETWEEN ${from} AND ${to}`, ...regionFilters('r.REGIONID', duid)])})`
    : `(SELECT 24 * COUNT(DISTINCT r.date) FROM v_fct_region_daily r ${where([`r.date BETWEEN ${from} AND ${to}`, ...regionFilters('r.REGIONID', duid)])})`;
  // The conditions on dim_duid of a figure over the units and the regions: the fuel, and
  // beyond 30 days the units picked (up to 30 days a pick is on fct_summary's own DUID,
  // which does not reach the regions).
  const duidOfAll = (withFuel = true) => {
    const fuel = withFuel ? page.fuel() : null, picked = page.picked();
    return [...(fuel ? [fuelIs(fuel)] : []), ...(picked.length && !page.intraday() ? [`d.DUID IN ${list(picked)}`] : [])];
  };
  const rangeHours = (duid = duidOfAll()) => { const { first, last } = range('units'); return hours(day(first), day(last), duid); };

  // A share of the output shown: of each group in its row's keys (`by`), or of all of them.
  const share = (mwh, rolled, by) => rolled
    ? `100 * ${mwh} / NULLIF(SUM(CASE WHEN GROUPING(${rolled}) = 0 THEN ${mwh} END) OVER (${by ? `PARTITION BY ${by}` : ''}), 0)`
    : `100 * ${mwh} / NULLIF(SUM(${mwh}) OVER (), 0)`;

  // The KPIs' change against as many days just before the range, over the days the daily
  // tables hold (`which`): `figure(from, to)` over each, blank unless both hold every hour
  // of their days; in percent with `pct`, else the difference.
  const change = (which, figure, duid, pct) => {
    const { from, to } = page.range(), { first, last } = queries.wholeDaysRange(which, from, to);
    const now = [day(first), day(last)], before = ['p.f - p.n', 'p.f - 1'];
    const a = figure(...now), b = figure(...before);
    return `WITH p AS (SELECT ${day(first)} AS f, CAST(DATE_DIFF('day', ${day(first)}, ${day(last)}) + 1 AS INTEGER) AS n)
      SELECT (CASE WHEN ${hours(...now, duid, false)} = 24 * p.n AND ${hours(...before, duid, false)} = 24 * p.n
        THEN ${pct ? `100 * (${a} - ${b}) / NULLIF(${b}, 0)` : `${a} - ${b}`} END)::DOUBLE AS v FROM p`;
  };
  // The units' conditions of a change: on the daily table and dim_duid.
  const changeUnits = (from, to, withFuel = true) => [`s.date BETWEEN ${from} AND ${to}`,
    ...(page.region() ? [`d.Region = ${str(page.region())}`] : []), ...pickedUnits(withFuel)];
  const onUnits = (sql, conds) => `(SELECT ${sql} FROM ${units('v_fct_summary_daily', sql, ...conds)} ${where(conds)})`;

  // What a series of the generation chart is: the fuel, the unit, or the plant.
  const seriesCol = by => by === 'fuel' ? FUEL : by === 'duid' ? 's.DUID' : 'd.Plant';
  const months = col => { const { from, to } = page.range(); return between(col, `${from.slice(0, 8)}01`, to); };

  // Curtailment: with no unit picked fct_curtailment_region's (the farms to their newest day,
  // AEMO's regional figures after), with units picked the farms' own, under the unit filters.
  const curtailmentFrom = () => {
    const { from, to } = page.range(), region = page.region(), fuel = page.fuel();
    return page.picked().length
      ? { from: units('v_fct_curtailment', 'd.'), fuel: FUEL,
          conds: [between('s.date', from, to), ...unitFilters('s')] }
      : { from: 'v_fct_curtailment_region s', fuel: 's.fuel',
          conds: [between('s.date', from, to), ...(region ? [`s.REGIONID = ${str(region)}`] : []), ...(fuel ? [`s.fuel = ${str(fuel)}`] : [])] };
  };
  const CURTAILED = 'SUM(s.curtailed_mwh)::DOUBLE AS cur', AVAILABLE = 'SUM(s.available_mwh)::DOUBLE AS avail';
  const RATE = '(100 * SUM(s.curtailed_mwh) / NULLIF(SUM(s.available_mwh), 0))::DOUBLE AS rate';

  // The demand of the regions, with the rooftop solar the stack has: MW at 5 minutes, MWh a day.
  const demandRows = intraday => {
    const region = page.region(), { from, to } = page.range();
    const { first, last } = intraday ? { first: from, last: to } : queries.wholeDaysRange('regions', from, to);
    const k = intraday ? 'date, time' : 'date';
    const [table, demand, roof] = intraday
      ? ['v_fct_region', 'CASE WHEN COUNT(r.demand) = COUNT(*) THEN SUM(r.demand) END', `SUM(${OUT})`]
      : ['v_fct_region_daily', '24 * SUM(r.demand)', 'SUM(s.output_mwh)'];
    return `WITH dem AS (SELECT ${k}, ${demand} AS v FROM ${table} r
        ${where([between('r.date', first, last), ...(region ? [`r.REGIONID = ${str(region)}`] : [])])} GROUP BY ${k}),
      roof AS (SELECT ${k}, ${roof} AS v FROM ${units(intraday ? 'v_fct_summary' : 'v_fct_summary_daily', 'd.')}
        ${where([between('s.date', first, last), `${FUEL} = ${str(ROOFTOP)}`, ...(region ? [`d.Region = ${str(region)}`] : [])])} GROUP BY ${k})
      SELECT ${at('dem', intraday).select}, (dem.v + COALESCE(roof.v, 0))::DOUBLE AS demand
      FROM dem LEFT JOIN roof USING (${k}) WHERE dem.v IS NOT NULL`;
  };

  // Revenue over energy: the price a fleet is paid.
  const capturePrice = g => `${g.revenue} / NULLIF(${g.mwh()}, 0)`;

  const queries = {
    // Read the days the daily tables hold, with the page's own runner.
    async readWholeDays(run) {
      const held = table => run(`SELECT CAST(MIN(date) AS VARCHAR) AS first, CAST(MAX(date) AS VARCHAR) AS last FROM ${table}`);
      const [[units], [regions]] = await Promise.all([held('v_fct_summary_daily'), held('v_fct_region_daily')]);
      wholeDaysHeld = { units, regions };
    },
    // A range cut to the days a daily table holds, and to the newest day both hold.
    wholeDaysRange(which, from, to) {
      if (!wholeDaysHeld) throw new Error('the daily tables are not attached yet');
      const { first } = wholeDaysHeld[which], { units, regions } = wholeDaysHeld;
      const last = units.last < regions.last ? units.last : regions.last;
      return { first: !from || from < first ? first : from, last: !to || to > last ? last : to };
    },

    // --- Filter lists, and the dates the date inputs offer ---
    // The regions of the market: the ones that have a price (dim_region also holds
    // Western Australia, another market).
    regions: 'SELECT DISTINCT REGIONID AS Region FROM v_fct_region ORDER BY Region',
    regionNames: 'SELECT DISTINCT Region AS region, State AS state FROM v_dim_region WHERE State IS NOT NULL AND Region IS NOT NULL',
    fuels: 'SELECT DISTINCT FuelSourceDescriptor AS fuel FROM v_dim_duid WHERE FuelSourceDescriptor IS NOT NULL ORDER BY fuel',
    allDuids: 'SELECT DISTINCT DUID, Region, FuelSourceDescriptor AS fuel FROM v_dim_duid WHERE DUID IS NOT NULL ORDER BY DUID',
    newestDate: 'SELECT CAST(MAX(date) AS VARCHAR) AS d FROM v_fct_summary',
    oldestDate: 'SELECT CAST(MIN(date) AS VARCHAR) AS d FROM v_dim_calendar',

    // --- Cutoff: the newest interval of the units, on the newest date ---
    cutoff: () => `SELECT CAST(MAX(date) AS VARCHAR) AS date, CAST(MAX(time) AS INTEGER) AS time FROM v_fct_summary
      WHERE date = ${day(page.newestDate())}`,

    // --- Dashboard: Right now ---
    // Per fuel at the newest interval: its output, its charging and its share of the output,
    // and the same added up (the row `all`); the renewable share there. The region filter only.
    nowByFuel: (now, region) => {
      const conds = [`s.date = ${day(now.date)}`, `s.time = ${now.time}`, ...(region ? [`d.Region = ${str(region)}`] : [])];
      return `SELECT ${FUEL} AS fuel, ${FIVE.output}::DOUBLE AS mw, ${FIVE.charging}::DOUBLE AS charging,
        (${share(FIVE.output, FUEL)})::DOUBLE AS share, GROUPING(${FUEL}) = 1 AS all
        FROM ${units('v_fct_summary', 'd.')} ${where(conds)} GROUP BY GROUPING SETS ((${FUEL}), ()) HAVING COUNT(*) > 0`;
    },
    nowShare: (now, region) => {
      const conds = [`s.date = ${day(now.date)}`, `s.time = ${now.time}`, ...(region ? [`d.Region = ${str(region)}`] : [])];
      return `SELECT (${renewableShare(FIVE)})::DOUBLE AS share FROM ${units('v_fct_summary', 'd.')} ${where(conds)}`;
    },
    // The output of some fuels together at that interval: the hero's "Other".
    nowOf: (now, region, fuels) => {
      const conds = [`s.date = ${day(now.date)}`, `s.time = ${now.time}`, ...(region ? [`d.Region = ${str(region)}`] : []), fuelsIn(fuels)];
      return `SELECT ${FIVE.output}::DOUBLE AS mw FROM ${units('v_fct_summary', 'd.')} ${where(conds)}`;
    },
    // The newest interval of the regional table, which can be ahead of the units': its date,
    // then its time on that date, then each region there.
    regionNewestDate: 'SELECT CAST(MAX(date) AS VARCHAR) AS date FROM v_fct_region',
    regionNewestTime: date => `SELECT CAST(MAX(time) AS INTEGER) AS time FROM v_fct_region WHERE date = ${day(date)}`,
    nowByRegion: (date, time) => `SELECT REGIONID AS region, AVG(price)::DOUBLE AS price,
      (CASE WHEN COUNT(demand) = COUNT(*) THEN SUM(demand) END)::DOUBLE AS demand, AVG(net_interchange)::DOUBLE AS net
      FROM v_fct_region WHERE date = ${day(date)} AND time = ${time} GROUP BY REGIONID ORDER BY region`,

    // --- Dashboard: generation chart ---
    // One row per series and interval (day), with what it made and what it took (charging,
    // negative) apart, and per interval the series added up (`all`). By fuel each row also
    // has its share of the interval's output.
    generation(by, intraday) {
      const g = grain(), k = at('s', intraday), series = seriesCol(by), conds = whereGen();
      const shares = by === 'fuel' ? `, (${share(g.output, series, k.group)})::DOUBLE AS share` : '';
      return `SELECT ${k.select}, ${series} AS series, ${g.output}::DOUBLE AS output, ${g.charging}::DOUBLE AS charging${shares},
        GROUPING(${series}) = 1 AS all FROM ${units(g.units, series, ...conds)} ${where(conds)}
        GROUP BY GROUPING SETS ((${k.group}, ${series}), (${k.group})) ORDER BY ${k.order}, series NULLS FIRST`;
    },
    // The series the chart does not draw one by one, added up per interval.
    generationOf(by, intraday, shown) {
      const g = grain(), k = at('s', intraday), series = seriesCol(by);
      const conds = [...whereGen(), by === 'fuel' ? fuelsIn(shown) : `${series} IN ${list(shown)}`];
      return `SELECT ${k.select}, ${g.output}::DOUBLE AS output, ${g.charging}::DOUBLE AS charging
        FROM ${units(g.units, ...conds)} ${where(conds)} GROUP BY ${k.group} ORDER BY ${k.order}`;
    },
    generationNotOf(by, intraday, shown) {
      const g = grain(), k = at('s', intraday), series = seriesCol(by);
      const conds = [...whereGen(), ...(by === 'fuel' ? fuelsNotIn(shown) : [`${series} NOT IN ${list(shown)}`])];
      return `SELECT ${k.select}, ${g.output}::DOUBLE AS output, ${g.charging}::DOUBLE AS charging
        FROM ${units(g.units, ...conds)} ${where(conds)} GROUP BY ${k.group} ORDER BY ${k.order}`;
    },

    // Each series as an average MW over the range (its energy over the hours the range
    // holds), the largest first, with its share of the output; and all of them together.
    averages: by => {
      const g = grain(), series = seriesCol(by), conds = whereGen();
      return `SELECT ${series} AS series, (${g.mwh()} / NULLIF(${rangeHours()}, 0))::DOUBLE AS avg, (${share(g.mwh())})::DOUBLE AS share
        FROM ${units(g.units, series, ...conds)} ${where(conds)} GROUP BY ${series} ORDER BY avg DESC`;
    },
    generationAverage: () => {
      const g = grain(), conds = whereGen();
      return `SELECT (${g.mwh()} / NULLIF(${rangeHours()}, 0))::DOUBLE AS avg FROM ${units(g.units, ...conds)} ${where(conds)}`;
    },

    // The units of a plant, which a click on it in the drill toggles as a group.
    stationUnits: name => `SELECT DISTINCT DUID FROM v_dim_duid WHERE Plant = ${str(name)} AND DUID IS NOT NULL`,

    // --- Dashboard: demand line over the generation chart, and its peak ---
    demand: intraday => `${demandRows(intraday)} ORDER BY ${intraday ? 'date, time' : 'date'}`,
    demandPeak: intraday => `${demandRows(intraday)} QUALIFY RANK() OVER (ORDER BY demand DESC) <= 1 ORDER BY demand DESC`,

    // --- Dashboard: price chart ---
    // Per region, and the rows of all the regions together ("total"): the price KPI's sparkline.
    // A day's price is the average of its intervals, so the average of days is the same.
    price(intraday) {
      const k = at('r', intraday), conds = wherePrice('r');
      return `SELECT ${k.select}, r.REGIONID AS Region, AVG(r.price)::DOUBLE AS avg_price, GROUPING(r.REGIONID) = 1 AS total
        FROM ${grain().regions} r ${where(conds)} GROUP BY GROUPING SETS ((${k.group}, r.REGIONID), (${k.group})) ORDER BY ${k.order}`;
    },
    // The plain average over the range: the price KPI, and the capture chart's dashed line.
    averagePrice: () => `SELECT AVG(r.price)::DOUBLE AS avg FROM ${grain().regions} r ${where(wherePrice('r'))}`,

    // --- Dashboard: KPIs ---
    // The units with output, rooftop solar's five left out.
    generatorCount: () => {
      const conds = whereGen();
      return `SELECT CAST(NULLIF(COUNT(DISTINCT s.DUID) FILTER (WHERE ${FUEL} IS DISTINCT FROM ${str(ROOFTOP)}), 0) AS INTEGER) AS cnt
        FROM ${units(grain().units, 'd.')} ${where(conds)}`;
    },
    // Emissions of what the generation chart shows (rooftop solar has no factor): tonnes and
    // intensity per interval (day), and over the range (the row "all").
    emissions(intraday) {
      const g = grain(), k = at('s', intraday), conds = whereGen();
      return `SELECT ${k.select}, (${g.emissions})::DOUBLE AS t, (${g.emissions} / NULLIF(${g.mwh('d.CO2eFactor IS NOT NULL')}, 0))::DOUBLE AS i,
        GROUPING(s.date) = 1 AS all FROM ${units(g.units, 'd.')} ${where(conds)}
        GROUP BY GROUPING SETS ((${k.group}), ()) HAVING t IS NOT NULL OR i IS NOT NULL ORDER BY ${k.order.replaceAll(',', ' NULLS FIRST,')} NULLS FIRST`;
    },
    // Renewable share per interval (day) and over the range. The fuel filter is ignored on purpose.
    renewableShareByPeriod: intraday => {
      const g = grain(), k = at('s', intraday), conds = whereGen({ withFuel: false });
      return `SELECT ${k.select}, (${renewableShare(g)})::DOUBLE AS share FROM ${units(g.units, 'd.')} ${where(conds)}
        GROUP BY ${k.group} HAVING share IS NOT NULL ORDER BY ${k.order}`;
    },
    renewableShareOfRange: () => {
      const g = grain(), conds = whereGen({ withFuel: false });
      return `SELECT (${renewableShare(g)})::DOUBLE AS share FROM ${units(g.units, 'd.')} ${where(conds)}`;
    },

    // The KPIs' change against the days just before the range, as many.
    changeGeneration: () => change('units',
      (a, b) => `(${onUnits(DAILY.mwh(), changeUnits(a, b))} / NULLIF(${hours(a, b, pickedUnits(), false)}, 0))`, pickedUnits(), true),
    changePrice: () => change('regions',
      (a, b) => `(SELECT AVG(r.price) FROM v_fct_region_daily r ${where([`r.date BETWEEN ${a} AND ${b}`, ...regionFilters('r.REGIONID', pickedUnits())])})`,
      pickedUnits(), false),
    changeRenewables: () => change('units',
      (a, b) => onUnits(renewableShare(DAILY), changeUnits(a, b, false)), pickedUnits(false), false),
    changeEmissions: () => change('units',
      (a, b) => onUnits(`${DAILY.emissions} / NULLIF(${DAILY.mwh('d.CO2eFactor IS NOT NULL')}, 0)`, changeUnits(a, b)), pickedUnits(), true),

    // --- Dashboard: map ---
    // Each unit with a position: its average MW (5 minutes) or MWh a day.
    mapScatter() {
      const g = grain(), conds = [...whereGen(), 'd.latitude IS NOT NULL'];
      return `SELECT s.DUID, ${FUEL} AS fuel, d.Region, d.latitude AS lat, d.longitude AS lon, (${g.average})::DOUBLE AS mw
        FROM ${units(g.units, 'd.')} ${where(conds)} GROUP BY ALL`;
    },

    // --- Insights, renewables: average day by fuel ---
    // The generators' output on an average day: per time of day up to 30 days, beyond per
    // hour of day over the whole months the range touches (profileMonths says which).
    profileMonths: () => `SELECT CAST(MIN(month) AS VARCHAR) AS first, CAST(MAX(month) AS VARCHAR) AS last
      FROM v_dim_month WHERE ${months('month')}`,
    profile: intraday => {
      if (intraday) {
        const conds = [...whereGen(), 'd.Storage = FALSE'];
        return `SELECT ${FUEL} AS fuel, CAST(s.time AS INTEGER) AS time, (${FIVE.output} / NULLIF(COUNT(DISTINCT s.date), 0))::DOUBLE AS mw
          FROM ${units('v_fct_summary', 'd.')} ${where(conds)} GROUP BY ALL ORDER BY time, fuel NULLS FIRST`;
      }
      const conds = [months('s.month'), ...unitFilters('s'), 'd.Storage = FALSE'];
      return `SELECT ${FUEL} AS fuel, CAST(s.hour AS INTEGER) AS hour,
        (SUM(s.mwh) / NULLIF((SELECT SUM(days) FROM v_dim_month WHERE ${months('month')}), 0))::DOUBLE AS mw
        FROM ${units('v_fct_summary_hourly', 'd.')} ${where(conds)} GROUP BY ALL ORDER BY hour, fuel NULLS FIRST`;
    },

    // --- Insights, renewables: curtailment ---
    // Per day (per month with `byMonth`) and fuel: the curtailed and available energy and the
    // rate; `curtailmentTotal` over the range.
    curtailment(byMonth) {
      const c = curtailmentFrom();
      const [keys, group, join] = byMonth
        ? ['CAST(k.year AS INTEGER) AS year, CAST(k.month AS INTEGER) AS month', 'k.year, k.month', ' LEFT JOIN v_dim_calendar k ON k.date = s.date']
        : ['CAST(s.date AS VARCHAR) AS date', 's.date', ''];
      return `SELECT ${keys}, ${c.fuel} AS fuel, ${CURTAILED}, ${AVAILABLE}, ${RATE}
        FROM ${c.from}${join} ${where(c.conds)} GROUP BY ${group}, ${c.fuel}
        HAVING cur IS NOT NULL OR avail IS NOT NULL ORDER BY ${byMonth ? 'year, month' : 'date'}, fuel`;
    },
    curtailmentTotal() {
      const c = curtailmentFrom();
      return `SELECT ${CURTAILED}, ${RATE} FROM ${c.from} ${where(c.conds)}`;
    },
    // The 15 farms that lost the most.
    curtailedFarms() {
      const { from, to } = page.range(), conds = [between('s.date', from, to), ...unitFilters('s')];
      return `SELECT s.DUID, ${FUEL} AS fuel, d.StationName AS station, ${CURTAILED}, ${RATE}
        FROM ${units('v_fct_curtailment', 'd.')} ${where(conds)} GROUP BY s.DUID, ${FUEL}, d.StationName HAVING cur > 0
        QUALIFY RANK() OVER (ORDER BY cur DESC) <= 15 ORDER BY cur DESC`;
    },
    curtailmentLastDay: 'SELECT CAST(MAX(date) AS VARCHAR) AS d FROM v_fct_curtailment',

    // --- Insights, market: price by hour of day ---
    // x date up to 30 days; beyond, x month, from the hour-of-day table.
    heatmap: intraday => intraday
      ? `SELECT CAST(r.date AS VARCHAR) AS date, CAST(h.hour AS INTEGER) AS y, AVG(r.price)::DOUBLE AS price
          FROM v_fct_region r JOIN v_dim_time h ON h.time = r.time ${where(wherePrice('r'))} GROUP BY ALL ORDER BY date, y`
      : `SELECT CAST(r.month AS VARCHAR) AS date, CAST(r.hour AS INTEGER) AS y,
          (SUM(r.price * r.intervals) / NULLIF(SUM(r.intervals), 0))::DOUBLE AS price
          FROM v_fct_region_hourly r ${where([months('r.month'), ...regionFilters('r.REGIONID', pickedUnits())])}
          GROUP BY ALL ORDER BY date, y`,

    // --- Insights, market: capture price by fuel ---
    // The generators' capture price and energy per fuel, the fuels with half a percent or more
    // of their output.
    capture: () => {
      const g = grain(), conds = [...whereGen({ withFuel: false }), 'd.Storage = FALSE'];
      return `SELECT ${FUEL} AS fuel, (${capturePrice(g)})::DOUBLE AS capture, (${g.mwh()})::DOUBLE AS volume, (${share(g.mwh())})::DOUBLE AS share
        FROM ${units(g.units, 'd.')} ${where(conds)} GROUP BY ${FUEL} QUALIFY volume > 0 AND share >= 0.5 ORDER BY capture`;
    },

    // --- Insights, market: negative prices ---
    // The share of 5-minute intervals, and beyond 30 days the share of days.
    negativePrices(intraday) {
      const table = intraday ? 'v_fct_region' : 'v_fct_region_daily';
      const { from, to } = page.range(), conds = [between('r.date', from, to), ...regionFilters('r.REGIONID', pickedUnits())];
      return `SELECT r.REGIONID AS region, (100 * AVG(CASE WHEN r.price < 0 THEN 1 ELSE 0 END))::DOUBLE AS pct, MIN(r.price)::DOUBLE AS lowest
        FROM ${table} r ${where(conds)} GROUP BY r.REGIONID ORDER BY region`;
    },

    // --- Insights, market: net exports by region ---
    netExports(intraday) {
      const k = at('r', intraday);
      return `SELECT ${k.select}, r.REGIONID AS region, AVG(r.net_interchange)::DOUBLE AS mw
        FROM ${grain().regions} r ${where(wherePrice('r'))} GROUP BY ${k.group}, r.REGIONID ORDER BY ${k.order}, region`;
    },

    // --- Insights, fleet: capacity factor ---
    // Per unit, and per fuel (the rows on which `total` is true): the energy of the units over
    // what their registered capacity could make in the hours the range holds. A unit that
    // made nothing has no capacity factor.
    capacityFactor: () => {
      const g = grain(), conds = [...whereGen(), 'd.RegCapMW > 0', 'd.Storage = FALSE'];
      return `WITH u AS (SELECT ${FUEL} AS fuel, s.DUID, d.StationName AS station, ${g.mwh()} AS mwh, ANY_VALUE(d.RegCapMW) AS cap
          FROM ${units(g.units, 'd.')} ${where(conds)} GROUP BY ALL)
        SELECT fuel, DUID, station, SUM(cap)::DOUBLE AS cap,
          (100 * SUM(mwh) / NULLIF(SUM(cap) * ${rangeHours([...duidOfAll(), 'd.RegCapMW > 0', 'd.Storage = FALSE'])}, 0))::DOUBLE AS cf,
          GROUPING(DUID) = 1 AS total
        FROM u GROUP BY GROUPING SETS ((fuel, DUID, station), (fuel)) HAVING cf IS NOT NULL ORDER BY cf`;
    },

    // --- Insights, fleet: batteries ---
    // Per time of day: the output and the charging of an average day, and the price seen.
    batteryDay: () => {
      const conds = [...whereGen({ withFuel: false }), 'd.Storage = TRUE'];
      return `SELECT CAST(s.time AS INTEGER) AS time, (${FIVE.output} / NULLIF(COUNT(DISTINCT s.date), 0))::DOUBLE AS discharge,
        (${FIVE.charging} / NULLIF(COUNT(DISTINCT s.date), 0))::DOUBLE AS charge, AVG(s.price)::DOUBLE AS price
        FROM ${units('v_fct_summary', 'd.')} ${where(conds)} GROUP BY s.time ORDER BY time`;
    },
    // "Sold" and "bought": the prices weighted by the energy discharged and charged, and the
    // spread between them.
    batterySpread: () => {
      const conds = [...whereGen({ withFuel: false }), 'd.Storage = TRUE'];
      const sold = capturePrice(FIVE), bought = `SUM(${IN} * s.price) / NULLIF(SUM(${IN}), 0)`;
      return `SELECT (${sold})::DOUBLE AS sold, (${bought})::DOUBLE AS bought, (${sold} - (${bought}))::DOUBLE AS spread
        FROM ${units('v_fct_summary', 'd.')} ${where(conds)}`;
    },
    // The fleet the filters leave: its units, registered MW and storage MWh.
    batteryFleet: () => {
      const conds = ['d.Storage = TRUE', ...unitFilters('d', false)];
      return `SELECT CAST(NULLIF(COUNT(*), 0) AS INTEGER) AS units, SUM(d.RegCapMW)::DOUBLE AS mw, SUM(d.StorageMWh)::DOUBLE AS mwh FROM v_dim_duid d ${where(conds)}`;
    },

    // --- Insights, fleet: owners ---
    // The energy by owner and plant (and the plant's fuel), with its share of the output
    // shown; and each owner's share.
    owners: () => {
      const g = grain(), conds = whereGen();
      return `SELECT d.Owner AS owner, d.Plant AS plant, ${FUEL} AS fuel, (${g.mwh()})::DOUBLE AS mwh, (${share(g.mwh())})::DOUBLE AS share
        FROM ${units(g.units, 'd.')} ${where(conds)} GROUP BY d.Owner, d.Plant, ${FUEL} QUALIFY ${g.mwh()} > 0 ORDER BY mwh DESC`;
    },
    ownerShares: () => {
      const g = grain(), conds = whereGen();
      return `SELECT d.Owner AS owner, (${g.mwh()})::DOUBLE AS mwh, (${share(g.mwh())})::DOUBLE AS share
        FROM ${units(g.units, 'd.')} ${where(conds)} GROUP BY d.Owner QUALIFY ${g.mwh()} > 0`;
    },

    // --- Flows ---
    // Every unit's fuel, region and position, once.
    flowUnits: 'SELECT DISTINCT DUID, FuelSourceDescriptor AS fuel, Storage AS storage, latitude AS lat, longitude AS lon FROM v_dim_duid WHERE DUID IS NOT NULL',
    // A day of the units' output in the region filter, one row per unit and interval, the
    // units at 1 MW or more either way: the bubbles.
    flowGens: date => {
      const conds = [`s.date = ${day(date)}`, '(s.mw >= 1 OR s.mw <= -1)', ...(page.region() ? [`d.Region = ${str(page.region())}`] : [])];
      return `SELECT CAST(s.time AS INTEGER) AS time, s.DUID, AVG(s.mw)::DOUBLE AS mw FROM ${units('v_fct_summary', ...conds)} ${where(conds)} GROUP BY s.time, s.DUID`;
    },
    // A day of what the generators made and their renewable share, per interval, in the
    // region filter: the readout under the clock.
    flowNow: date => {
      const conds = [`s.date = ${day(date)}`, 'd.Storage = FALSE', ...(page.region() ? [`d.Region = ${str(page.region())}`] : [])];
      return `SELECT CAST(s.time AS INTEGER) AS time, ${FIVE.output}::DOUBLE AS mw, (${renewableShare(FIVE)})::DOUBLE AS share
        FROM ${units('v_fct_summary', 'd.')} ${where(conds)} GROUP BY s.time`;
    },
    // The links between regions.
    interconnectors: `SELECT DISTINCT interconnector AS id, from_region, to_region, description FROM v_dim_interconnector
      WHERE interconnector IS NOT NULL`,
    // The interconnectors' flows and limits per interval, with the share of the limit used
    // and whether the link is out (no flow and no room); with a region filter, the links that
    // start or end there.
    flows: (from, to) => {
      const region = page.region();
      const conds = [between('f.date', from, to), ...(region ? [`(i.from_region = ${str(region)} OR i.to_region = ${str(region)})`] : [])];
      return `SELECT f.interconnector AS id, CAST(f.date AS VARCHAR) AS date, CAST(f.time AS INTEGER) AS time, f.mw::DOUBLE AS mw,
          f.export_limit::DOUBLE AS export_limit, f.import_limit::DOUBLE AS import_limit,
          (CASE WHEN SUM(f.mw) IS NOT NULL THEN CASE WHEN SUM(f.mw) >= 0
            THEN CASE WHEN SUM(f.export_limit) > 0 THEN 100 * ABS(SUM(f.mw)) / SUM(f.export_limit) ELSE 0 END
            ELSE CASE WHEN -SUM(f.import_limit) > 0 THEN 100 * ABS(SUM(f.mw)) / -SUM(f.import_limit) ELSE 0 END END END)::DOUBLE AS util,
          CASE WHEN SUM(f.mw) IS NOT NULL THEN CASE WHEN ABS(SUM(f.mw)) < 1 AND SUM(f.export_limit) - SUM(f.import_limit) < 5 THEN 1 ELSE 0 END END AS out
        FROM v_fct_interconnector f${region ? ' LEFT JOIN v_dim_interconnector i ON i.interconnector = f.interconnector' : ''} ${where(conds)}
        GROUP BY f.interconnector, f.date, f.time, f.mw, f.export_limit, f.import_limit ORDER BY date, time`;
    },
    // Each region's price and net interchange per interval.
    flowPrices: (from, to) => `SELECT REGIONID AS region, CAST(date AS VARCHAR) AS date, CAST(time AS INTEGER) AS time,
      AVG(price)::DOUBLE AS price, AVG(net_interchange)::DOUBLE AS net FROM v_fct_region WHERE ${between('date', from, to)}
      GROUP BY REGIONID, date, time`,

    // --- History ---
    // Every day a daily table holds, under the region filter, but the newest: it is still
    // filling. Per day: the renewable share; the energy of solar (rooftop's included) and of
    // wind; the price and the average demand.
    historyShare: () => `SELECT CAST(s.date AS VARCHAR) AS date, (${renewableShare(DAILY)})::DOUBLE AS re
      FROM ${units('v_fct_summary_daily', 'd.')} ${where(historyUnits())} GROUP BY s.date HAVING re IS NOT NULL ORDER BY date`,
    historyEnergy: fuels => {
      const conds = [...historyUnits(), `${FUEL} IN ${list(fuels)}`];
      return `SELECT CAST(s.date AS VARCHAR) AS date, (${DAILY.mwh()})::DOUBLE AS mwh FROM ${units('v_fct_summary_daily', 'd.')} ${where(conds)}
        GROUP BY s.date ORDER BY date`;
    },
    historySolar: () => queries.historyEnergy(['Solar', ROOFTOP]),
    historyWind: () => queries.historyEnergy(['Wind']),
    historyPrice: () => {
      const { first, last } = queries.wholeDaysRange('regions', null, shiftDate(page.newestDate(), -1));
      const conds = [between('r.date', first, last), ...(page.region() ? [`r.REGIONID = ${str(page.region())}`] : [])];
      return `SELECT CAST(r.date AS VARCHAR) AS date, AVG(r.price)::DOUBLE AS price, (SUM(r.demand) / COUNT(DISTINCT r.date))::DOUBLE AS demand
        FROM v_fct_region_daily r ${where(conds)} GROUP BY r.date ORDER BY date`;
    },
  };

  function historyUnits() {
    const { first, last } = queries.wholeDaysRange('units', null, shiftDate(page.newestDate(), -1));
    return [between('s.date', first, last), ...(page.region() ? [`d.Region = ${str(page.region())}`] : [])];
  }

  return queries;
}
