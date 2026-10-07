// =============================================================================
// queries.js — what each chart of the page asks the semantic model, and the filters those
// questions are built from
// =============================================================================
// A query names the model's fields (semantic_model/model.bim): a column as 'table.column',
// a measure by its name, and says how to group, filter and order them, in the words the
// compiler knows (semantic/compiler.js lists them). The compiler turns it into what the
// engine runs. A query holds no expression of its own: a figure the model can express is a
// measure there, and the page asks for it. What stays the page's (index.html) is shaping
// rows (rename, add up the rows of a station or of a stack), the rows as they are stored
// (the filter lists, the newest interval, the Flows rows), and presentation (a share of what
// is shown, the change between two values). A word a query does not have is the owner's to
// add, not the page's.
// `fct_summary` is the generation per unit, with the price of its region on the row,
// `dim_duid` the units, `fct_region` the regions' price and demand. A query that names a
// column of `dim_duid` next to a fact reads the two joined; one that does not reads the fact
// alone (the compiler's doing).
// Rooftop solar is five units of the model (ROOFTOP_<region>, fuel ROOFTOP): every filter on
// the units reaches it, and no query adds it on its own.
// What a date range reads: the 5-minute tables up to 30 days, the daily ones beyond (they
// hold the whole days: the day still filling is in the 5-minute tables only). A query does
// not name the table: a measure picks it, as the model says (its "Reads 5 minutes"): the
// 5-minute one when the query filters or groups by the fact's own columns, the daily one when
// it goes through the dimensions. So `fact`, `unit` and `price` (grain()) are the tables
// whose date (and time), DUID and region a query uses at this grain: the fact's up to 30
// days, the dimensions' beyond, cut to the days the daily tables hold (wholeDays).
// `output`, `charging` and `demand` are in the grain's unit (MW at a time, MWh a day);
// energy and its capture price are the same measures at both.
//
// createQueries(page) takes what the page's state is, as functions: range() { from, to },
// intraday(), region(), fuel(), picked() (the units picked), units() (every unit with its
// region and fuel), newestDate(), shiftDate(date, n), and the names UNKNOWN and ROOFTOP.
// =============================================================================

