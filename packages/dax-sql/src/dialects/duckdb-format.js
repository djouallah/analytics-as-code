// FORMAT on DuckDB: what format.js reads a pattern into, as SQL.
//
// A value is bound once with a list comprehension ([body FOR v IN [value]][1]), so the body can
// use it many times without computing it again. Numbers are rounded the way Excel and VB do: to
// 15 significant digits first (printf %.14e), then half away from zero at the decimal places
// the pattern shows, in DECIMAL arithmetic, so 1.005 with "0.00" is "1.01".

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const bind = (name, value, body) => `[${body} FOR ${name} IN [${value}]][1]`;
const cat = parts => (parts.length ? (parts.length === 1 ? parts[0] : `(${parts.join(' || ')})`) : "''");

// --- numbers ---------------------------------------------------------------------------

// A value as DAX's General Number writes it (15 significant digits, 1E+20 beyond them).
export function generalNumber(x, t) {
  if (t === 'int') return `CAST(${x} AS VARCHAR)`;
  if (t === 'bool') return `CASE ${x} WHEN TRUE THEN 'True' WHEN FALSE THEN 'False' END`;
  return `upper(printf('%.15g', CAST(${x} AS DOUBLE)))`;
}

// m >= 0 rounded to n places, as text with n decimals ("1234.50").
function digits(m, n, whole) {
  const zeros = n ? ` || '.${'0'.repeat(n)}'` : '';
  if (whole) return `(CAST(${m} AS VARCHAR)${zeros})`;
  const e = `printf('%.14e', ${m})`;
  // Beyond 15 digits there is no fraction left: the 15 digits, then zeros.
  return `CASE WHEN ${m} < 1e15 THEN CAST(round(CAST(${e} AS DECIMAL(38,22)), ${n}) AS VARCHAR)
    ELSE replace(split_part(${e}, 'e', 1), '.', '') || repeat('0', CAST(split_part(${e}, 'e', 2) AS INTEGER) - 14)${zeros} END`;
}
const rounded = (m, n) => `CASE WHEN ${m} < 1e15 THEN round(CAST(printf('%.14e', ${m}) AS DECIMAL(38,22)), ${n}) ELSE ${m} END`;

const hasDigits = sec => sec.nInt + sec.nFrac + sec.nExp > 0 || sec.point;
const isWhole = (sec, t) => t === 'int' && !sec.scale && !sec.sci;
function scaled(sec, a, t) {
  const up = 100 ** sec.pct, down = 1000 ** sec.scale;
  if (up === 1 && down === 1) return a;
  return `(${a}${up > 1 ? ` * ${up}` : ''}${down > 1 ? ` / ${down}` : ''})`;
}

// Whether a >= 0 shows as zero in the section (the negative one, then, shows the zero one).
function roundsToZero(sec, a, t) {
  if (!hasDigits(sec)) return 'FALSE';
  if (sec.sci) return `(${a} = 0)`;
  const m = scaled(sec, a, t);
  return isWhole(sec, t) ? `(${m} = 0)` : `(${rounded(m, sec.nFrac)} = 0)`;
}

// a >= 0 in one section.
function section(sec, a, t) {
  if (!hasDigits(sec)) return cat(sec.tokens.filter(x => x.t === 'lit').map(x => q(x.v)));
  const m = scaled(sec, a, t), n = sec.nFrac;
  if (!sec.sci) return bind('dax_fr', digits(m, n, isWhole(sec, t)), assemble(sec, 'dax_fr', null));
  // The exponent puts nInt digits before the point; one more when rounding carries (9.996 -> 10.00).
  const k = Math.max(sec.nInt, 1);
  const e0 = `CASE WHEN ${m} = 0 THEN 0 ELSE CAST(floor(log10(${m})) AS INTEGER) - ${k - 1} END`;
  const e = `dax_fe0 + CASE WHEN ${m} > 0 AND ${rounded(`${m} / power(10, dax_fe0)`, n)} >= ${10 ** k} THEN 1 ELSE 0 END`;
  return bind('dax_fe0', e0, bind('dax_fe', e, bind('dax_fr', digits(`${m} / power(10, dax_fe)`, n, false), assemble(sec, 'dax_fr', 'dax_fe'))));
}

