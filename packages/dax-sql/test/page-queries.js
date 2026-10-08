import { createQueries } from '../../../dashboard/github-dax/frontend/queries.js';

const shiftDate = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const pageQueries = (state, run) => {
  const queries = createQueries({
    range: () => state.range,
    intraday: () => state.intraday,
    region: () => state.region,
    fuel: () => state.fuel,
    picked: () => state.picked,
    newestDate: () => state.newest,
    shiftDate,
    UNKNOWN: 'Unknown',
    ROOFTOP: 'Rooftop solar',
  });
  return queries.readWholeDays(run).then(() => {
    const intraday = state.intraday;
    const now = { date: state.newest, time: 1200 };
    const all = {
      regions: queries.regions,
      regionNames: queries.regionNames,
      fuels: queries.fuels,
      allDuids: queries.allDuids,
      newestDate: queries.newestDate,
      oldestDate: queries.oldestDate,
      cutoff: queries.cutoff(),
      nowByFuel: queries.nowByFuel(now, state.region),
      nowShare: queries.nowShare(now, state.region),
      nowByRegion: queries.nowByRegion(state.newest, now.time),
      generationFuel: queries.generation('fuel', intraday),
      generationDuid: queries.generation('duid', intraday),
      generationStation: queries.generation('station', intraday),
      generationNotOf: queries.generationNotOf('duid', intraday, ['WIND1']),
      generationOf: queries.generationOf('fuel', intraday, ['Wind', 'Unknown']),
      averagesFuel: queries.averages('fuel'),
      averagesStation: queries.averages('station'),
      generationAverage: queries.generationAverage(),
      stationUnits: queries.stationUnits('Coal Station'),
      demand: queries.demand(intraday),
      demandPeak: queries.demandPeak(intraday),
      price: queries.price(intraday),
      averagePrice: queries.averagePrice(),
      generatorCount: queries.generatorCount(),
      emissions: queries.emissions(intraday),
      renewableShareByPeriod: queries.renewableShareByPeriod(intraday),
      renewableShareOfRange: queries.renewableShareOfRange(),
      changeGeneration: queries.changeGeneration(),
      changePrice: queries.changePrice(),
      changeRenewables: queries.changeRenewables(),
      changeEmissions: queries.changeEmissions(),
      mapScatter: queries.mapScatter(),
      profile: queries.profile(intraday),
      curtailmentDay: queries.curtailment(false),
      curtailmentMonth: queries.curtailment(true),
      curtailmentTotal: queries.curtailmentTotal(),
      curtailedFarms: queries.curtailedFarms(),
      curtailmentLastDay: queries.curtailmentLastDay,
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
    };
    if (!intraday) all.profileMonths = queries.profileMonths();
    if (intraday) Object.assign(all, {
      batteryDay: queries.batteryDay(),
      batterySpread: queries.batterySpread(),
      batteryFleet: queries.batteryFleet(),
      flowGens: queries.flowGens(state.newest),
      flowNow: queries.flowNow(state.newest),
      flows: queries.flows(state.range.from, state.range.to),
      flowPrices: queries.flowPrices(state.range.from, state.range.to),
    });
    return Object.entries(all).map(([name, query]) => ({ name, query }));
  });
};

const newest = '2026-10-07';
const base = { newest, region: null, fuel: null, picked: [] };
export const STATES = {
  intraday: { ...base, intraday: true, range: { from: '2026-10-04', to: newest } },
  intradayRegion: { ...base, intraday: true, region: 'NSW1', range: { from: '2026-10-04', to: newest } },
  intradayFuel: { ...base, intraday: true, fuel: 'Wind', range: { from: '2026-10-04', to: newest } },
  daily: { ...base, intraday: false, range: { from: '2026-09-01', to: '2026-10-05' } },
  dailyRegion: { ...base, intraday: false, region: 'VIC1', range: { from: '2026-09-01', to: '2026-10-05' } },
  dailyUnits: { ...base, intraday: false, picked: ['WIND1', 'COAL1'], range: { from: '2026-09-01', to: '2026-10-05' } },
};
