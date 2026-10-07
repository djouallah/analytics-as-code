// Functions of values: logic, math, text, dates, conversion. Each becomes an `fn` node the
// dialect writes (dialects/base.js lists the names), or a CASE.
import * as ir from '../ir.js';
import { semantic, unsupported } from '../errors.js';
import { dateLit } from '../ir.js';

const s = (c, a, env) => c.scalar(a, env);
const opt = (c, a, env, dflt) => (a && a.k !== 'empty' ? c.scalar(a, env) : dflt);

// A function of its arguments' values: blank in, blank out (`strict`) unless said otherwise.
const plain = (name, t, { arity, strict = true, nn = false } = {}) => (c, args, env) => {
  if (arity != null && args.length < arity) throw semantic(`${name.toUpperCase()} needs ${arity} argument(s)`);
  const a = args.map(x => s(c, x, env));
  return ir.fn(name, a, typeof t === 'function' ? t(a) : t, { strict, nn });
};
const first = a => (ir.isNum(a[0].t) ? a[0].t : 'double');
const both = a => (a.every(x => x.t === 'int') ? 'int' : 'double');

function iff(c, args, env) {
  const cond = s(c, args[0], env);
  // A condition known now (ISFILTERED, ISINSCOPE) keeps one side; the other is never compiled.
  if (cond.k === 'lit') return cond.v === true || (typeof cond.v === 'number' && cond.v !== 0) ? s(c, args[1], env) : opt(c, args[2], env, ir.BLANK);
  return ir.kase([[cond, s(c, args[1], env)]], opt(c, args[2], env, ir.BLANK));
}

function switchFn(c, args, env) {
  const e = s(c, args[0], env), w = [];
  const isTrue = e.k === 'lit' && e.v === true;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    const v = s(c, args[i], env);
    const cond = isTrue ? v : ir.op('eq', e, v);
    if (cond.k === 'lit') {
      if (cond.v === true) { w.push([ir.TRUE, s(c, args[i + 1], env)]); break; }
      continue;   // never this branch
    }
    w.push([cond, s(c, args[i + 1], env)]);
  }
  const els = i < args.length && w.at(-1)?.[0] !== ir.TRUE ? s(c, args[i], env) : ir.BLANK;
  return ir.kase(w, els);
}

function logical(o) {
  return (c, args, env) => {
    if (args.length !== 2) throw semantic(`${o.toUpperCase()} takes two arguments (use && or || for more)`);
    return ir.op(o, s(c, args[0], env), s(c, args[1], env));
  };
}

function coalesce(c, args, env) {
  const a = args.map(x => s(c, x, env));
  const k = a.findIndex(x => x.nn);
  const used = k >= 0 ? a.slice(0, k + 1) : a;
  if (used.length === 1) return used[0];
  return ir.fn('coalesce', used, ir.unify(used.map(x => x.t)), { nn: k >= 0 });
}

function divide(c, args, env) {
  const a = s(c, args[0], env), b = s(c, args[1], env), alt = opt(c, args[2], env, null);
  return ir.fn('divide', alt ? [a, b, alt] : [a, b], 'double');
}

function isBlank(c, args, env) { return ir.fn('isblank', [s(c, args[0], env)], 'bool', { nn: true }); }

function round(name) {
  return (c, args, env) => ir.fn(name, [s(c, args[0], env), opt(c, args[1], env, ir.lit(0))],
    name === 'round' && !args[1] ? 'double' : 'double', { strict: true });
}

function convert(c, args, env) {
  const x = s(c, args[0], env);
  const to = args[1]?.k === 'name' ? args[1].name.toUpperCase() : null;
  const map = { INTEGER: 'int', INT64: 'int', DOUBLE: 'double', DECIMAL: 'decimal', CURRENCY: 'decimal', STRING: 'string',
    BOOLEAN: 'bool', DATETIME: 'datetime' };
  if (!map[to]) throw semantic('CONVERT(value, INTEGER | DOUBLE | CURRENCY | STRING | BOOLEAN | DATETIME)');
  return ir.fn('cast', [x, ir.lit(map[to], 'string')], map[to], { strict: true });
}
const castTo = t => (c, args, env) => ir.fn('cast', [s(c, args[0], env), ir.lit(t, 'string')], t, { strict: true });

// DATE(y, m, d) and TIME(h, m, s): out-of-range parts roll over, as in DAX.
function date(c, args, env) {
  const a = args.map(x => s(c, x, env));
  if (a.every(x => x.k === 'lit' && typeof x.v === 'number')) {
    const d = new Date(Date.UTC(a[0].v, a[1].v - 1, a[2].v));
    if (a[0].v >= 1 && a[0].v <= 9999) return dateLit(d.toISOString().slice(0, 10));
  }
  return ir.fn('date', a, 'datetime', { strict: true });
}

const UNITS = { DAY: 'day', MONTH: 'month', YEAR: 'year', QUARTER: 'quarter', WEEK: 'week', HOUR: 'hour', MINUTE: 'minute', SECOND: 'second' };
export function unitArg(ast, what) {
  const u = ast?.k === 'name' ? UNITS[ast.name.toUpperCase()] : null;
  if (!u) throw semantic(`${what}: expected DAY, WEEK, MONTH, QUARTER, YEAR, HOUR, MINUTE or SECOND`);
  return u;
}