// The section's text from r, the rounded digits ("1234.50"), and e, the exponent.
function assemble(sec, r, e) {
  const n = sec.nFrac;
  const int = n ? `split_part(${r}, '.', 1)` : r;
  let d = `CASE WHEN ${int} = '0' THEN '' ELSE ${int} END`;   // "#.##" shows 0.5 as .5
  if (sec.nZeroInt) d = `lpad(${d}, CAST(greatest(length(${d}), ${sec.nZeroInt}) AS INTEGER), '0')`;
  if (sec.thousands && !sec.interleaved) d = `reverse(rtrim(regexp_replace(reverse(${d}), '(\\d{3})', '\\1,', 'g'), ','))`;
  let frac = `split_part(${r}, '.', 2)`;
  if (n > sec.nZeroFrac) frac = `regexp_replace(${frac}, '0{0,${n - sec.nZeroFrac}}$', '')`;
  const D = sec.interleaved ? 'dax_fd' : d;
  const parts = [];
  let intDone = false, fracDone = false, expDone = false, i = 0;
  const int0 = () => { if (!intDone) parts.push(D); intDone = true; };
  for (const x of sec.tokens) {
    if (x.t === 'lit') parts.push(q(x.v));
    else if (x.t === 'int' && sec.interleaved) {
      // Digits fill the placeholders from the right; the first takes the rest.
      const j = sec.nInt - 1 - i++;
      parts.push(j === sec.nInt - 1 ? `left(${D}, greatest(length(${D}) - ${j}, 0))`
        : `CASE WHEN length(${D}) > ${j} THEN substring(${D}, length(${D}) - ${j}, 1) ELSE '' END`);
      intDone = true;
    } else if (x.t === 'int') int0();
    else if (x.t === 'point') { int0(); parts.push("'.'"); }
    else if (x.t === 'frac') { if (!fracDone) parts.push(frac); fracDone = true; }
    else if (x.t === 'exp') {
      int0();
      parts.push(q(sec.sci.upper ? 'E' : 'e'), `CASE WHEN ${e} < 0 THEN '-' ELSE '${sec.sci.plus ? '+' : ''}' END`);
    } else if (x.t === 'expd' && !expDone) {
      const ae = `CAST(abs(${e}) AS VARCHAR)`;
      parts.push(`lpad(${ae}, CAST(greatest(length(${ae}), ${sec.nExp}) AS INTEGER), '0')`);
      expDone = true;
    }
  }
  const body = cat(parts);
  return sec.interleaved ? bind('dax_fd', d, body) : body;
}

// FORMAT(number, pattern): spec from numberFormat; t the value's type.
export function formatNumber(x, spec, t) {
  if (spec.general) return `COALESCE(${generalNumber(x, t)}, '')`;
  if (t === 'bool') { x = `CAST(${x} AS INTEGER)`; t = 'int'; }
  if (spec.bool) return bind('dax_fv', x, `CASE WHEN dax_fv IS NULL THEN '' WHEN dax_fv <> 0 THEN ${q(spec.bool[0])} ELSE ${q(spec.bool[1])} END`);
  const vt = t === 'int' ? 'int' : 'double';
  const [pos, neg, zero] = spec.sections;
  const v = 'dax_fv', minus = `(-${v})`;
  // Zero takes the third section (the first when there is none); a negative value the second,
  // or the first with a minus sign, and the zero one when it rounds to zero.
  const z = section(zero ?? pos, vt === 'int' ? '0' : 'CAST(0 AS DOUBLE)', vt);
  const negSec = neg ?? pos;
  const negText = `CASE WHEN ${roundsToZero(negSec, minus, vt)} THEN ${z} ELSE ${neg ? '' : "'-' || "}${section(negSec, minus, vt)} END`;
  const body = `CASE WHEN ${v} IS NULL THEN '' WHEN ${v} > 0 THEN ${section(pos, v, vt)} WHEN ${v} = 0 THEN ${z} ELSE ${negText} END`;
  return bind(v, vt === 'int' ? x : `CAST(${x} AS DOUBLE)`, body);
}

