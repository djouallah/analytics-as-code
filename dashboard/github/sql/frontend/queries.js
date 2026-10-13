// =============================================================================
// queries.js — what each chart of the page asks the semantic model, in SQL
// =============================================================================
// The same members as ../../dax/frontend/queries.js, called the same way by the same
// index.html, and each returns one SELECT over the model (semantic_model/model.bim), in
// dax-sql's SQL: the model's columns (table.column) to group by, its measures as
// AGG("name"), MIN and MAX of a column, FROM model, WHERE, GROUP BY ALL (or a list with
// ROLLUP for a subtotal, flagged by GROUPING), HAVING, ORDER BY and FETCH FIRST n ROWS WITH
// TIES. The compiler builds the same plan from it as from the DAX page's query object: the
// same measures, the same rows. A figure is a measure of the model, never SQL written here.
//
// What a date range reads: the 5-minute tables up to 30 days, the daily ones beyond, as the
// measures pick them (the model's "Reads 5 minutes"): a query goes through the fact's own
// date and keys up to 30 days, through the dimensions beyond, cut to the days the daily
// tables hold (wholeDays).
// A query of a dimension's columns alone leaves out its blank row (IS NOT NULL on its key),
// as the DAX page's compiler does for it.
//
// createQueries(page) takes what the page's state is, as functions: range() { from, to },
// intraday(), region(), fuel(), picked() (the units picked), newestDate(), shiftDate(date, n),
// and the names UNKNOWN and ROOFTOP.
// connect(data) is what runs them: the data source wrapped by semantic/query.js, which
// compiles a SELECT over the model to SQL over the data's views. The page is served in a
// folder of the site, sql/, and reads the site's files, one folder up.
// =============================================================================

import { createModel } from '../semantic/query.js';

export const connect = data => createModel({ ...data, init: () => data.init({ base: '../' }) });