function dateDiff(c, args, env) {
  return ir.fn('datediff', [s(c, args[0], env), s(c, args[1], env), ir.lit(unitArg(args[2], 'DATEDIFF'), 'string')], 'int', { strict: true });
}
function eomonth(c, args, env) { return ir.fn('eomonth', [s(c, args[0], env), s(c, args[1], env)], 'datetime', { strict: true }); }
function edate(c, args, env) { return ir.fn('add_interval', [s(c, args[0], env), s(c, args[1], env), ir.lit('month', 'string')], 'datetime', { strict: true }); }
function weekday(c, args, env) { return ir.fn('weekday', [s(c, args[0], env), opt(c, args[1], env, ir.lit(1))], 'int', { strict: true }); }
function weeknum(c, args, env) { return ir.fn('weeknum', [s(c, args[0], env), opt(c, args[1], env, ir.lit(1))], 'int', { strict: true }); }

function search(name) {
  return (c, args, env) => ir.fn(name, [s(c, args[0], env), s(c, args[1], env), opt(c, args[2], env, ir.lit(1)), opt(c, args[3], env, ir.BLANK)], 'int');
}
function substitute(c, args, env) {
  if (args[3]) throw unsupported('SUBSTITUTE with an instance number');
  return ir.fn('substitute', args.slice(0, 3).map(x => s(c, x, env)), 'string', { strict: true });
}
function concatenate(c, args, env) { return ir.op('concat', s(c, args[0], env), s(c, args[1], env)); }
function combineValues(c, args, env) { return ir.fn('combinevalues', args.map(x => s(c, x, env)), 'string', { nn: true }); }

// FORMAT(value, "pattern"): the common date and number patterns.
function format(c, args, env) {
  const x = s(c, args[0], env), p = args[1];
  if (p?.k !== 'str') throw unsupported('FORMAT with a pattern that is not a constant');
  const fmt = p.v;
  if (x.t === 'datetime' || x.t === 'date') return ir.fn('format_date', [x, ir.lit(datePattern(fmt), 'string')], 'string', { strict: true });
  return ir.fn('format_number', [x, ir.lit(JSON.stringify(numberPattern(fmt)), 'string')], 'string', { strict: true });
}
const NAMED_DATES = { 'short date': 'M/d/yyyy', 'long date': 'dddd, mmmm d, yyyy', 'general date': 'M/d/yyyy h:nn:ss AM/PM',
  'short time': 'hh:nn', 'long time': 'h:nn:ss AM/PM', 'medium date': 'dd-mmm-yy' };
