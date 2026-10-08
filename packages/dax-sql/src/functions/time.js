// Time intelligence. Each function is a table of dates of a date column (with its lineage,
// so as a CALCULATE filter it filters that column, and with it the date table), worked out
// from the dates the filter context leaves visible.
import * as ir from '../ir.js';
import { Ctx } from '../context.js';
import { semantic, unsupported } from '../errors.js';
import { unitArg } from './scalar.js';

// The dates argument: a date column or a table of dates. A column is
// CALCULATETABLE(DISTINCT(column)), as DAX reads it: in a row context, the context
// transition applies (PREVIOUSMONTH in a calculated column of the date table).
function datesOf(c, ast, env, what) {
  if (ast?.k === 'col') {
    const col = c.modelColumn(ast, env, `${what} needs a date column`);
    return { col, visible: ir.values(col.table, c.transition(env), [col], (t, x) => c.scan(t, x)) };
  }
  const t = c.table(ast, env);
  if (t.cols.length !== 1 || !t.cols[0].lineage) throw semantic(`${what} needs a date column`);
  return { col: t.cols[0].lineage, visible: t };
}
const first = v => { const r = ir.rowOf(v, 'table'); return ir.agg('min', v, r, ir.col(r, 0), 'datetime'); };
const last = v => { const r = ir.rowOf(v, 'table'); return ir.agg('max', v, r, ir.col(r, 0), 'datetime'); };
const shift = (d, n, unit) => ir.fn('add_interval', [d, typeof n === 'number' ? ir.lit(n) : n, ir.lit(unit, 'string')], 'datetime', { strict: true });
const startOf = (d, unit) => ir.fn('start_of', [d, ir.lit(unit, 'string')], 'datetime', { strict: true });
const endOf = (d, unit) => ir.fn('end_of', [d, ir.lit(unit, 'string')], 'datetime', { strict: true });
const and = (...a) => a.reduce((x, y) => ir.op('and', x, y));

// The column's dates, whatever is filtered, for which `pred(date)` holds.
function dates(c, col, env, pred) {
  const all = ir.values(col.table, new Ctx([], env.ctx.mods), [col], (t, x) => c.scan(t, x));
  const row = ir.rowOf(all, 'table');
  return ir.filter(all, row, pred(ir.col(row, 0)));
}
const between = (v, lo, hi) => and(ir.op('ge', v, lo), ir.op('le', v, hi));

// A fiscal year that ends on `yearEnd` ("6/30"): the months it is shifted by.
function fiscalShift(ast) {
  if (!ast || ast.k === 'empty') return 0;
  if (ast.k !== 'str') throw unsupported('a year-end date that is not a constant');
  const m = /^(\d{1,2})[/-](\d{1,2})$/.exec(ast.v.trim());
  if (!m) throw unsupported(`year-end "${ast.v}" (use "M/D", the last day of a month)`);
  return (12 - Number(m[1])) % 12;
}
function startOfYear(d, months) {
  return months ? shift(startOf(shift(d, -months, 'month'), 'year'), months, 'month') : startOf(d, 'year');
}

function toDate(unit) {
  return (c, args, env, ast) => {
    const { col, visible } = datesOf(c, args[0], env, ast.fn);
    const end = last(visible);
    const start = unit === 'year' ? startOfYear(end, fiscalShift(args[1])) : startOf(end, unit);
    return dates(c, col, env, v => between(v, start, end));
  };
}

function datesBetween(c, args, env) {
  const { col } = datesOf(c, args[0], env, 'DATESBETWEEN');
  const lo = c.scalar(args[1], env), hi = c.scalar(args[2], env);
  const blank = x => ir.fn('isblank', [x], 'bool', { nn: true });
  return dates(c, col, env, v => and(ir.op('or', blank(lo), ir.op('ge', v, lo)), ir.op('or', blank(hi), ir.op('le', v, hi))));
}