export function createQueries(page) {
  const { UNKNOWN, ROOFTOP, shiftDate } = page;
  const ENERGY = 'Generation MWh', CAPTURE = 'Capture price';
  const grain = () => page.intraday()
    ? { fact: 'fct_summary', unit: 'fct_summary', price: 'fct_region', region: 'fct_region.REGIONID',
        output: 'Generation MW', charging: 'Charging MW', average: 'Average MW', demand: 'Demand MW' }
    : { fact: 'dim_calendar', unit: 'dim_duid', price: 'dim_calendar', region: 'dim_region.Region',
        output: ENERGY, charging: 'Charging MWh', average: 'Average MWh a day', demand: 'Demand MWh' };
  // The unit's fuel, and the rules on a unit the charts filter by. Storage is a rule on the
  // fuel: batteries are "Grid". A unit with no fuel is a generator, which GENERATOR says.
  // A chart that leaves storage out under the header's fuel filter uses generatorUnits():
  // with a fuel picked, the bare rule is the same thing, and with the filter on Grid the
  // engine then sees fuel = 'Grid' AND fuel <> 'Grid' and reads nothing. Storage is never
  // left out as "not storage", which the engine does not see through.
  const FUEL = 'dim_duid.FuelSourceDescriptor';
  const STORAGE = [FUEL, '=', 'Grid'];
  const GENERATOR = { any: [[FUEL, '<>', 'Grid'], [FUEL, 'blank']] };
  const generatorUnits = () => page.fuel() && page.fuel() !== UNKNOWN ? [FUEL, '<>', 'Grid'] : GENERATOR;
  const fuelIs = fuel => fuel === UNKNOWN ? [FUEL, 'blank'] : [FUEL, '=', fuel];
  // The date (and time) columns of a grain, as a select, and their names, as an order.
  const at = (table, intraday) => ({ date: `${table}.date`, ...(intraday ? { time: `${table}.time` } : {}) });
  const byTime = intraday => intraday ? ['date', 'time'] : ['date'];
  // What a series of the generation chart is: the fuel, the unit, or the unit and its station
  // (the page adds a station's units up).
  const seriesOf = (by, unit) => by === 'fuel' ? { series: FUEL }
    : by === 'duid' ? { series: `${unit}.DUID` } : { series: `${unit}.DUID`, station: 'dim_duid.StationName' };

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
    // A range cut to the days a daily table holds, on dim_calendar.
    wholeDays(which, from, to) {
      if (!wholeDaysHeld) throw new Error('the daily tables are not attached yet');
      const { first, last } = wholeDaysHeld[which];
      return queries.dates('dim_calendar', !from || from < first ? first : from, !to || to > last ? last : to);
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

    // The region filter on a regional table; a fuel or unit pick narrows it to their regions,
    // which the units' list says (rows as stored). The fuel is matched under the name the
    // charts give it, whether it came from the dropdown or a click. Rooftop solar is in every
    // region.
    priceFilters(regionCol) {
      const region = page.region(), fuel = page.fuel(), picked = page.picked();
      const regionsOf = keep => {
        const regions = [...new Set(page.units().filter(keep).map(d => d.Region).filter(Boolean))];
        return [[regionCol, 'in', regions.length ? regions : ['']]];   // '' is no region: no rows
      };
      if (region) return [[regionCol, '=', region]];
      if (picked.length) return regionsOf(d => picked.includes(d.DUID));
      if (fuel) return regionsOf(d => d.fuel === fuel);
      return [];
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
      return [[`${table}.month`, 'between', from.slice(0, 8) + '01', to]];
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
    // Per fuel at the newest interval: its output and what of it is charging; and the
    // renewable share there, the model's measure. The region filter only.
    nowFilters: (now, region) => [['fct_summary.date', '=', now.date], ['fct_summary.time', '=', now.time],
      ...(region ? [['dim_duid.Region', '=', region]] : [])],
    nowByFuel: (now, region) => ({ select: { fuel: FUEL, mw: 'Generation MW', charging: 'Charging MW' },
      where: queries.nowFilters(now, region) }),
    nowShare: (now, region) => ({ select: { share: 'Renewable share' }, where: queries.nowFilters(now, region) }),
    // The newest interval of the regional table, which can be ahead of the units': its date,
    // then its time on that date, then each region there.
    regionNewestDate: { select: { date: { max: 'fct_region.date' } } },
    regionNewestTime: date => ({ select: { time: { max: 'fct_region.time' } }, where: [['fct_region.date', '=', date]] }),
    nowByRegion: (date, time) => ({
      select: { region: 'fct_region.REGIONID', price: 'fct_region.price', demand: 'fct_region.demand', net: 'fct_region.net_interchange' },
      where: [['fct_region.date', '=', date], ['fct_region.time', '=', time]], orderBy: ['region'] }),

    // --- Dashboard: generation chart ---
    // One row per series and interval (day), with what it made and what it took (charging,
    // negative) apart: the chart draws the second as its own "<series> (charging)" series,
    // below the axis, instead of netting it into the stack. `by` is the series: the fuel,
    // the unit, or the unit's station (the page adds a station's units up; a unit without one
    // stays on its own).
    generation(by, intraday) {
      const { fact, unit, output, charging } = grain();
      return { select: { ...at(fact, intraday), ...seriesOf(by, unit), output, charging },
        where: queries.whereGen(), orderBy: [...byTime(intraday), 'series'] };
    },

    // The averages behind the generation KPIs: each series of the chart as an average MW
    // over the range, "Average generation MW" (energy over the hours the range holds). One
    // denominator, so their sum is the total.
    averages: by => ({ select: { ...seriesOf(by, grain().unit), avg: 'Average generation MW' }, where: queries.whereAll() }),

    // The units of a station, which a click on it in the drill toggles as a group.
    stationUnits: name => ({ select: { DUID: 'dim_duid.DUID' }, where: [['dim_duid.StationName', '=', name]] }),

    // --- Dashboard: demand line over the generation chart ---
    // Operational demand of the filtered region, or the sum of all regions: MW per interval
    // ("Demand MW", blank when a region has none yet, so the interval is left out and not
    // undercounted), MWh per day.
    demand(intraday) {
      const region = page.region(), { from, to } = page.range(), g = grain();
      return { select: { ...at(g.price, intraday), demand: g.demand },
        where: [...(intraday ? queries.dates(g.price, from, to) : queries.wholeDays('regions', from, to)), ...(region ? [[g.region, '=', region]] : [])],
        orderBy: byTime(intraday) };
    },

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

    // The KPIs' change against the days just before the range: a measure and its hours over
    // the range (side 1) and over the days before (side 0), on the days a daily table holds
    // (`which`). Two queries; `span` is { from, prevFrom, last }.
    delta({ from, prevFrom, last }, measure, which, filters) {
      const side = (a, b) => ({ select: { n: 'Hours', v: measure }, where: [...queries.wholeDays(which, a, b), ...filters] });
      return [side(from, last), side(prevFrom, shiftDate(from, -1))];
    },
    // The average MW of what the generation chart shows.
    deltaGeneration: span => queries.delta(span, 'Average generation MW', 'units', queries.allFilters('dim_duid')),
    deltaPrice: span => queries.delta(span, 'Average price', 'regions', queries.priceFilters('dim_region.Region')),
    deltaRenewables: span => queries.delta(span, 'Renewable share', 'units', queries.allFilters('dim_duid', false)),
    deltaEmissions: span => queries.delta(span, 'Emissions intensity', 'units', queries.allFilters('dim_duid')),

    // --- Dashboard: map ---
    mapScatter() {
      const { unit, average } = grain();
      return { select: { DUID: `${unit}.DUID`, fuel: FUEL, Region: 'dim_duid.Region', lat: 'dim_duid.latitude', lon: 'dim_duid.longitude', mw: average },
        where: [...queries.whereGen(), ['dim_duid.latitude', 'notBlank']] };
    },

    // --- Insights, renewables: average day by fuel ---
    // The units' rows are the model's measures: "Generation MW on an average day" at 5
    // minutes, "Average MW at hour" beyond, over the whole months the range touches
    // (profileMonths says which), by hour. Generators only.
    profileMonths: () => ({ select: { first: { min: 'dim_month.month' }, last: { max: 'dim_month.month' } }, where: queries.months('dim_month') }),
    profile: intraday => intraday
      ? { select: { fuel: FUEL, time: 'fct_summary.time', mw: 'Generation MW on an average day' },
          where: [...queries.whereGen(), generatorUnits()], orderBy: ['fuel', 'time'] }
      : { select: { fuel: FUEL, hour: 'fct_summary_hourly.hour', mw: 'Average MW at hour' },
          where: [...queries.months('dim_month'), ...queries.unitFilters('fct_summary_hourly'), generatorUnits()], orderBy: ['fuel', 'hour'] },

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
    // The generators' capture price and energy per fuel. The plain average next to it is
    // averagePrice.
    capture: () => ({ select: { fuel: FUEL, capture: CAPTURE, volume: ENERGY },
      where: [...queries.whereGen({ withFuel: false }), GENERATOR], having: [['volume', '>', 0]], orderBy: ['capture'] }),

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
      where: [...queries.whereAll(), ['dim_duid.RegCapMW', '>', 0], generatorUnits()],
      having: [['cf', 'notBlank']], orderBy: ['cf'] }),

    // --- Insights, fleet: batteries ---
    // Storage under the header's filters but the fuel's (the chart is about one fuel).
    batteries: () => [...queries.whereGen({ withFuel: false }), STORAGE],
    // Per time of day: the output and the charging of an average day, and the price seen.
    batteryDay: () => ({ select: { time: 'fct_summary.time', discharge: 'Generation MW on an average day',
      charge: 'Charging MW on an average day', price: 'Price seen' }, where: queries.batteries(), orderBy: ['time'] }),
    // "Sold" and "bought": the prices weighted by the energy discharged and charged.
    batterySpread: () => ({ select: { sold: CAPTURE, bought: 'Charging price' }, where: queries.batteries() }),
    // The fleet the filters leave: its units, registered MW and storage MWh.
    batteryFleet: () => ({ select: { units: 'Registered units', mw: 'Registered MW', mwh: 'Storage MWh' },
      where: [STORAGE, ...queries.unitFilters('dim_duid', false)] }),

    // --- Insights, fleet: owners ---
    // Each unit's energy with its owner and station; the page adds them up.
    owners: () => ({ select: { DUID: `${grain().unit}.DUID`, owner: 'dim_duid.Participant', station: 'dim_duid.StationName',
      fuel: FUEL, mwh: ENERGY }, where: queries.whereGen() }),

    // --- Flows ---
    // Every unit's fuel, region and position, once.
    flowUnits: { select: { DUID: 'dim_duid.DUID', fuel: FUEL, Region: 'dim_duid.Region', renewable: 'dim_duid.Renewable',
      lat: 'dim_duid.latitude', lon: 'dim_duid.longitude' } },
    // A day of the units' output, one row per unit and interval, the units at 1 MW or more
    // either way.
    flowGens: date => ({ select: { time: 'fct_summary.time', DUID: 'fct_summary.DUID', mw: 'fct_summary.mw' },
      where: [['fct_summary.date', '=', date], { any: [['fct_summary.mw', '>=', 1], ['fct_summary.mw', '<=', -1]] }] }),
    // The links between regions.
    interconnectors: { select: { id: 'dim_interconnector.interconnector', from_region: 'dim_interconnector.from_region',
      to_region: 'dim_interconnector.to_region', description: 'dim_interconnector.description' } },
    // The interconnectors' flows and limits, and each region's price, per interval.
    flows: (from, to) => ({ select: { id: 'fct_interconnector.interconnector', date: 'fct_interconnector.date',
      time: 'fct_interconnector.time', mw: 'fct_interconnector.mw', export_limit: 'fct_interconnector.export_limit',
      import_limit: 'fct_interconnector.import_limit' }, where: queries.dates('fct_interconnector', from, to), orderBy: ['date', 'time'] }),
    flowPrices: (from, to) => ({ select: { region: 'fct_region.REGIONID', date: 'fct_region.date', time: 'fct_region.time',
      price: 'fct_region.price' }, where: queries.dates('fct_region', from, to) }),

    // --- History ---
    // Every day a daily table holds, under the region filter, but the newest: it is still
    // filling, so its energy and its share are not a day's yet.
    historyDays(which) {
      const region = page.region();
      return [...queries.wholeDays(which, null, shiftDate(page.newestDate(), -1)),
        ...(region ? [['dim_region.Region', '=', region]] : [])];
    },
    // Per day: the model's renewable share; and the solar, wind and rooftop energy (rooftop
    // is solar too), per fuel.
    historyShare: () => ({ select: { date: 'dim_calendar.date', re: 'Renewable share' }, where: queries.historyDays('units'), orderBy: ['date'] }),
    historyEnergy: () => ({ select: { date: 'dim_calendar.date', fuel: FUEL, mwh: ENERGY },
      where: [...queries.historyDays('units'), [FUEL, 'in', ['Solar', 'Wind', ROOFTOP]]] }),
    historyPrice: () => ({ select: { date: 'dim_calendar.date', price: 'Average price', demand: 'Average demand MW' },
      where: queries.historyDays('regions'), orderBy: ['date'] }),
  };
  return queries;
}
