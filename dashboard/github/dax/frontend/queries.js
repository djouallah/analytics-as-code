// =============================================================================
// queries.js — what each chart of the page asks the semantic model, and the filters those
// questions are built from
// =============================================================================
// A query names the model's fields (semantic_model/model.bim): a column as 'table.column',
// a measure by its name, and says how to group, filter and order them, in the words
// semantic/query.js knows (it lists them). It writes the query as DAX, and the compiler
// (packages/dax-sql) the DAX as what the engine runs. A query holds no expression of its own, and the page works no figure out of
// what comes back: a figure is a measure of the model, a total is a `totals` row, a group is
// a column of the model, an order is an `orderBy`. The page draws the rows. A word a query
// does not have is the owner's to add, not the page's.
// `fct_summary` is the generation per unit, with the price of its region on the row,
// `dim_duid` the units, `fct_region` the regions' price and demand. A query that names a
// column of `dim_duid` next to a fact reads the two joined; one that does not reads the fact
// alone (the compiler's doing). A filter on `dim_duid` reaches the regional tables too, as
// the regions those units are in: the model's relationship from dim_duid to dim_region
// filters both ways.
// Rooftop solar is five units of the model (ROOFTOP_<region>, fuel ROOFTOP): every filter on
// the units reaches it, and no query adds it on its own.
// What a date range reads: the 5-minute tables up to 30 days, the daily ones beyond (they
// hold the whole days: the day still filling is in the 5-minute tables only). A query does
// not name the table: a measure picks it, as the model says (its "Reads 5 minutes"): the
// 5-minute one when the query filters or groups by the fact's own columns, the daily one when
// it goes through the dimensions. So `fact`, `unit` and `price` (grain()) are the tables
// whose date (and time), DUID and region a query uses at this grain: the fact's up to 30
// days, the dimensions' beyond, cut to the days the daily tables hold (wholeDays). Which
// measure a chart draws at a grain is the chart's choice, as a report visual's is: MW at a
// time, MWh a day (`output`, `charging`, `demand`).
// Raw columns are read only as the rows they are, never added up: the Flows rows (a unit's
// MW, a link's flow and limits, for the bubbles and the small charts) and the lists.
//
// createQueries(page) takes what the page's state is, as functions: range() { from, to },
// intraday(), region(), fuel(), picked() (the units picked), newestDate(), shiftDate(date, n),
// and the names UNKNOWN and ROOFTOP.
// connect(data) is what runs these queries: the data source (../storage/data.js) wrapped by
// semantic/query.js, which turns a query into DAX and the DAX into SQL over the data's views.
// =============================================================================

export { createModel as connect } from '../semantic/query.js';

