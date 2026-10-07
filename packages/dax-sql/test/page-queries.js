// The DAX queries the dashboard page sends (dashboard/github/index.html), as it builds them:
// its `dax` object, run with the page's state stubbed (the date range, the filters).
export function pageDax(html) {
  const start = html.indexOf("const ENERGY = '[Generation MWh]'");
  const end = html.indexOf('// 2. CONSTANTS & THEME');
  if (start < 0 || end < 0) throw new Error('index.html: the DAX section was not found');
  let code = html.slice(start, end);
  code = code.slice(0, code.lastIndexOf('};') + 2);
  return new Function('state', `
    const UNKNOWN = 'Unknown', ROOFTOP = 'Rooftop solar', ROOFTOP_OWNER = 'Rooftop solar (AEMO estimate)';
    const crossFilter = state.crossFilter;
    const isIntradayMode = () => state.intraday;
    const getDateRange = () => ({ from: state.from, to: state.to });
    const activeRegion = () => state.region;
    const activeFuel = () => state.fuel;
    const document = { getElementById: () => ({ max: state.newest, value: '' }) };
    ${code}
    return dax;`);
}

// Every query of the page, in one state.
export function pageQueries(html, state) {
  const dax = pageDax(html)(state);
  const i = state.intraday, now = { date: state.newest, time: 2000 };
  const span = { from: '2026-09-20', prevFrom: '2026-09-05', last: '2026-10-05' };
  const q = {
    regions: dax.regions, regionNames: dax.regionNames, fuels: dax.fuels, allDuids: dax.allDuids,
    newestDate: dax.newestDate, oldestDate: dax.oldestDate, cutoff: dax.cutoff(),
    nowByFuel: dax.nowByFuel(now, state.region), nowShare: dax.nowShare(now, state.region), nowByRegion: dax.nowByRegion,
    generationFuel: dax.generation('fuel', i), generationDuid: dax.generation('duid', i), generationStation: dax.generation('station', i),
    averagesFuel: dax.averages('fuel'), averagesStation: dax.averages('station'), stationUnits: dax.stationUnits('Coal Station'),
    demand: dax.demand(i), price: dax.price(i), averagePrice: dax.averagePrice(), generatorCount: dax.generatorCount(),
    emissions: dax.emissions(i), renewableShareByPeriod: dax.renewableShareByPeriod(i), renewableShareOfRange: dax.renewableShareOfRange(),
    deltaGeneration: dax.deltaGeneration(span), deltaPrice: dax.deltaPrice(span), deltaRenewables: dax.deltaRenewables(span),
    deltaEmissions: dax.deltaEmissions(span), mapScatter: dax.mapScatter(), profileMonths: dax.profileMonths(), profile: dax.profile(i),
    curtailmentDay: dax.curtailment(false), curtailmentMonth: dax.curtailment(true), curtailmentTotal: dax.curtailmentTotal(),
    curtailedFarms: dax.curtailedFarms(), curtailmentLastDay: dax.curtailmentLastDay, heatmap: dax.heatmap(i), capture: dax.capture(),
    negativePrices: dax.negativePrices(i), netExports: dax.netExports(i), capacityFactor: dax.capacityFactor(),
    batteryDay: dax.batteryDay(), batterySpread: dax.batterySpread(), batteryFleet: dax.batteryFleet(), owners: dax.owners(),
    flowUnits: dax.flowUnits, flowGens: dax.flowGens(state.newest), interconnectors: dax.interconnectors,
    flows: dax.flows(state.from, state.to), flowPrices: dax.flowPrices(state.from, state.to),
    historyGeneration: dax.historyGeneration(), historyPrice: dax.historyPrice(),
  };
  return Object.entries(q).map(([name, text]) => ({ name, dax: text }));
}

// The states the tests run the page in: up to 30 days (the 5-minute tables) and beyond (the
// daily ones), with no filter and with a region, a fuel or units picked.
const base = { newest: '2026-10-07', crossFilter: { fuel: null, region: null, duids: [] }, region: '', fuel: '' };
export const STATES = {
  intraday: { ...base, intraday: true, from: '2026-10-04', to: '2026-10-07' },
  intradayRegion: { ...base, intraday: true, from: '2026-10-04', to: '2026-10-07', region: 'NSW1' },
  intradayFuel: { ...base, intraday: true, from: '2026-10-04', to: '2026-10-07', fuel: 'Wind' },
  daily: { ...base, intraday: false, from: '2026-09-01', to: '2026-10-05' },
  dailyRegion: { ...base, intraday: false, from: '2026-09-01', to: '2026-10-05', region: 'VIC1' },
  dailyUnits: { ...base, intraday: false, from: '2026-09-01', to: '2026-10-05', crossFilter: { fuel: null, region: null, duids: ['WIND1', 'COAL1'] } },
};