// --- dates -------------------------------------------------------------------------------

const STRFTIME = {
  d: '%-d', dd: '%d', ddd: '%a', dddd: '%A', ddddd: '%-m/%-d/%Y', dddddd: '%A, %B %-d, %Y',
  m: '%-m', mm: '%m', mmm: '%b', mmmm: '%B', y: '%-j', yy: '%y', yyyy: '%Y',
  h: '%-H', hh: '%H', h12: '%-I', hh12: '%I', n: '%-M', nn: '%M', min: '%-M', mins: '%M', s: '%-S', ss: '%S',
  ttttt: '%-I:%M:%S %p', 'AM/PM': '%p', AMPM: '%p',
};

// A date as DAX writes it by default: the date, with the time when it is not midnight.
export function generalDate(v) {
  return `CASE WHEN CAST(${v} AS TIMESTAMP) = CAST(CAST(${v} AS DATE) AS TIMESTAMP) THEN strftime(${v}, '%-m/%-d/%Y')
    WHEN CAST(${v} AS DATE) = DATE '1899-12-30' THEN strftime(${v}, '%-I:%M:%S %p')
    ELSE strftime(${v}, '%-m/%-d/%Y %-I:%M:%S %p') END`;
}

// FORMAT(date, pattern): tokens from dateFormat.
export function formatDate(x, tokens) {
  const v = 'dax_fv', pieces = [];
  const sql = s => pieces.push({ s });
  for (const x of tokens) {
    if (x.t === 'lit') pieces.push({ f: x.v.replace(/%/g, '%%') });
    else if (STRFTIME[x.t]) pieces.push({ f: STRFTIME[x.t] });
    else if (x.t === 'w') sql(`CAST(dayofweek(${v}) + 1 AS VARCHAR)`);
    else if (x.t === 'ww') sql(`CAST(CAST(floor((dayofyear(${v}) - 1 + dayofweek(make_date(year(${v}), 1, 1))) / 7) AS BIGINT) + 1 AS VARCHAR)`);
    else if (x.t === 'q') sql(`CAST(quarter(${v}) AS VARCHAR)`);
    else if (x.t === 'am/pm') sql(`lower(strftime(${v}, '%p'))`);
    else if (x.t === 'A/P') sql(`left(strftime(${v}, '%p'), 1)`);
    else if (x.t === 'a/p') sql(`lower(left(strftime(${v}, '%p'), 1))`);
    else if (x.t === 'c') sql(generalDate(v));
    else throw new Error(`FORMAT: date token ${x.t}`);
  }
  // Runs of strftime pieces in one call.
  const parts = [];
  for (const p of pieces) {
    if (p.f !== undefined && parts.length && parts.at(-1).f !== undefined) parts.at(-1).f += p.f;
    else parts.push({ ...p });
  }
  const body = cat(parts.map(p => (p.f !== undefined ? `strftime(${v}, ${q(p.f)})` : p.s)));
  return bind(v, x, `CASE WHEN ${v} IS NULL THEN '' ELSE ${body} END`);
}

// A date's serial number (days since 1899-12-30), for a number pattern; and back.
export const dateSerial = x => `(epoch(CAST(${x} AS TIMESTAMP)) / 86400 + 25569)`;
export const serialDate = x => `(TIMESTAMP '1899-12-30' + to_microseconds(CAST(round(CAST(${x} AS DOUBLE) * 86400000000) AS BIGINT)))`;