export function createQueries(page) {
  const { UNKNOWN, ROOFTOP, shiftDate } = page;
  const ENERGY = 'Generation MWh', CAPTURE = 'Capture price', SHARE = 'Generation share';
  const grain = () => page.intraday()
    ? { fact: 'fct_summary', unit: 'fct_summary', price: 'fct_region', region: 'fct_region.REGIONID',
        output: 'Generation MW', charging: 'Charging MW', average: 'Average MW', demand: 'Demand with rooftop MW' }
    : { fact: 'dim_calendar', unit: 'dim_duid', price: 'dim_calendar', region: 'dim_region.Region',
        output: ENERGY, charging: 'Charging MWh', average: 'Average MWh a day', demand: 'Demand with rooftop MWh' };
  // The unit's fuel, and whether it is storage (a battery): dim_duid says, as it says what is
  // renewable. A generator is any unit that is not storage, a unit with no fuel included.
  const FUEL = 'dim_duid.FuelSourceDescriptor';
  const STORAGE = ['dim_duid.Storage', '=', true];
  const GENERATOR = ['dim_duid.Storage', '=', false];
  const fuelIs = fuel => fuel === UNKNOWN ? [FUEL, 'blank'] : [FUEL, '=', fuel];
  // Fuels by the names the charts give them: a list of them, the blank one as UNKNOWN.
  const fuelsIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN), blank = fuels.includes(UNKNOWN);
    return blank ? { any: [[FUEL, 'blank'], ...(named.length ? [[FUEL, 'in', named]] : [])] } : [FUEL, 'in', named];
  };
  const fuelsNotIn = fuels => {
    const named = fuels.filter(f => f !== UNKNOWN);
    return [...(named.length ? [{ any: [[FUEL, 'notIn', named], [FUEL, 'blank']] }] : []), ...(fuels.includes(UNKNOWN) ? [[FUEL, 'notBlank']] : [])];
  };
  // The date (and time) columns of a grain, as a select, and their names, as an order.
  const at = (table, intraday) => ({ date: `${table}.date`, ...(intraday ? { time: `${table}.time` } : {}) });
  const byTime = intraday => intraday ? ['date', 'time'] : ['date'];
  // What a series of the generation chart is: the fuel, the unit, or the plant (the station,
  // or the unit that has none: dim_duid's Plant).
  const seriesCol = (by, unit) => by === 'fuel' ? FUEL : by === 'duid' ? `${unit}.DUID` : 'dim_duid.Plant';

  // The days the daily tables hold, `units` (fct_summary_daily) and `regions`
  // (fct_region_daily), read once the aggregates are attached (readWholeDays). Beyond 30 days
  // a range is cut to them, which is what makes the days a measure adds from the 5-minute
  // table (the ones the daily table lacks) none.
  let wholeDaysHeld = null;
  const wholeDaysQuery = table => ({ select: { first: { min: `${table}.date` }, last: { max: `${table}.date` } } });

  const queries = {
    // Read the days the daily tables hold, with the page's own runner.
    async readWholeDays(run) {
      const [[units], [regions]] = await Promise.all(['fct_summary_daily', 'fct_region_daily'].map(t => run(wholeDaysQuery(t))));
      wholeDaysHeld = { units, regions };
    },
    byTime,

    // --- Filters: the conditions of a query's `where` ---
    dates: (table, from, to) => [[`${table}.date`, 'between', from, to]],
    // A range cut to the days a daily table holds, on dim_calendar; and to the newest day
    // both hold. A measure of one table can reach the other ([Hours] in an average, rooftop's
    // energy in the demand line): a day only one of them holds is one the model completes
    // from the 5-minute table, which the compiler does not (2026-10-07: for some hours each
    // night the regional table has a day the units' has not yet).
    wholeDays(which, from, to) {
      const { first, last } = queries.wholeDaysRange(which, from, to);
      return queries.dates('dim_calendar', first, last);
    },
    // The same range as dates, { first, last }: what the KPIs' change compares with.
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

    // Region / fuel / unit filters on `dim_duid` or on a fact related to it.
    unitFilters(fact, withFuel = true) {
      const region = page.region(), fuel = withFuel ? page.fuel() : null, picked = page.picked();
      return [
        ...(region ? [['dim_duid.Region', '=', region]] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [[`${fact}.DUID`, 'in', picked]] : [])];
    },

    // The header's filters on the regions, at the range's grain; or on a table named
    // outright (the measures that name the daily table).
    wherePrice(table) {
      const { from, to } = page.range(), { price, region } = grain();
      if (table) return [...queries.dates(table, from, to), ...queries.priceFilters(`${table}.REGIONID`)];
      return [...(page.intraday() ? queries.dates(price, from, to) : queries.wholeDays('regions', from, to)), ...queries.priceFilters(region)];
    },

    // The region filter on a regional table, and the fuel and unit picks on dim_duid, which
    // reach it as the regions those units are in (the model's relationship filters both ways).
    priceFilters(regionCol) {
      const region = page.region(), fuel = page.fuel(), picked = page.picked();
      return [
        ...(region ? [[regionCol, '=', region]] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [['dim_duid.DUID', 'in', picked]] : [])];
    },

    // The header's filters for a measure that reads more than the units: the regions' table
    // too ("Hours", in an average or a capacity factor).
    // Each fact gets the date range at the grain's side: up to 30 days on its own date
    // (and on dim_calendar's), beyond on dim_calendar's alone, over the days the daily
    // table holds (the regions' daily table holds them too). The region is dim_region's,
    // which reaches the units and the regions.
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
        ...(region ? [['dim_region.Region', '=', region]] : []),
        ...(fuel ? [fuelIs(fuel)] : []),
        ...(picked.length ? [[`${unit}.DUID`, 'in', picked]] : [])];
    },
    // Beyond 30 days the hour-of-day tables are by whole month: the months the range touches.
    months(table) {
      const { from, to } = page.range();
      return [[`${table}.month`, 'between', `${from.slice(0, 8)}01`, to]];
    },

    // =====================================================================
    // The queries, by tab and chart.
    // =====================================================================

    // --- Filter lists, and the dates the date inputs offer ---
    // The regions of the market: the ones that have a price (dim_region also holds
    // Western Australia, another market).
    regions: { select: { Region: 'fct_region.REGIONID' }, orderBy: ['Region'] },
    regionNames: { select: { region: 'dim_region.Region', state: 'dim_region.State' }, where: [['dim_region.State', 'notBlank']] },
    fuels: { select: { fuel: FUEL }, where: [[FUEL, 'notBlank']], orderBy: ['fuel'] },
    allDuids: { select: { DUID: 'dim_duid.DUID', Region: 'dim_duid.Region', fuel: FUEL }, orderBy: ['DUID'] },
    newestDate: { select: { d: { max: 'fct_summary.date' } } },
    oldestDate: { select: { d: { min: 'dim_calendar.date' } } },

    // --- Cutoff: the newest interval of the units, as a date and a time ---
    // On the newest date, which the date inputs know: a constant, so only that day is read.
    cutoff: () => ({ select: { date: { max: 'fct_summary.date' }, time: { max: 'fct_summary.time' } },
      where: [['fct_summary.date', '=', page.newestDate()]] }),

    // --- Dashboard: Right now ---
    // Per fuel at the newest interval: its output, what of it is charging and its share of
    // the output, and the same added up (the row `all`); the renewable share there, the
    // model's measure. The region filter only.
    nowFilters: (now, region) => [['fct_summary.date', '=', now.date], ['fct_summary.time', '=', now.time],
      ...(region ? [['dim_duid.Region', '=', region]] : [])],
    nowByFuel: (now, region) => ({ select: { fuel: FUEL, mw: 'Generation MW', charging: 'Charging MW', share: SHARE },
      totals: { all: [FUEL] }, where: queries.nowFilters(now, region) }),
    nowShare: (now, region) => ({ select: { share: 'Renewable share' }, where: queries.nowFilters(now, region) }),
    // The output of some fuels together at that interval: the hero's "Other".
    nowOf: (now, region, fuels) => ({ select: { mw: 'Generation MW' }, where: [...queries.nowFilters(now, region), fuelsIn(fuels)] }),
    // The newest interval of the regional table, which can be ahead of the units': its date,
    // then its time on that date, then each region there.
    regionNewestDate: { select: { date: { max: 'fct_region.date' } } },
    regionNewestTime: date => ({ select: { time: { max: 'fct_region.time' } }, where: [['fct_region.date', '=', date]] }),
    nowByRegion: (date, time) => ({
      select: { region: 'fct_region.REGIONID', price: 'Average price', demand: 'Demand MW', net: 'Net interchange MW' },
      where: [['fct_region.date', '=', date], ['fct_region.time', '=', time]], orderBy: ['region'] }),

    // --- Dashboard: generation chart ---
    // One row per series and interval (day), with what it made and what it took (charging,
    // negative) apart: the chart draws the second as its own "<series> (charging)" series,
    // below the axis, instead of netting it into the stack; and per interval the series added
    // up (`all`), the height of the stack. `by` is the series: the fuel, the unit, or the
    // plant. By fuel each row also has its share of the interval's output (the hero's).
    generation(by, intraday) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return { select: { ...at(fact, intraday), series, output, charging, ...(by === 'fuel' ? { share: SHARE } : {}) },
        totals: { all: [series] }, where: queries.whereGen(), orderBy: [...byTime(intraday), 'series'] };
    },
    // The series the chart does not draw one by one, added up per interval: "Other units"
    // in a drill, the hero's "Other" fuels.
    generationOf(by, intraday, shown) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return { select: { ...at(fact, intraday), output, charging },
        where: [...queries.whereGen(), ...(by === 'fuel' ? [fuelsIn(shown)] : [[series, 'in', shown]])], orderBy: byTime(intraday) };
    },
    generationNotOf(by, intraday, shown) {
      const { fact, unit, output, charging } = grain(), series = seriesCol(by, unit);
      return { select: { ...at(fact, intraday), output, charging },
        where: [...queries.whereGen(), ...(by === 'fuel' ? fuelsNotIn(shown) : [[series, 'notIn', shown]])], orderBy: byTime(intraday) };
    },

    // The averages behind the generation KPIs: each series of the chart as an average MW
    // over the range, "Average generation MW" (energy over the hours the range holds), the
    // largest first (the chart's order), with its share of the output; and the same for all
    // of them (`generationAverage`).
    averages: by => ({ select: { series: seriesCol(by, grain().unit), avg: 'Average generation MW', share: SHARE },
      where: queries.whereAll(), orderBy: [['avg', 'desc']] }),
    generationAverage: () => ({ select: { avg: 'Average generation MW' }, where: queries.whereAll() }),

    // The units of a plant, which a click on it in the drill toggles as a group.
    stationUnits: name => ({ select: { DUID: 'dim_duid.DUID' }, where: [['dim_duid.Plant', '=', name]] }),

    // --- Dashboard: demand line over the generation chart ---
    // Operational demand of the filtered region, or of all of them, with the rooftop solar
    // the stack has: "Demand with rooftop MW" per interval (blank when a region has none
    // yet), MWh per day. Through the dimensions, which reach the regions and the units. And
    // its peak, the largest of those rows.
    demand(intraday) {
      const region = page.region(), { from, to } = page.range(), g = grain();
      return { select: { date: 'dim_calendar.date', ...(intraday ? { time: 'dim_time.time' } : {}), demand: g.demand },
        where: [...(intraday ? queries.dates('dim_calendar', from, to) : queries.wholeDays('regions', from, to)), ...(region ? [['dim_region.Region', '=', region]] : [])],
        orderBy: byTime(intraday) };
    },
    demandPeak: intraday => ({ ...queries.demand(intraday), orderBy: [['demand', 'desc']], top: 1 }),

    // --- Dashboard: price chart ---
    // Per region, and with them the rows of all the regions together ("total"): the
    // sparkline of the price KPI.
    price(intraday) {
      const { price, region } = grain();
      return { select: { ...at(price, intraday), Region: region, avg_price: 'Average price' }, totals: { total: [region] },
        where: queries.wherePrice(), orderBy: byTime(intraday) };
    },
    // The plain average over the range: the price KPI, and the capture chart's dashed line.
    averagePrice: () => ({ select: { avg: 'Average price' }, where: queries.wherePrice() }),

    // --- Dashboard: KPIs (and the Renewables chart, which draws the KPI's rows) ---
    generatorCount: () => ({ select: { cnt: 'Units' }, where: queries.whereGen() }),
    // Emissions of what the generation chart shows (rooftop solar has no factor):
    // the model's tonnes and intensity per interval (day), the sparkline, and over the
    // range, the subtotal row ("all"). One query: the range is one more set of rows.
    emissions(intraday) {
      const keys = at(grain().fact, intraday);
      return { select: { ...keys, t: 'Emissions t', i: 'Emissions intensity' }, totals: { all: Object.values(keys) },
        where: queries.whereGen(), orderBy: byTime(intraday) };
    },

    // Renewable share, the model's measure: per interval (day) and over the range. The fuel
    // filter is ignored on purpose.
    renewableShareByPeriod: intraday => ({ select: { ...at(grain().fact, intraday), share: 'Renewable share' },
      where: queries.whereGen({ withFuel: false }), orderBy: byTime(intraday) }),
    renewableShareOfRange: () => ({ select: { share: 'Renewable share' }, where: queries.whereGen({ withFuel: false }) }),

    // The KPIs' change against the days just before the range, as many: the model's
    // "... change" measures, over the days the daily tables hold (`which`), blank when either
    // side lacks an hour of its days.
    change(measure, which, filters) {
      const { from, to } = page.range();
      return { select: { v: measure }, where: [...queries.wholeDays(which, from, to), ...filters] };
    },
    changeGeneration: () => queries.change('Average generation MW change', 'units', queries.allFilters('dim_duid')),
    changePrice: () => queries.change('Average price change', 'regions', queries.priceFilters('dim_region.Region')),
    changeRenewables: () => queries.change('Renewable share change', 'units', queries.allFilters('dim_duid', false)),
    changeEmissions: () => queries.change('Emissions intensity change', 'units', queries.allFilters('dim_duid')),

    // --- Dashboard: map ---
    mapScatter() {
      const { unit, average } = grain();
      return { select: { DUID: `${unit}.DUID`, fuel: FUEL, Region: 'dim_duid.Region', lat: 'dim_duid.latitude', lon: 'dim_duid.longitude', mw: average },
        where: [...queries.whereGen(), ['dim_duid.latitude', 'notBlank']] };
    },

    // --- Insights, renewables: average day by fuel ---
    // The units' rows are the model's measures: "Generation MW on an average day" at 5
    // minutes, "Average MW at hour" beyond, over the whole months the range touches
    // (profileMonths says which), by time or hour. Generators only. The fuels are drawn in
    // the generation chart's order (averages('fuel')).
    profileMonths: () => ({ select: { first: { min: 'dim_month.month' }, last: { max: 'dim_month.month' } }, where: queries.months('dim_month') }),
    profile: intraday => intraday
      ? { select: { fuel: FUEL, time: 'fct_summary.time', mw: 'Generation MW on an average day' },
          where: [...queries.whereGen(), GENERATOR], orderBy: ['time', 'fuel'] }
      : { select: { fuel: FUEL, hour: 'fct_summary_hourly.hour', mw: 'Average MW at hour' },
          where: [...queries.months('dim_month'), ...queries.unitFilters('fct_summary_hourly'), GENERATOR], orderBy: ['hour', 'fuel'] },

    // --- Insights, renewables: curtailment ---
    // Per day (per month with `byMonth`, by year and month of the calendar) and fuel: the
    // curtailed and available energy and the rate, the model's measures. With no unit picked
    // they are fct_curtailment_region's (the farms to their newest day, AEMO's regional
    // figures after); with units picked, the farms' own (fct_curtailment), under the unit
    // filters. `curtailmentTotal` is the same over the range.
    curtailmentFrom() {
      const { from, to } = page.range(), region = page.region(), fuel = page.fuel();
      const dates = queries.dates('dim_calendar', from, to);
      return page.picked().length
        ? { fuel: FUEL, cur: 'Curtailed MWh', avail: 'Available MWh', rate: 'Curtailment rate',
            filters: [...dates, ...queries.unitFilters('fct_curtailment')] }
        : { fuel: 'fct_curtailment_region.fuel', cur: 'Wind and solar curtailed MWh',
            avail: 'Wind and solar available MWh', rate: 'Wind and solar curtailment rate',
            filters: [...dates, ...(region ? [['fct_curtailment_region.REGIONID', '=', region]] : []),
              ...(fuel ? [['fct_curtailment_region.fuel', '=', fuel]] : [])] };
    },
    curtailment(byMonth) {
      const f = queries.curtailmentFrom();
      const keys = byMonth ? { year: 'dim_calendar.year', month: 'dim_calendar.month' } : { date: 'dim_calendar.date' };
      return { select: { ...keys, fuel: f.fuel, cur: f.cur, avail: f.avail, rate: f.rate },
        where: f.filters, orderBy: [...Object.keys(keys), 'fuel'] };
    },
    curtailmentTotal() {
      const f = queries.curtailmentFrom();
      return { select: { cur: f.cur, rate: f.rate }, where: f.filters };
    },
    // The 15 farms that lost the most.
    curtailedFarms() {
      const { from, to } = page.range();
      return { select: { DUID: 'dim_duid.DUID', fuel: FUEL, station: 'dim_duid.StationName', cur: 'Curtailed MWh', rate: 'Curtailment rate' },
        where: [...queries.dates('fct_curtailment', from, to), ...queries.unitFilters('fct_curtailment')],
        having: [['cur', '>', 0]], orderBy: [['cur', 'desc']], top: 15 };
    },
    curtailmentLastDay: { select: { d: { max: 'fct_curtailment.date' } } },

    // --- Insights, market: price by hour of day ---
    // x date up to 30 days; beyond, x month, from the hour-of-day table.
    heatmap: intraday => intraday
      ? { select: { date: 'fct_region.date', y: 'dim_time.hour', price: 'Average price' }, where: queries.wherePrice(), orderBy: ['date', 'y'] }
      : { select: { date: 'fct_region_hourly.month', y: 'fct_region_hourly.hour', price: 'Price at hour' },
          where: [...queries.months('fct_region_hourly'), ...queries.priceFilters('fct_region_hourly.REGIONID')], orderBy: ['date', 'y'] },

    // --- Insights, market: capture price by fuel ---
    // The generators' capture price and energy per fuel, the fuels with half a percent or more
    // of their output. The plain average next to it is averagePrice.
    capture: () => ({ select: { fuel: FUEL, capture: CAPTURE, volume: ENERGY, share: SHARE },
      where: [...queries.whereGen({ withFuel: false }), GENERATOR], having: [['volume', '>', 0], ['share', '>=', 0.5]], orderBy: ['capture'] }),

    // --- Insights, market: negative prices ---
    // Two figures, each its own measure: the share of 5-minute intervals, and beyond 30
    // days the share of days, which names the daily table.
    negativePrices(intraday) {
      const [p, pct, lowest] = intraday ? ['fct_region', 'Negative price share', 'Lowest price']
        : ['fct_region_daily', 'Negative price days share', 'Lowest daily price'];
      return { select: { region: `${p}.REGIONID`, pct, lowest }, where: queries.wherePrice(p), orderBy: ['region'] };
    },

    // --- Insights, market: net exports by region ---
    netExports(intraday) {
      const { price, region } = grain();
      return { select: { ...at(price, intraday), region, mw: 'Net interchange MW' },
        where: queries.wherePrice(), orderBy: [...byTime(intraday), 'region'] };
    },

    // --- Insights, fleet: capacity factor ---
    // The model's "Capacity factor" at two grains in one query: per unit, and per fuel (the
    // rows on which `total` is true). Energy over what the registered capacity of the units
    // with output ("Capacity MW") could make in the hours the price data holds for the range.
    // Grouped by the unit's own key (dim_duid.DUID), which brings its station with it. A unit
    // pick is on the fact, so the units that made nothing in the range are rows too: they
    // have no capacity factor.
    capacityFactor: () => ({
      select: { fuel: FUEL, DUID: 'dim_duid.DUID', station: 'dim_duid.StationName', cap: 'Capacity MW', cf: 'Capacity factor' },
      totals: { total: ['dim_duid.DUID', 'dim_duid.StationName'] },
      where: [...queries.whereAll(), ['dim_duid.RegCapMW', '>', 0], GENERATOR],
      having: [['cf', 'notBlank']], orderBy: ['cf'] }),

    // --- Insights, fleet: batteries ---
    // Storage under the header's filters but the fuel's (the chart is about one fuel).
    batteries: () => [...queries.whereGen({ withFuel: false }), STORAGE],
    // Per time of day: the output and the charging of an average day, and the price seen.
    batteryDay: () => ({ select: { time: 'fct_summary.time', discharge: 'Generation MW on an average day',
      charge: 'Charging MW on an average day', price: 'Price seen' }, where: queries.batteries(), orderBy: ['time'] }),
    // "Sold" and "bought": the prices weighted by the energy discharged and charged, and the
    // spread between them.
    batterySpread: () => ({ select: { sold: CAPTURE, bought: 'Charging price', spread: 'Battery spread' }, where: queries.batteries() }),
    // The fleet the filters leave: its units, registered MW and storage MWh.
    batteryFleet: () => ({ select: { units: 'Registered units', mw: 'Registered MW', mwh: 'Storage MWh' },
      where: [STORAGE, ...queries.unitFilters('dim_duid', false)] }),

    // --- Insights, fleet: owners ---
    // The energy by owner and plant (and the plant's fuel), with its share of the output
    // shown; and each owner's share (ownerShares).
    owners: () => ({ select: { owner: 'dim_duid.Owner', plant: 'dim_duid.Plant', fuel: FUEL, mwh: ENERGY, share: SHARE },
      where: queries.whereGen(), having: [['mwh', '>', 0]], orderBy: [['mwh', 'desc']] }),
    ownerShares: () => ({ select: { owner: 'dim_duid.Owner', mwh: ENERGY, share: SHARE },
      where: queries.whereGen(), having: [['mwh', '>', 0]] }),

    // --- Flows ---
    // Every unit's fuel, region and position, once.
    flowUnits: { select: { DUID: 'dim_duid.DUID', fuel: FUEL, storage: 'dim_duid.Storage',
      lat: 'dim_duid.latitude', lon: 'dim_duid.longitude' } },
    // A day of the units' output in the region filter, one row per unit and interval, the
    // units at 1 MW or more either way: the bubbles. The MW is a measure, not the column: a
    // query of a fact's columns alone is not filtered by a dimension in Power BI (no measure
    // to be blank), so the region would not reach it.
    flowGens: date => ({ select: { time: 'fct_summary.time', DUID: 'fct_summary.DUID', mw: 'Average MW' },
      where: [['fct_summary.date', '=', date], { any: [['fct_summary.mw', '>=', 1], ['fct_summary.mw', '<=', -1]] },
        ...(page.region() ? [['dim_duid.Region', '=', page.region()]] : [])] }),
    // A day of what the generators made and their renewable share, per interval, in the
    // region filter: the readout under the clock.
    flowNow: date => ({ select: { time: 'fct_summary.time', mw: 'Generation MW', share: 'Renewable share' },
      where: [['fct_summary.date', '=', date], GENERATOR, ...(page.region() ? [['dim_duid.Region', '=', page.region()]] : [])] }),
    // The links between regions.
    interconnectors: { select: { id: 'dim_interconnector.interconnector', from_region: 'dim_interconnector.from_region',
      to_region: 'dim_interconnector.to_region', description: 'dim_interconnector.description' } },
    // The interconnectors' flows and limits per interval (the rows, for the small charts),
    // with the share of the limit and whether the link is out (the model's); with a region
    // filter, the links that start or end there.
    flows: (from, to) => ({ select: { id: 'fct_interconnector.interconnector', date: 'fct_interconnector.date',
      time: 'fct_interconnector.time', mw: 'fct_interconnector.mw', export_limit: 'fct_interconnector.export_limit',
      import_limit: 'fct_interconnector.import_limit', util: 'Flow utilisation', out: 'No flow' },
      where: [...queries.dates('fct_interconnector', from, to), ...(page.region()
        ? [{ any: [['dim_interconnector.from_region', '=', page.region()], ['dim_interconnector.to_region', '=', page.region()]] }] : [])],
      orderBy: ['date', 'time'] }),
    // Each region's price and net interchange per interval.
    flowPrices: (from, to) => ({ select: { region: 'fct_region.REGIONID', date: 'fct_region.date', time: 'fct_region.time',
      price: 'Average price', net: 'Net interchange MW' }, where: queries.dates('fct_region', from, to) }),

    // --- History ---
    // Every day a daily table holds, under the region filter, but the newest: it is still
    // filling, so its energy and its share are not a day's yet.
    historyDays(which) {
      const region = page.region();
      return [...queries.wholeDays(which, null, shiftDate(page.newestDate(), -1)),
        ...(region ? [['dim_region.Region', '=', region]] : [])];
    },
    // Per day: the model's renewable share; the energy of solar (rooftop's included) and of wind.
    historyShare: () => ({ select: { date: 'dim_calendar.date', re: 'Renewable share' }, where: queries.historyDays('units'), orderBy: ['date'] }),
    historyEnergy: fuels => ({ select: { date: 'dim_calendar.date', mwh: ENERGY },
      where: [...queries.historyDays('units'), [FUEL, 'in', fuels]], orderBy: ['date'] }),
    historySolar: () => queries.historyEnergy(['Solar', ROOFTOP]),
    historyWind: () => queries.historyEnergy(['Wind']),
    historyPrice: () => ({ select: { date: 'dim_calendar.date', price: 'Average price', demand: 'Average demand MW' },
      where: queries.historyDays('regions'), orderBy: ['date'] }),
  };
  return queries;
}