function datesInPeriod(c, args, env) {
  const { col } = datesOf(c, args[0], env, 'DATESINPERIOD');
  const start = c.scalar(args[1], env), n = c.scalar(args[2], env), unit = unitArg(args[3], 'DATESINPERIOD');
  const end = shift(start, n, unit);
  const back = v => and(ir.op('gt', v, end), ir.op('le', v, start)), fwd = v => and(ir.op('ge', v, start), ir.op('lt', v, end));
  if (n.k === 'lit') return dates(c, col, env, n.v < 0 ? back : fwd);
  return dates(c, col, env, v => ir.kase([[ir.op('lt', n, ir.lit(0)), back(v)]], fwd(v), 'bool'));
}

// DATEADD: each visible date moved; from the last day of a month, to the end of the moved one.
function dateAdd(c, args, env, ast) {
  const { col, visible } = datesOf(c, args[0], env, ast.fn);
  const n = ast.fn === 'SAMEPERIODLASTYEAR' ? ir.lit(-1) : c.scalar(args[1], env);
  const unit = ast.fn === 'SAMEPERIODLASTYEAR' ? 'year' : unitArg(args[2], 'DATEADD');
  const vrow = ir.rowOf(visible, 'table'), v = ir.col(vrow, 0);
  const moved = ir.project(visible, vrow, [{ name: col.name, expr: shift(v, n, unit), lineage: col, t: 'datetime' }]);
  return dates(c, col, env, a => {
    let p = { k: 'insub', e: [a], src: moved, t: 'bool', nn: true };
    if (unit === 'month' || unit === 'quarter' || unit === 'year') {
      const erow = ir.rowOf(visible, 'table'), e = ir.col(erow, 0), to = shift(e, n, unit);
      const tail = ir.exists(ir.filter(visible, erow, and(ir.op('eq', e, endOf(e, 'month')), ir.op('gt', a, to), ir.op('le', a, endOf(to, 'month')))));
      p = ir.op('or', p, tail);
    }
    return p;
  });
}

function parallelPeriod(c, args, env) {
  const { col, visible } = datesOf(c, args[0], env, 'PARALLELPERIOD');
  const n = c.scalar(args[1], env), unit = unitArg(args[2], 'PARALLELPERIOD');
  return dates(c, col, env, v => between(v, startOf(shift(first(visible), n, unit), unit), endOf(shift(last(visible), n, unit), unit)));
}

// PREVIOUSMONTH and its kind: the whole period before the one of the first visible date;
// NEXTMONTH and its kind, after the one of the last (as Microsoft's reference says).
function period(unit, n, from) {
  return (c, args, env, ast) => {
    const { col, visible } = datesOf(c, args[0], env, ast.fn);
    const at = shift(from === 'first' ? first(visible) : last(visible), n, unit);
    if (unit === 'day') return dates(c, col, env, v => ir.op('eq', v, at));
    return dates(c, col, env, v => between(v, startOf(at, unit), endOf(at, unit)));
  };
}

// STARTOFMONTH and ENDOFMONTH and their kind: the first (last) date the column holds in the
// period of the first (last) visible date. FIRSTDATE, LASTDATE: the first (last) visible.
function edge(unit, side) {
  return (c, args, env, ast) => {
    const { col, visible } = datesOf(c, args[0], env, ast.fn);
    if (!unit) {
      const v = side === 'start' ? first(visible) : last(visible);
      return dates(c, col, env, x => ir.op('eq', x, v));
    }
    const at = side === 'start' ? first(visible) : last(visible);
    const inPeriod = dates(c, col, env, x => between(x, startOf(at, unit), endOf(at, unit)));
    const v = side === 'start' ? first(inPeriod) : last(inPeriod);
    return dates(c, col, env, x => ir.op('eq', x, v));
  };
}

// TOTALYTD(expr, dates, [filter], [year end]) is CALCULATE(expr, DATESYTD(dates), filter).
function total(fn) {
  return (c, args, env) => {
    let filterArg = args[2], yearEnd = args[3];
    if (filterArg?.k === 'str') { yearEnd = filterArg; filterArg = null; }
    const dateArgs = [args[1], ...(fn === 'DATESYTD' && yearEnd ? [yearEnd] : [])];
    const call = { k: 'call', fn: 'CALCULATE', args: [args[0], { k: 'call', fn, args: dateArgs }, ...(filterArg && filterArg.k !== 'empty' ? [filterArg] : [])] };
    return c.scalar(call, env);
  };
}

