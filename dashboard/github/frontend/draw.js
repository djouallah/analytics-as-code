// =============================================================================
// draw.js — how the page draws what the model answered: scales, sizes, order and text
// =============================================================================
// The one place of the page where numbers are worked with, and none of it is a figure: a
// figure is a measure of the model, its total a `totals` row, its group a column
// (frontend/queries.js). What is here takes values as the model gave them and decides how
// they are drawn: which row is the largest (a record, a peak, the top series), the order of
// a list, where an axis is cut, how big a bubble or how thick an arrow is, how a number is
// written. Nothing here is added up into something the page then shows as a value.
// =============================================================================

// The row with the largest (smallest) value of `key`, or null: a peak, a record, the top one.
export const largestBy = (rows, key) => rows.reduce((best, r) => best == null || key(r) > key(best) ? r : best, null);
export const smallestBy = (rows, key) => rows.reduce((best, r) => best == null || key(r) < key(best) ? r : best, null);

// The rows ordered by `key` (a number or a text), ascending, or descending with 'desc'; rows
// with the same key keep their order.
const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0;
export const orderBy = (rows, key, dir = 'asc') =>
  [...rows].sort((a, b) => dir === 'desc' ? compare(key(b), key(a)) : compare(key(a), key(b)));
// The item after (or before) one in a list, round the end: the next tab on an arrow key.
export const cycle = (list, item, step) => list[(list.indexOf(item) + step + list.length) % list.length];
// How many series a drill draws after one more click on "Other units".
export const moreOf = (shown, step) => shown + step;
// The i-th of a list, round the end: a palette's colour for the i-th series.
export const pick = (list, i) => list[i % list.length];
// A list index for a name, the same every time: a colour for a fuel the palette has no entry for.
export const hashIndex = (name, n) => Math.abs([...name].reduce((h, c) => h * 31 + c.charCodeAt(0) | 0, 0)) % n;

// An index kept inside a list of n items.
export const clampIndex = (i, n) => Math.max(0, Math.min(i, n - 1));

// An axis cut at two percentiles of the values drawn, rounded out to `step`, and the lower
// end at zero or below: one $15k interval would otherwise flatten a week of $50-150 prices.
export function axisClip(values, lo, hi, step) {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  if (!sorted.length) return {};
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const nice = v => Math.sign(v) * Math.ceil(Math.abs(v) / step) * step;
  return { lo: Math.min(0, nice(at(lo))), hi: nice(at(hi)) };
}
// The two percentiles themselves, for a colour scale; the upper one kept above the lower.
export function percentiles(values, lo, hi) {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { lo: at(lo), hi: Math.max(at(hi), at(lo) + 1e-6) };
}

// --- Dates and times of the page's state (not of the data) ---
// The days from one date to another: `daysApart` the difference (a range of 3 days apart is
// 4 days long), `dayCount` both counted, how a range is named ("previous 4 days").
export const daysApart = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const dayCount = (from, to) => daysApart(from, to) + 1;
// A date string moved by n days.
export function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// A time as the files hold it (HHMM, a number) written as HH:MM.
export const formatTime = time => `${String(Math.floor(time / 100)).padStart(2, '0')}:${String(time % 100).padStart(2, '0')}`;
// The Flows player: the frame a day on (288 five-minute frames), the step a tick moves at a
// speed, and the wait between ticks (a day plays in about 15 s at 1x).
export const dayAhead = (frame, n) => Math.min(frame + 288, n - 1);
export const playStep = (frame, speed) => frame + Math.max(1, Math.round(speed));
export const playDelay = speed => Math.round(50 / Math.min(1, speed));
// What a render cost, for the status bar's tooltip: queries run and seconds.
export const renderCost = (ranBefore, ranNow, started, now) => {
  const ran = ranNow - ranBefore;
  return `${ran} ${ran === 1 ? 'query' : 'queries'}, ${((now - started) / 1000).toFixed(2)} s`;
};