function datePattern(fmt) {
  let f = NAMED_DATES[fmt.toLowerCase()] ?? fmt, out = '', i = 0, afterHour = false;
  const tok = [['yyyy', '%Y'], ['yy', '%y'], ['mmmm', '%B'], ['mmm', '%b'], ['dddd', '%A'], ['ddd', '%a'], ['dd', '%d'], ['d', '%-d'],
    ['hh', '%H'], ['h', '%-H'], ['nn', '%M'], ['n', '%-M'], ['ss', '%S'], ['s', '%-S'], ['AM/PM', '%p'], ['am/pm', '%p'], ['q', '%Q']];
  if (/AM\/PM/i.test(f)) tok.splice(8, 2, ['hh', '%I'], ['h', '%-I']);
  while (i < f.length) {
    if (f.startsWith('mm', i) || f[i] === 'm' || f[i] === 'M') {
      const two = f.startsWith('mm', i) || f.startsWith('MM', i);
      if (!f.startsWith('mmm', i)) {
        out += afterHour ? (two ? '%M' : '%-M') : (two ? '%m' : '%-m');
        i += two ? 2 : 1;
        continue;
      }
    }
    const t = tok.find(([k]) => f.startsWith(k, i));
    if (t) {
      if (t[1] === '%Q') throw unsupported('the quarter (q) in a FORMAT pattern');
      out += t[1];
      afterHour = /%-?[HI]/.test(t[1]);
      i += t[0].length;
      continue;
    }
    if (f[i] === '\\' && i + 1 < f.length) { out += f[i + 1]; i += 2; continue; }
    if (/[0#]/.test(f[i])) throw unsupported(`FORMAT pattern "${fmt}" on a date`);
    out += f[i] === '%' ? '%%' : f[i];
    i++;
  }
  return out;
}
function numberPattern(fmt) {
  const named = { 'general number': null, fixed: '0.00', standard: '#,##0.00', percent: '0.00%', currency: '$#,##0.00', scientific: 'sci' };
  let f = fmt.toLowerCase() in named ? named[fmt.toLowerCase()] : fmt;
  if (f === null) return { general: true };
  if (f === 'sci') return { scientific: true, decimals: 2 };
  const m = /^([^0#,.]*)([#,0]+)(?:\.(0+))?(%?)([^0#]*)$/.exec(f);
  if (!m) throw unsupported(`FORMAT pattern "${fmt}"`);
  return { prefix: m[1], thousands: m[2].includes(','), decimals: m[3]?.length ?? 0, percent: m[4] === '%', suffix: m[5] };
}

function blankFn() { return ir.BLANK; }
function error(c, args, env) { return ir.fn('error', [s(c, args[0], env)], 'variant'); }
function ifError(c, args, env) { return s(c, args[0], env); }   // SQL has no error values: the value
function isType(test) { return (c, args, env) => ir.lit(test(s(c, args[0], env).t)); }
function user(c) {
  const u = c.options.user;
  if (u == null) throw unsupported('USERNAME / USERPRINCIPALNAME without options.user');
  return ir.lit(String(u), 'string');
}

export const scalar = {
  IF: iff, 'IF.EAGER': iff, SWITCH: switchFn, AND: logical('and'), OR: logical('or'),
  NOT: (c, args, env) => ir.op('not', s(c, args[0], env)),
  TRUE: () => ir.TRUE, FALSE: () => ir.FALSE, BLANK: blankFn,
  COALESCE: coalesce, DIVIDE: divide, ISBLANK: isBlank, ERROR: error, IFERROR: ifError, ISERROR: () => ir.FALSE,
  ISNUMBER: isType(t => ir.isNum(t)), ISTEXT: isType(t => t === 'string'), ISNONTEXT: isType(t => t !== 'string'),
  ISLOGICAL: isType(t => t === 'bool'), ISEVEN: plain('iseven', 'bool'), ISODD: plain('isodd', 'bool'),
  USERNAME: user, USERPRINCIPALNAME: user,
  // math
  ABS: plain('abs', first), SIGN: plain('sign', 'int'), SQRT: plain('sqrt', 'double'), EXP: plain('exp', 'double'),
  LN: plain('ln', 'double'), LOG: (c, args, env) => ir.fn('log', [s(c, args[0], env), opt(c, args[1], env, ir.lit(10))], 'double', { strict: true }),
  LOG10: plain('log10', 'double'), POWER: plain('power', 'double', { arity: 2 }), MOD: plain('mod', both, { arity: 2 }),
  QUOTIENT: plain('quotient', 'int', { arity: 2 }), ROUND: round('round'), ROUNDUP: round('roundup'), ROUNDDOWN: round('rounddown'),
  INT: plain('int', 'int'), TRUNC: round('trunc'), CEILING: plain('ceiling', 'double'), FLOOR: plain('floor', 'double'),
  'ISO.CEILING': plain('ceiling', 'double'), MROUND: plain('mround', 'double'), PI: () => ir.lit(Math.PI, 'double'),
  RAND: () => ir.fn('rand', [], 'double', { nn: true }), RANDBETWEEN: plain('randbetween', 'int'),
  GCD: plain('gcd', 'int'), LCM: plain('lcm', 'int'), FACT: plain('fact', 'int'), EVEN: plain('even', 'int'), ODD: plain('odd', 'int'),
  CONVERT: convert, CURRENCY: castTo('decimal'), VALUE: plain('value', 'double'), FIXED: unsupportedFn('FIXED'),
  // text
  CONCATENATE: concatenate, COMBINEVALUES: combineValues, LEFT: plain('left', 'string'), RIGHT: plain('right', 'string'),
  MID: plain('mid', 'string', { arity: 3 }), LEN: plain('len', 'int'), UPPER: plain('upper', 'string'), LOWER: plain('lower', 'string'),
  TRIM: plain('trim', 'string'), SUBSTITUTE: substitute, REPLACE: plain('replace', 'string', { arity: 4 }),
  SEARCH: search('search'), FIND: search('find'), REPT: plain('rept', 'string'),
  EXACT: plain('exact', 'bool', { strict: false, nn: true }), UNICHAR: plain('unichar', 'string'), UNICODE: plain('unicode', 'int'),
  CONTAINSSTRING: plain('containsstring', 'bool', { strict: false, nn: true }),
  CONTAINSSTRINGEXACT: plain('containsstringexact', 'bool', { strict: false, nn: true }), FORMAT: format,
  // dates
  DATE: date, TIME: plain('time', 'datetime'), YEAR: plain('year', 'int'), MONTH: plain('month', 'int'), DAY: plain('day', 'int'),
  HOUR: plain('hour', 'int'), MINUTE: plain('minute', 'int'), SECOND: plain('second', 'int'), QUARTER: plain('quarter', 'int'),
  WEEKDAY: weekday, WEEKNUM: weeknum, EOMONTH: eomonth, EDATE: edate, DATEDIFF: dateDiff,
  TODAY: () => ir.fn('today', [], 'datetime', { nn: true }), NOW: () => ir.fn('now', [], 'datetime', { nn: true }),
  UTCTODAY: () => ir.fn('utctoday', [], 'datetime', { nn: true }), UTCNOW: () => ir.fn('utcnow', [], 'datetime', { nn: true }),
  DATEVALUE: castTo('datetime'), TIMEVALUE: unsupportedFn('TIMEVALUE'),
};

function unsupportedFn(name) { return () => { throw unsupported(name); }; }