export function createQueries(page) {
  const { UNKNOWN, ROOFTOP, shiftDate } = page;

  // --- SQL pieces ---
  const str = v => `'${String(v).replace(/'/g, "''")}'`;
  const val = v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v) : str(v);
  const day = v => `DATE ${str(v)}`;
  const list = vs => `(${vs.map(val).join(', ')})`;
  const m = name => `AGG("${name}")`;
  const between = (col, from, to) => `${col} BETWEEN ${day(from)} AND ${day(to)}`;
  const isColumn = x => /^\w+\.\w+$/.test(x);
  // A SELECT over the model. `select`: [name, column or aggregate]; `rollup`: { name: [columns] },
  // the subtotal rows over those columns (GROUPING names them); `orderBy`: names, or
  // [name, 'desc']; `ties`: FETCH FIRST n ROWS WITH TIES.
  const q = ({ select, where = [], rollup = {}, having = [], orderBy = [], ties }) => {
    const rolled = Object.values(rollup).flat();
    const items = [...Object.entries(select).map(([n, x]) => `${x} AS "${n}"`),
      ...Object.entries(rollup).map(([n, cols]) => `GROUPING(${cols[0]}) AS "${n}"`)];
    const keys = Object.values(select).filter(isColumn).filter(c => !rolled.includes(c));
    const group = rolled.length
      ? `GROUP BY ${[...keys, ...Object.values(rollup).map(cols => `ROLLUP(${cols.length > 1 ? `(${cols.join(', ')})` : cols[0]})`)].join(', ')}`
      : Object.values(select).some(isColumn) ? 'GROUP BY ALL' : '';
    const order = orderBy.map(o => Array.isArray(o) ? `"${o[0]}" ${o[1].toUpperCase()}` : `"${o}"`);
    return [`SELECT ${items.join(', ')}`, 'FROM model',
      where.length ? `WHERE ${where.join(' AND ')}` : '', group,
      having.length ? `HAVING ${having.join(' AND ')}` : '',
      order.length ? `ORDER BY ${order.join(', ')}` : '',
      ties != null ? `FETCH FIRST ${ties} ROWS WITH TIES` : ''].filter(Boolean).join('\n');
  };

  const ENERGY = m('Generation MWh'), CAPTURE = m('Capture price'), SHARE = m('Generation share');
  const grain = () => page.intraday()
    ? { fact: 'fct_summary', unit: 'fct_summary', price: 'fct_region', region: 'fct_region.REGIONID',
        output: m('Generation MW'), charging: m('Charging MW'), average: m('Average MW'), demand: m('Demand with rooftop MW') }
    : { fact: 'dim_calendar', unit: 'dim_duid', price: 'dim_calendar', region: 'dim_region.Region',
        output: ENERGY, charging: m('Charging MWh'), average: m('Average MWh a day'), demand: m('Demand with rooftop MWh') };
  // The unit's fuel, and whether it is storage (a battery): dim_duid says. A generator is any
  // unit that is not storage, a unit with no fuel included.
  const FUEL = 'dim_duid.FuelSourceDescriptor';
  const STORAGE = 'dim_duid.Storage = TRUE', GENERATOR = 'dim_duid.Storage = FALSE';
  const fuelIs = fuel => fuel === UNKNOWN ? `${FUEL} IS NULL` : `${FUEL} = ${str(fuel)}`;
  // Fuels by the names the charts give them: a list of them, the blank one as UNKNOWN.
  const fuelsIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN);
    if (!fuels.includes(UNKNOWN)) return `${FUEL} IN ${list(named)}`;
    return named.length ? `(${FUEL} IS NULL OR ${FUEL} IN ${list(named)})` : `${FUEL} IS NULL`;
  };
  const fuelsNotIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN);
    return [...(named.length ? [`(${FUEL} NOT IN ${list(named)} OR ${FUEL} IS NULL)`] : []), ...(fuels.includes(UNKNOWN) ? [`${FUEL} IS NOT NULL`] : [])];
  };
  // The date (and time) columns of a grain, as select items, and their names, as an order.
  const at = (table, intraday) => ({ date: `${table}.date`, ...(intraday ? { time: `${table}.time` } : {}) });
  const byTime = intraday => intraday ? ['date', 'time'] : ['date'];
  // What a series of the generation chart is: the fuel, the unit, or the plant.
  const seriesCol = (by, unit) => by === 'fuel' ? FUEL : by === 'duid' ? `${unit}.DUID` : 'dim_duid.Plant';

  // The days the daily tables hold, read once the aggregates are attached (readWholeDays).
  let wholeDaysHeld = null;
  const wholeDaysQuery = table => q({ select: { first: `MIN(${table}.date)`, last: `MAX(${table}.date)` } });

  const queries = {
    // Read the days the daily tables hold, with the page's own runner.
    async readWholeDays(run) {
      const [[units], [regions]] = await Promise.all(['fct_summary_daily', 'fct_region_daily'].map(t => run(wholeDaysQuery(t))));
      wholeDaysHeld = { units, regions };
    },
    byTime,

    // --- Filters: the conditions of a query's WHERE ---
    dates: (table, from, to) => [between(`${table}.date`, from, to)],
    // A range cut to the days a daily table holds, on dim_calendar, and to the newest day
    // both hold (the DAX page's says why).
    wholeDays(which, from, to) {
      const { first, last } = queries.wholeDaysRange(which, from, to);
      return queries.dates('dim_calendar', first, last);
    },
    wholeDaysRange(which, from, to) {
      if (!wholeDaysHeld) throw new Error('the daily tables are not attached yet');
      const { first } = wholeDaysHeld[which], { units, regions } = wholeDaysHeld;
      const last = units.last < regions.last ? units.last : regions.last;
      return { first: !from || from < first ? first : from, last: !to || to > last ? last : to };
    },
    // The header's filters on the units, at the range's grain.
    whereGen({ withFuel = true } = {}) {
      const { from, to } = page.range(), { fact, unit } = grain();
      return [...(page.intraday() ? queries.dates(fact, from, to) : queries.wholeDays('units', from, to)), ...queries.unitFilters(unit, withFuel)];
    },
    unitFilters(fact, withFuel = true) {
      const region = page.region(), fuel = withFuel ? page.fuel() : null, picked = page.picked();
      return [
        ...(region ? [`dim_duid.Region = ${str(region)}`] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [`${fact}.DUID IN ${list(picked)}`] : [])];
    },
    // The header's filters on the regions, at the range's grain; or on a table named outright.
    wherePrice(table) {
      const { from, to } = page.range(), { price, region } = grain();
      if (table) return [...queries.dates(table, from, to), ...queries.priceFilters(`${table}.REGIONID`)];
      return [...(page.intraday() ? queries.dates(price, from, to) : queries.wholeDays('regions', from, to)), ...queries.priceFilters(region)];
    },
    priceFilters(regionCol) {
      const region = page.region(), fuel = page.fuel(), picked = page.picked();
      return [
        ...(region ? [`${regionCol} = ${str(region)}`] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [`dim_duid.DUID IN ${list(picked)}`] : [])];
    },
    // The header's filters for a measure that reads the regions' table too ("Hours").
    whereAll({ withFuel = true } = {}) {
      const { from, to } = page.range(), { unit } = grain();
      const days = page.intraday()
        ? [...queries.dates('fct_summary', from, to), ...queries.dates('fct_region', from, to), ...queries.dates('dim_calendar', from, to)]
        : queries.wholeDays('units', from, to);
      return [...days, ...queries.allFilters(unit, withFuel)];
    },
    allFilters(unit, withFuel = true) {
      const region = page.region(), fuel = withFuel ? page.fuel() : null, picked = page.picked();
      return [
        ...(region ? [`dim_region.Region = ${str(region)}`] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [`${unit}.DUID IN ${list(picked)}`] : [])];
    },
    // Beyond 30 days the hour-of-day tables are by whole month: the months the range touches.
    months(table) {
      const { from, to } = page.range();
      return [between(`${table}.month`, `${from.slice(0, 8)}01`, to)];
    },

    // =====================================================================
    // The queries, by tab and chart (the DAX page's says what each is for).
    // =====================================================================

    // --- Filter lists, and the dates the date inputs offer ---
    regions: q({ select: { Region: 'fct_region.REGIONID' }, orderBy: ['Region'] }),
    regionNames: q({ select: { region: 'dim_region.Region', state: 'dim_region.State' },
      where: ['dim_region.State IS NOT NULL', 'dim_region.Region IS NOT NULL'] }),
    fuels: q({ select: { fuel: FUEL }, where: [`${FUEL} IS NOT NULL`, 'dim_duid.DUID IS NOT NULL'], orderBy: ['fuel'] }),
    allDuids: q({ select: { DUID: 'dim_duid.DUID', Region: 'dim_duid.Region', fuel: FUEL }, where: ['dim_duid.DUID IS NOT NULL'], orderBy: ['DUID'] }),
    newestDate: q({ select: { d: 'MAX(fct_summary.date)' } }),
    oldestDate: q({ select: { d: 'MIN(dim_calendar.date)' } }),

    // --- Cutoff: the newest interval of the units ---
    cutoff: () => q({ select: { date: 'MAX(fct_summary.date)', time: 'MAX(fct_summary.time)' },
      where: [`fct_summary.date = ${day(page.newestDate())}`] }),

    // --- Dashboard: Right now ---
    nowFilters: (now, region) => [`fct_summary.date = ${day(now.date)}`, `fct_summary.time = ${now.time}`,
      ...(region ? [`dim_duid.Region = ${str(region)}`] : [])],
    nowByFuel: (now, region) => q({ select: { fuel: FUEL, mw: m('Generation MW'), charging: m('Charging MW'), share: SHARE },
      rollup: { all: [FUEL] }, where: queries.nowFilters(now, region) }),
    nowShare: (now, region) => q({ select: { share: m('Renewable share') }, where: queries.nowFilters(now, region) }),
    nowOf: (now, region, fuels) => q({ select: { mw: m('Generation MW') }, where: [...queries.nowFilters(now, region), fuelsIn(fuels)] }),
    regionNewestDate: q({ select: { date: 'MAX(fct_region.date)' } }),
    regionNewestTime: date => q({ select: { time: 'MAX(fct_region.time)' }, where: [`fct_region.date = ${day(date)}`] }),
    nowByRegion: (date, time) => q({
      select: { region: 'fct_region.REGIONID', price: m('Average price'), demand: m('Demand MW'), net: m('Net interchange MW') },
      where: [`fct_region.date = ${day(date)}`, `fct_region.time = ${time}`], orderBy: ['region'] }),

    // --- Dashboard: generation chart ---
    generation(by, intraday) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return q({ select: { ...at(fact, intraday), series, output, charging, ...(by === 'fuel' ? { share: SHARE } : {}) },
        rollup: { all: [series] }, where: queries.whereGen(), orderBy: [...byTime(intraday), 'series'] });
    },
    generationOf(by, intraday, shown) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return q({ select: { ...at(fact, intraday), output, charging },
        where: [...queries.whereGen(), by === 'fuel' ? fuelsIn(shown) : `${series} IN ${list(shown)}`], orderBy: byTime(intraday) });
    },
    generationNotOf(by, intraday, shown) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return q({ select: { ...at(fact, intraday), output, charging },
        where: [...queries.whereGen(), ...(by === 'fuel' ? fuelsNotIn(shown) : [`${series} NOT IN ${list(shown)}`])], orderBy: byTime(intraday) });
    },
    averages: by => q({ select: { series: seriesCol(by, grain().unit), avg: m('Average generation MW'), share: SHARE },
      where: queries.whereAll(), orderBy: [['avg', 'desc']] }),
    generationAverage: () => q({ select: { avg: m('Average generation MW') }, where: queries.whereAll() }),
    stationUnits: name => q({ select: { DUID: 'dim_duid.DUID' }, where: [`dim_duid.Plant = ${str(name)}`, 'dim_duid.DUID IS NOT NULL'] }),

    // --- Dashboard: demand line over the generation chart ---
    demand(intraday) {
      const region = page.region(), { from, to } = page.range(), g = grain();
      return q({ select: { date: 'dim_calendar.date', ...(intraday ? { time: 'dim_time.time' } : {}), demand: g.demand },
        where: [...(intraday ? queries.dates('dim_calendar', from, to) : queries.wholeDays('regions', from, to)), ...(region ? [`dim_region.Region = ${str(region)}`] : [])],
        orderBy: byTime(intraday) });
    },
    demandPeak(intraday) {
      const region = page.region(), { from, to } = page.range(), g = grain();
      return q({ select: { date: 'dim_calendar.date', ...(intraday ? { time: 'dim_time.time' } : {}), demand: g.demand },
        where: [...(intraday ? queries.dates('dim_calendar', from, to) : queries.wholeDays('regions', from, to)), ...(region ? [`dim_region.Region = ${str(region)}`] : [])],
        orderBy: [['demand', 'desc']], ties: 1 });
    },

    // --- Dashboard: price chart ---
    price(intraday) {
      const { price, region } = grain();
      return q({ select: { ...at(price, intraday), Region: region, avg_price: m('Average price') }, rollup: { total: [region] },
        where: queries.wherePrice(), orderBy: byTime(intraday) });
    },
    averagePrice: () => q({ select: { avg: m('Average price') }, where: queries.wherePrice() }),

    // --- Dashboard: KPIs ---
    generatorCount: () => q({ select: { cnt: m('Units') }, where: queries.whereGen() }),
    emissions(intraday) {
      const keys = at(grain().fact, intraday);
      return q({ select: { ...keys, t: m('Emissions t'), i: m('Emissions intensity') }, rollup: { all: Object.values(keys) },
        where: queries.whereGen(), orderBy: byTime(intraday) });
    },
    renewableShareByPeriod: intraday => q({ select: { ...at(grain().fact, intraday), share: m('Renewable share') },
      where: queries.whereGen({ withFuel: false }), orderBy: byTime(intraday) }),
    renewableShareOfRange: () => q({ select: { share: m('Renewable share') }, where: queries.whereGen({ withFuel: false }) }),
    change(measure, which, filters) {
      const { from, to } = page.range();
      return q({ select: { v: m(measure) }, where: [...queries.wholeDays(which, from, to), ...filters] });
    },
    changeGeneration: () => queries.change('Average generation MW change', 'units', queries.allFilters('dim_duid')),
    changePrice: () => queries.change('Average price change', 'regions', queries.priceFilters('dim_region.Region')),
    changeRenewables: () => queries.change('Renewable share change', 'units', queries.allFilters('dim_duid', false)),
    changeEmissions: () => queries.change('Emissions intensity change', 'units', queries.allFilters('dim_duid')),

    // --- Dashboard: map ---
    mapScatter() {
      const { unit, average } = grain();
      return q({ select: { DUID: `${unit}.DUID`, fuel: FUEL, Region: 'dim_duid.Region', lat: 'dim_duid.latitude', lon: 'dim_duid.longitude', mw: average },
        where: [...queries.whereGen(), 'dim_duid.latitude IS NOT NULL'] });
    },

    // --- Insights, renewables: average day by fuel ---
    profileMonths: () => q({ select: { first: 'MIN(dim_month.month)', last: 'MAX(dim_month.month)' }, where: queries.months('dim_month') }),
    profile: intraday => intraday
      ? q({ select: { fuel: FUEL, time: 'fct_summary.time', mw: m('Generation MW on an average day') },
          where: [...queries.whereGen(), GENERATOR], orderBy: ['time', 'fuel'] })
      : q({ select: { fuel: FUEL, hour: 'fct_summary_hourly.hour', mw: m('Average MW at hour') },
          where: [...queries.months('dim_month'), ...queries.unitFilters('fct_summary_hourly'), GENERATOR], orderBy: ['hour', 'fuel'] }),

    // --- Insights, renewables: curtailment ---
    curtailmentFrom() {
      const { from, to } = page.range(), region = page.region(), fuel = page.fuel();
      const dates = queries.dates('dim_calendar', from, to);
      return page.picked().length
        ? { fuel: FUEL, cur: m('Curtailed MWh'), avail: m('Available MWh'), rate: m('Curtailment rate'),
            filters: [...dates, ...queries.unitFilters('fct_curtailment')] }
        : { fuel: 'fct_curtailment_region.fuel', cur: m('Wind and solar curtailed MWh'),
            avail: m('Wind and solar available MWh'), rate: m('Wind and solar curtailment rate'),
            filters: [...dates, ...(region ? [`fct_curtailment_region.REGIONID = ${str(region)}`] : []),
              ...(fuel ? [`fct_curtailment_region.fuel = ${str(fuel)}`] : [])] };
    },
    curtailment(byMonth) {
      const f = queries.curtailmentFrom();
      const keys = byMonth ? { year: 'dim_calendar.year', month: 'dim_calendar.month' } : { date: 'dim_calendar.date' };
      return q({ select: { ...keys, fuel: f.fuel, cur: f.cur, avail: f.avail, rate: f.rate },
        where: f.filters, orderBy: [...Object.keys(keys), 'fuel'] });
    },
    curtailmentTotal() {
      const f = queries.curtailmentFrom();
      return q({ select: { cur: f.cur, rate: f.rate }, where: f.filters });
    },
    curtailedFarms() {
      const { from, to } = page.range();
      return q({ select: { DUID: 'dim_duid.DUID', fuel: FUEL, station: 'dim_duid.StationName', cur: m('Curtailed MWh'), rate: m('Curtailment rate') },
        where: [...queries.dates('fct_curtailment', from, to), ...queries.unitFilters('fct_curtailment')],
        having: ['"cur" > 0'], orderBy: [['cur', 'desc']], ties: 15 });
    },
    curtailmentLastDay: q({ select: { d: 'MAX(fct_curtailment.date)' } }),

    // --- Insights, market: price by hour of day ---
    heatmap: intraday => intraday
      ? q({ select: { date: 'fct_region.date', y: 'dim_time.hour', price: m('Average price') }, where: queries.wherePrice(), orderBy: ['date', 'y'] })
      : q({ select: { date: 'fct_region_hourly.month', y: 'fct_region_hourly.hour', price: m('Price at hour') },
          where: [...queries.months('fct_region_hourly'), ...queries.priceFilters('fct_region_hourly.REGIONID')], orderBy: ['date', 'y'] }),

    // --- Insights, market: capture price by fuel ---
    capture: () => q({ select: { fuel: FUEL, capture: CAPTURE, volume: ENERGY, share: SHARE },
      where: [...queries.whereGen({ withFuel: false }), GENERATOR], having: ['"volume" > 0', '"share" >= 0.5'], orderBy: ['capture'] }),

    // --- Insights, market: negative prices ---
    negativePrices(intraday) {
      const [p, pct, lowest] = intraday ? ['fct_region', 'Negative price share', 'Lowest price']
        : ['fct_region_daily', 'Negative price days share', 'Lowest daily price'];
      return q({ select: { region: `${p}.REGIONID`, pct: m(pct), lowest: m(lowest) }, where: queries.wherePrice(p), orderBy: ['region'] });
    },

    // --- Insights, market: net exports by region ---
    netExports(intraday) {
      const { price, region } = grain();
      return q({ select: { ...at(price, intraday), region, mw: m('Net interchange MW') },
        where: queries.wherePrice(), orderBy: [...byTime(intraday), 'region'] });
    },

    // --- Insights, fleet: capacity factor ---
    capacityFactor: () => q({
      select: { fuel: FUEL, DUID: 'dim_duid.DUID', station: 'dim_duid.StationName', cap: m('Capacity MW'), cf: m('Capacity factor') },
      rollup: { total: ['dim_duid.DUID', 'dim_duid.StationName'] },
      where: [...queries.whereAll(), 'dim_duid.RegCapMW > 0', GENERATOR],
      having: ['"cf" IS NOT NULL'], orderBy: ['cf'] }),

    // --- Insights, fleet: batteries ---
    batteries: () => [...queries.whereGen({ withFuel: false }), STORAGE],
    batteryDay: () => q({ select: { time: 'fct_summary.time', discharge: m('Generation MW on an average day'),
      charge: m('Charging MW on an average day'), price: m('Price seen') }, where: queries.batteries(), orderBy: ['time'] }),
    batterySpread: () => q({ select: { sold: CAPTURE, bought: m('Charging price'), spread: m('Battery spread') }, where: queries.batteries() }),
    batteryFleet: () => q({ select: { units: m('Registered units'), mw: m('Registered MW'), mwh: m('Storage MWh') },
      where: [STORAGE, ...queries.unitFilters('dim_duid', false)] }),

    // --- Insights, fleet: owners ---
    owners: () => q({ select: { owner: 'dim_duid.Owner', plant: 'dim_duid.Plant', fuel: FUEL, mwh: ENERGY, share: SHARE },
      where: queries.whereGen(), having: ['"mwh" > 0'], orderBy: [['mwh', 'desc']] }),
    ownerShares: () => q({ select: { owner: 'dim_duid.Owner', mwh: ENERGY, share: SHARE },
      where: queries.whereGen(), having: ['"mwh" > 0'] }),

    // --- Flows ---
    flowUnits: q({ select: { DUID: 'dim_duid.DUID', fuel: FUEL, storage: 'dim_duid.Storage',
      lat: 'dim_duid.latitude', lon: 'dim_duid.longitude' }, where: ['dim_duid.DUID IS NOT NULL'] }),
    flowGens: date => q({ select: { time: 'fct_summary.time', DUID: 'fct_summary.DUID', mw: m('Average MW') },
      where: [`fct_summary.date = ${day(date)}`, '(fct_summary.mw >= 1 OR fct_summary.mw <= -1)',
        ...(page.region() ? [`dim_duid.Region = ${str(page.region())}`] : [])] }),
    flowNow: date => q({ select: { time: 'fct_summary.time', mw: m('Generation MW'), share: m('Renewable share') },
      where: [`fct_summary.date = ${day(date)}`, GENERATOR, ...(page.region() ? [`dim_duid.Region = ${str(page.region())}`] : [])] }),
    interconnectors: q({ select: { id: 'dim_interconnector.interconnector', from_region: 'dim_interconnector.from_region',
      to_region: 'dim_interconnector.to_region', description: 'dim_interconnector.description' },
      where: ['dim_interconnector.interconnector IS NOT NULL'] }),
    flows: (from, to) => q({ select: { id: 'fct_interconnector.interconnector', date: 'fct_interconnector.date',
      time: 'fct_interconnector.time', mw: 'fct_interconnector.mw', export_limit: 'fct_interconnector.export_limit',
      import_limit: 'fct_interconnector.import_limit', util: m('Flow utilisation'), out: m('No flow') },
      where: [...queries.dates('fct_interconnector', from, to), ...(page.region()
        ? [`(dim_interconnector.from_region = ${str(page.region())} OR dim_interconnector.to_region = ${str(page.region())})`] : [])],
      orderBy: ['date', 'time'] }),
    flowPrices: (from, to) => q({ select: { region: 'fct_region.REGIONID', date: 'fct_region.date', time: 'fct_region.time',
      price: m('Average price'), net: m('Net interchange MW') }, where: queries.dates('fct_region', from, to) }),

    // --- History ---
    historyDays(which) {
      const region = page.region();
      return [...queries.wholeDays(which, null, shiftDate(page.newestDate(), -1)),
        ...(region ? [`dim_region.Region = ${str(region)}`] : [])];
    },
    historyShare: () => q({ select: { date: 'dim_calendar.date', re: m('Renewable share') }, where: queries.historyDays('units'), orderBy: ['date'] }),
    historyEnergy: fuels => q({ select: { date: 'dim_calendar.date', mwh: ENERGY },
      where: [...queries.historyDays('units'), `${FUEL} IN ${list(fuels)}`], orderBy: ['date'] }),
    historySolar: () => queries.historyEnergy(['Solar', ROOFTOP]),
    historyWind: () => queries.historyEnergy(['Wind']),
    historyPrice: () => q({ select: { date: 'dim_calendar.date', price: m('Average price'), demand: m('Average demand MW') },
      where: queries.historyDays('regions'), orderBy: ['date'] }),
  };
  return queries;
}