// CLOSINGBALANCEMONTH(expr, dates): expr on the last date of the period; OPENING: on the day
// before its first.
function balance(unit, side) {
  return (c, args, env, ast) => {
    let filterArg = args[2];
    if (filterArg?.k === 'str') filterArg = null;
    const { col, visible } = datesOf(c, args[1], env, ast.fn);
    const at = side === 'closing' ? endOf(last(visible), unit) : shift(startOf(first(visible), unit), -1, 'day');
    const t = dates(c, col, env, x => ir.op('eq', x, at));
    const f = c.tableFilter(t, env.ctx);
    // As CALCULATE(expr, t, filter): t is evaluated here, the rest as CALCULATE does.
    const ctx = c.calculateCtx(filterArg && filterArg.k !== 'empty' ? [filterArg] : [], env);
    let dropped = ctx.remove(x => x.table === col.table);
    for (const x of [f].flat().filter(Boolean)) dropped = dropped.add(x);
    return c.scalar(args[0], { ...env, ctx: dropped, rows: [] });
  };
}

// CALENDARAUTO([fiscal year end month]): every day of the (fiscal) years the model's dates
// span (its date columns, not calculated ones).
function calendarAuto(c, args, env) {
  const end = args[0] && args[0].k !== 'empty' ? Number(args[0].v) : 12;
  if (!(end >= 1 && end <= 12)) throw semantic('CALENDARAUTO takes a month, 1 to 12');
  const months = (12 - end) % 12;
  const cols = [...c.model.tables.values()].filter(t => !t.calc && !t.calcGroup)
    .flatMap(t => t.columns.filter(x => x.type === 'datetime' && !x.expr));
  if (!cols.length) throw semantic('CALENDARAUTO: the model has no date column');
  const each = f => cols.map(x => { const s = c.scan(x.table, new Ctx([], env.ctx.mods)), r = ir.rowOf(s); return ir.agg(f, s, r, ir.col(r, x), 'datetime'); });
  const lo = startOfYear(ir.fn('least', each('min'), 'datetime'), months);
  const hi = shift(shift(startOfYear(ir.fn('greatest', each('max'), 'datetime'), months), 12, 'month'), -1, 'day');
  return { k: 'series', start: lo, end: hi, step: ir.lit(1), cols: [{ name: 'Date', lineage: null, t: 'datetime' }], base: null };
}

export const table = {
  CALENDARAUTO: calendarAuto,
  DATESYTD: toDate('year'), DATESQTD: toDate('quarter'), DATESMTD: toDate('month'),
  DATESBETWEEN: datesBetween, DATESINPERIOD: datesInPeriod, DATEADD: dateAdd, SAMEPERIODLASTYEAR: dateAdd,
  PARALLELPERIOD: parallelPeriod,
  PREVIOUSDAY: period('day', -1, 'first'), PREVIOUSMONTH: period('month', -1, 'first'),
  PREVIOUSQUARTER: period('quarter', -1, 'first'), PREVIOUSYEAR: period('year', -1, 'first'),
  NEXTDAY: period('day', 1, 'last'), NEXTMONTH: period('month', 1, 'last'),
  NEXTQUARTER: period('quarter', 1, 'last'), NEXTYEAR: period('year', 1, 'last'),
  STARTOFMONTH: edge('month', 'start'), STARTOFQUARTER: edge('quarter', 'start'), STARTOFYEAR: edge('year', 'start'),
  ENDOFMONTH: edge('month', 'end'), ENDOFQUARTER: edge('quarter', 'end'), ENDOFYEAR: edge('year', 'end'),
  FIRSTDATE: edge(null, 'start'), LASTDATE: edge(null, 'end'),
};

export const scalar = {
  TOTALYTD: total('DATESYTD'), TOTALQTD: total('DATESQTD'), TOTALMTD: total('DATESMTD'),
  CLOSINGBALANCEMONTH: balance('month', 'closing'), CLOSINGBALANCEQUARTER: balance('quarter', 'closing'),
  CLOSINGBALANCEYEAR: balance('year', 'closing'), OPENINGBALANCEMONTH: balance('month', 'opening'),
  OPENINGBALANCEQUARTER: balance('quarter', 'opening'), OPENINGBALANCEYEAR: balance('year', 'opening'),
};