// --- Text ---
// A value as the chart draws it: to a tenth, to a cent.
export const round1 = v => v == null ? null : Math.round(v * 10) / 10;
export const round2 = v => v == null ? null : Math.round(v * 100) / 100;
// Axis labels in thousands: 12k, or 1.5k with `digits`; MWh as M and k.
export const kLabel = (v, digits = 0) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(digits)}k` : v;
export const mwhAxis = v => v >= 1e6 ? `${v / 1e6}M` : v >= 1000 ? `${v / 1000}k` : v;
export const fmtGwh = v => `${(v / 1000).toFixed(1)} GWh`;
export const fmtMwh = v => v >= 1e6 ? `${(v / 1e6).toFixed(2)} TWh` : v >= 10000 ? fmtGwh(v) : `${Math.round(v).toLocaleString()} MWh`;
export const fmtTonnes = t => t >= 1e6 ? `${(t / 1e6).toFixed(1)} Mt` : `${Math.round(t / 1e3).toLocaleString()} kt`;
// A MW figure without its sign (the direction is said in words), to the MW, half away from zero.
export const fmtMwAbs = v => Math.round(Math.abs(v)).toLocaleString();

// --- The CSV of Analyze ---
// The rows of a SQL query written out as a CSV file, batch by batch as the engine sends them,
// every value as it is stored (a date as a date, a timestamp without its zone). Returns the
// number of rows written.
function csvCell(v, kind) {
  if (v == null) return '';
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number' && kind.startsWith('Date')) v = new Date(v).toISOString().slice(0, 10);
  else if (typeof v === 'number' && kind.startsWith('Timestamp')) v = new Date(v).toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '');
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export async function writeCsv(conn, sql, filename) {
  try {
    const reader = await conn.send(sql);
    const chunks = [];
    let rowCount = 0;
    for await (const batch of reader) {
      const cols = batch.schema.fields.map(f => f.name), kinds = batch.schema.fields.map(f => String(f.type));
      let chunk = rowCount || chunks.length ? '' : `${cols.join(',')}\n`;
      const n = Number(batch.numRows);
      for (let i = 0; i < n; i++) chunk += `${cols.map((c, j) => csvCell(batch.getChild(c).get(i), kinds[j])).join(',')}\n`;
      chunks.push(chunk);
      rowCount += n;
      await new Promise(r => setTimeout(r, 0));   // the page stays responsive
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return rowCount;
  } finally {
    await conn.close();
  }
}

// --- Sizes and places ---
// A pinned label goes on the side of the point with room: left past the middle of the axis.
export const pinSide = (x, n) => x > n / 2 ? 'left' : 'right';
// A number counting from one value to another, `t` of the way (0 to 1), easing out; and how
// far an animation of `ms` is at `now`.
export const easeTo = (from, to, t) => from + (to - from) * (1 - Math.pow(1 - t, 3));
export const progress = (now, t0, ms) => Math.min(1, (now - t0) / ms);
// The hover card's place: under the pointer, centred, kept inside the window.
export const tipPlace = (x, y, w, width) => ({ left: Math.max(8, Math.min(x - w / 2, width - w - 8)), top: y + 18 });
// The hero legend's columns: its chips in two even rows when each still gets `min` px (a
// little less is allowed), else in three.
export const legendColumns = (n, width, minRem, rem) => width / Math.ceil(n / 2) >= 0.9 * minRem * rem ? Math.ceil(n / 2) : Math.ceil(n / 3);
// The History calendar: a strip per year. On one screen the years fill the box, in as many
// columns as keep the day cells closest to square; where the page scrolls, a strip per year
// as tall as it needs (`height`).
export function calendarLayout(years, W, boxH, fit) {
  if (!fit) {
    const STRIP = 140;
    return { height: 55 + years * STRIP, at: i => ({ top: 70 + i * STRIP, left: 70, right: 20, cellSize: ['auto', 15] }) };
  }
  const H = boxH - 60;
  const cols = [1, 2, 3].map(c => {
    const rows = Math.ceil(years / c);
    return { c, rows, cell: Math.min((W / c - 70) / 53, (H / rows - 36) / 7) };
  }).reduce((a, b) => b.cell > a.cell ? b : a);
  const cw = W / cols.c, rh = H / cols.rows;
  return { height: null, at: i => ({ left: Math.round((i % cols.c) * cw + 60), top: Math.round(60 + Math.floor(i / cols.c) * rh + 22),
    width: Math.round(cw - 74), height: Math.round(rh - 34) }) };
}
// A band from one line to another, as ECharts stacks it: the lower line, then the gap.
export const bandSeries = (lows, highs) => [lows, lows.map((v, i) => v == null || highs[i] == null ? null : highs[i] - v)];
// A share of a limit (%) as a bar's width, full at 100.
export const barPercent = pct => Math.min(100, Math.round(pct));
// A generator's bubble, by its output against the output drawn largest.
export const bubbleSize = (mw, full) => 3 + 20 * Math.sqrt(Math.min(1, Math.abs(mw) / full));
// A link's arrow, by its flow against the largest flow shown (150 MW at least), and whether
// it is big enough to carry its label.
const arrowScale = largest => Math.max(150, Math.abs(largest));
export const arrowWidth = (mw, largest) => 2 + 9 * Math.abs(mw) / arrowScale(largest);
export const arrowLabelled = (mw, largest) => Math.abs(mw) >= 0.08 * arrowScale(largest);
// A region's dot, by its net interchange.
export const dotSize = net => 9 + Math.min(14, Math.abs(net) / 120);
// A unit on the generator map, by its output against the largest shown.
export const unitSize = (mw, largest) => Math.max(5, Math.sqrt(Math.max(mw, 0) / Math.max(1, largest)) * 25);

// A sparkline of the values as given, one point each, scaled to a W x H box; with `clip`
// the scale ends at the 2nd and 98th percentiles, so one spike doesn't flatten the rest.
export function sparkline(values, W, H, clip) {
  let v = values.filter(x => x != null && isFinite(x));
  if (v.length < 2) return null;
  if (clip) {
    const { lo, hi } = percentiles(v, 0.02, 0.98);
    v = v.map(x => Math.min(hi, Math.max(lo, x)));
  }
  const min = Math.min(...v), span = (Math.max(...v) - min) || 1;
  return v.map((p, i) => `${(i * W / (v.length - 1)).toFixed(1)},${(H - 2 - (p - min) / span * (H - 4)).toFixed(1)}`).join(' ');
}

// --- Night on the Flows map ---
// Where the sun is below the horizon at an interval (NEM time, UTC+10): from the sun's
// declination and the equation of time, astronomy, not data. One polygon per band, the
// sun 0, 6 and 12 degrees under the horizon, each drawn over the last, so dusk and dawn
// are lighter than the night. Along a parallel of this window the night is one end of
// it (the window is too narrow to hold both a sunset and a sunrise): the polygon is that
// end, cut where the sun sets, found by bisection.
const NIGHT_LON = [95, 175], NIGHT_LAT = [-60, 5];
export function nightBands(date, hhmm) {
  const rad = Math.PI / 180;
  const [y, m, d] = date.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, +hhmm.slice(0, 2) - 10, +hhmm.slice(2));
  const day = (utc - Date.UTC(y, 0, 1)) / 86400000;
  const decl = -23.44 * rad * Math.cos(2 * Math.PI * (day + 10) / 365);
  const b = 2 * Math.PI * (day - 81) / 364;
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);   // minutes
  const hours = ((utc / 3600000) % 24 + 24) % 24;
  const sunLon = -15 * (hours - 12 + eot / 60);
  const elevation = (lon, lat) => Math.asin(Math.sin(lat * rad) * Math.sin(decl)
    + Math.cos(lat * rad) * Math.cos(decl) * Math.cos((lon - sunLon) * rad)) / rad;
  const [w, e] = NIGHT_LON, lats = [];
  for (let lat = NIGHT_LAT[0]; lat <= NIGHT_LAT[1]; lat += 0.5) lats.push(lat);
  return [0, -6, -12].map(below => {
    const dark = (lon, lat) => elevation(lon, lat) < below;
    const rows = lats.map(lat => ({ lat, w: dark(w, lat), e: dark(e, lat) }));
    const east = rows.filter(r => r.e && !r.w).length, west = rows.filter(r => r.w && !r.e).length;
    if (!east && !west) return rows.some(r => r.w) ? [[w, lats[0]], [e, lats[0]], [e, lats.at(-1)], [w, lats.at(-1)]] : null;
    const sunset = r => {
      let lo = w, hi = e;
      for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (dark(mid, r.lat) === r.w) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    // Night on the east end: from the sunset line to the east edge; on the west, the mirror.
    const cut = east >= west
      ? rows.map(r => [r.w && r.e ? w : !r.e ? e : sunset(r), r.lat])
      : rows.map(r => [r.w && r.e ? e : !r.w ? w : sunset(r), r.lat]);
    const edge = (east >= west ? [...rows].reverse().map(r => [e, r.lat]) : [...rows].reverse().map(r => [w, r.lat]));
    return [...cut, ...edge];
  }).filter(Boolean);
}
