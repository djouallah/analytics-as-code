// FORMAT patterns, read into what a dialect writes as SQL (en-US).
//
// Numbers (Microsoft's "Custom numeric formats"): up to three sections, positive;negative;zero
// (an empty one is the first's). In a section: 0 a digit or 0, # a digit or nothing, . the
// decimal point, , a thousands separator between digit placeholders, or scaling by 1000 next
// to the point or at the end of the digits, % times 100, E+ E- e+ e- an exponent, "text" and
// \c literal, anything else literal. And the named formats: General Number, Currency, Fixed,
// Standard, Percent, Scientific, Yes/No, True/False, On/Off.
//
// Dates ("Custom date and time formats"): d dd ddd dddd ddddd dddddd w ww m mm mmm mmmm q y yy
// yyyy h hh n nn s ss ttttt AM/PM am/pm A/P a/p AMPM c / :, m and mm being minutes right
// after h or hh; and General Date, Long Date, Medium Date, Short Date, Long Time, Medium Time,
// Short Time.
import { unsupported } from './errors.js';

const NUMBER_NAMES = {
  'general number': { general: true },
  currency: '$#,##0.00;($#,##0.00)',
  fixed: '0.00',
  standard: '#,##0.00',
  percent: '#,##0.00 %',
  scientific: '0.00E+00',
  'yes/no': { bool: ['Yes', 'No'] },
  'true/false': { bool: ['True', 'False'] },
  'on/off': { bool: ['On', 'Off'] },
};

const DATE_NAMES = {
  'general date': 'c',
  'long date': 'dddd, mmmm d, yyyy',
  'medium date': 'dddd, mmmm d, yyyy',
  'short date': 'm/d/yyyy',
  'long time': 'h:nn:ss AM/PM',
  'medium time': 'h:nn:ss AM/PM',
  'short time': 'hh:nn',
};

// Splits on ; outside quotes and escapes.
function sections(fmt) {
  const out = [''];
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '\\') { out[out.length - 1] += c + (fmt[i + 1] ?? ''); i++; continue; }
    if (c === '"') {
      const e = fmt.indexOf('"', i + 1);
      const end = e < 0 ? fmt.length : e;
      out[out.length - 1] += fmt.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ';') { out.push(''); continue; }
    out[out.length - 1] += c;
  }
  return out;
}

export function numberFormat(fmt) {
  const named = NUMBER_NAMES[fmt.trim().toLowerCase()];
  if (named && typeof named === 'object') return named;
  const text = named ?? fmt;
  if (!text.trim()) return { general: true };
  const parts = sections(text);
  if (parts.length > 3) throw unsupported(`FORMAT "${fmt}": more than three sections`);
  return { sections: parts.map((p, i) => (i > 0 && p === '' ? null : section(p))) };
}

function section(src) {
  const tokens = [];
  let part = 'int', thousands = false, scale = 0, pct = 0, sci = null;
  const placeholder = c => c === '0' || c === '#';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      const e = src.indexOf('"', i + 1), end = e < 0 ? src.length : e;
      tokens.push({ t: 'lit', v: src.slice(i + 1, end) });
      i = end;
      continue;
    }
    if (c === '\\') { tokens.push({ t: 'lit', v: src[i + 1] ?? '' }); i++; continue; }
    if (placeholder(c)) { tokens.push({ t: part === 'exp' ? 'expd' : part, c }); continue; }
    if (c === '.' && part === 'int') { tokens.push({ t: 'point' }); part = 'frac'; continue; }
    if (c === ',' && part !== 'exp') {
      let n = 0;
      while (src[i + n] === ',') n++;
      const next = src[i + n];
      const afterDigit = tokens.length && tokens.at(-1).t === part;
      if (part === 'int' && afterDigit && placeholder(next)) thousands = true;
      // Right before the point, or after the last digit: each one divides by 1000.
      else if (afterDigit && (part === 'int' ? !placeholder(next) : !src.slice(i + n).split('').some(placeholder))) scale += n;
      else tokens.push({ t: 'lit', v: ','.repeat(n) });
      i += n - 1;
      continue;
    }
    if (c === '%') { pct++; tokens.push({ t: 'lit', v: '%' }); continue; }
    if ((c === 'E' || c === 'e') && (src[i + 1] === '+' || src[i + 1] === '-') && placeholder(src[i + 2] ?? '') && part !== 'exp') {
      sci = { upper: c === 'E', plus: src[i + 1] === '+' };
      tokens.push({ t: 'exp' });
      part = 'exp';
      i++;
      continue;
    }
    tokens.push({ t: 'lit', v: c });
  }
  const count = t => tokens.filter(x => x.t === t).length;
  // Literals between the integer digits (a phone number's dashes) are kept in place.
  const ints = tokens.map((x, i) => (x.t === 'int' ? i : -1)).filter(i => i >= 0);
  const inner = ints.length > 1 && tokens.slice(ints[0], ints.at(-1)).some(x => x.t === 'lit');
  const intChars = ints.map(i => tokens[i].c), firstZero = intChars.indexOf('0');
  const nFrac = count('frac');
  if (nFrac > 22) throw unsupported('FORMAT with more than 22 decimal places');
  return {
    tokens, thousands, scale, pct, sci, point: tokens.some(x => x.t === 'point'),
    // The integer digits always shown: from the first 0 placeholder on ("#,##0" one, "000" three).
    nInt: ints.length, nZeroInt: firstZero < 0 ? 0 : ints.length - firstZero,
    nFrac, nZeroFrac: zeroFrac(tokens), nExp: count('expd'), interleaved: inner,
  };
}

export const isNamedDate = fmt => fmt.trim().toLowerCase() in DATE_NAMES;

// Whether a pattern is a date one or a number one (null: neither, only text).
export function formatKind(fmt) {
  const low = fmt.trim().toLowerCase();
  if (low in NUMBER_NAMES) return 'number';
  if (low in DATE_NAMES) return 'date';
  let plain = '';
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === '\\') { i++; continue; }
    if (fmt[i] === '"') { const e = fmt.indexOf('"', i + 1); i = e < 0 ? fmt.length : e; continue; }
    plain += fmt[i];
  }
  if (/[0#]/.test(plain)) return 'number';
  if (/[dmyhnsqwc]|am\/pm|a\/p|ampm|ttttt/i.test(plain)) return 'date';
  return null;
}

// The fraction digits always shown: up to the last 0 placeholder.
function zeroFrac(tokens) {
  const f = tokens.filter(x => x.t === 'frac');
  return f.map(x => x.c).lastIndexOf('0') + 1;
}

const DATE_TOKENS = ['dddddd', 'ddddd', 'dddd', 'ddd', 'dd', 'd', 'ww', 'w', 'mmmm', 'mmm', 'mm', 'm', 'q', 'yyyy', 'yy', 'y',
  'hh', 'h', 'nn', 'n', 'ss', 's', 'ttttt', 'c'];
const AMPM = ['AM/PM', 'am/pm', 'A/P', 'a/p', 'AMPM', 'ampm'];

// -> [{ t: 'lit', v } | { t: <token> }], with m/mm after h/hh read as minutes (min, mins) and
// the hours on a 12-hour clock when an AM/PM marker is there (h12, hh12).
export function dateFormat(fmt) {
  const text = DATE_NAMES[fmt.trim().toLowerCase()] ?? (fmt.trim() ? fmt : 'c');
  const out = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      const e = text.indexOf('"', i + 1), end = e < 0 ? text.length : e;
      out.push({ t: 'lit', v: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '\\') { out.push({ t: 'lit', v: text[i + 1] ?? '' }); i += 2; continue; }
    const ap = AMPM.find(a => text.startsWith(a, i));
    if (ap) { out.push({ t: ap === 'ampm' ? 'AMPM' : ap }); i += ap.length; continue; }
    const low = text.slice(i).toLowerCase();
    const tok = DATE_TOKENS.find(k => low.startsWith(k));
    if (tok) { out.push({ t: tok }); i += tok.length; continue; }
    out.push({ t: 'lit', v: c });
    i++;
  }
  let prev = null;
  for (const x of out) {
    if ((x.t === 'm' || x.t === 'mm') && (prev?.t === 'h' || prev?.t === 'hh')) x.t = x.t === 'm' ? 'min' : 'mins';
    if (x.t !== 'lit') prev = x;
  }
  if (out.some(x => AMPM.includes(x.t))) for (const x of out) if (x.t === 'h' || x.t === 'hh') x.t += '12';
  return out;
}
