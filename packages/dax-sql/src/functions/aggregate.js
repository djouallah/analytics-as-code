// Aggregates and iterators, CALCULATE, and the functions that ask about the filter context.
// An aggregate is { k:'agg' } over a table (a scan of the column's table, for SUM(T[c])).
import * as ir from '../ir.js';
import { semantic } from '../errors.js';

const lc = s => String(s).toLowerCase();
const numType = t => (t === 'int' || t === 'decimal' ? t : 'double');

// SUM(T[c]) and its kind: the column's table, as the filter context leaves it.
function overColumn(c, ast, env, what) {
  const col = c.modelColumn(ast, env, what);
  const src = c.scan(col.table, env.ctx), row = ir.rowOf(src);
  return { src, row, arg: ir.col(row, col), col };
}
// SUMX(table, expr) and its kind: expr in a row context of the table.
function overTable(c, args, env) {
  // SUMX(CURRENTGROUP(), expr) inside GROUPBY: the rows of the group.
  if (args[0]?.k === 'call' && args[0].fn === 'CURRENTGROUP') {
    if (!env.currentGroup) throw semantic('CURRENTGROUP() is only valid inside GROUPBY');
    const { row } = env.currentGroup, inner = { ...env, rows: [...env.rows, row], currentGroup: null };
    return { src: { k: 'currentgroup', cols: row.cols }, row, arg: c.scalar(args[1], inner), inner };
  }
  const src = c.table(args[0], env), row = ir.rowOf(src);
  return { src, row, arg: c.scalar(args[1], { ...env, rows: [...env.rows, row] }), inner: { ...env, rows: [...env.rows, row] } };
}

const column = (fn, type) => (c, args, env) => {
  const { src, row, arg } = overColumn(c, args[0], env);
  return ir.agg(fn, src, row, arg, type(arg.t));
};
const iterator = (fn, type) => (c, args, env) => {
  const { src, row, arg } = overTable(c, args, env);
  return ir.agg(fn, src, row, arg, type(arg.t));
};
const same = t => t, num = t => numType(t), dbl = () => 'double', int = () => 'int';

function countRows(c, args, env) {
  const a = args[0];
  if (!a) throw semantic('COUNTROWS needs a table');
  // COUNTROWS(VALUES(T[c])) and COUNTROWS(SUMMARIZE(T, cols)) count distinct values: the
  // same aggregate as DISTINCTCOUNT, over the table.
  if (a.k === 'call' && (a.fn === 'VALUES' || a.fn === 'DISTINCT') && a.args.length === 1 && a.args[0].k === 'col' && a.args[0].table
    && c.model.findColumn(a.args[0].table, a.args[0].name)) {
    const { src, row, arg } = overColumn(c, a.args[0], env);
    return ir.agg('dcount', src, row, arg, 'int');
  }
  if (a.k === 'call' && a.fn === 'SUMMARIZE' && a.args.length > 1 && a.args.slice(1).every(x => x.k === 'col' && x.table)
    && a.args[0].k === 'name' && !env.vars.has(lc(a.args[0].name)) && c.model.hasTable(a.args[0].name)) {
    const src = c.scan(c.model.table(a.args[0].name), env.ctx), row = ir.rowOf(src);
    const cols = a.args.slice(1).map(x => ir.col(row, c.modelColumn(x, env)));
    return ir.agg('dcount', src, row, cols.length === 1 ? cols[0] : ir.fn('row', cols, 'variant', { nn: true }), 'int');
  }
  const src = c.table(a, env);
  return ir.agg('countrows', src, ir.rowOf(src), null, 'int');
}

function minMax(fn) {
  return (c, args, env) => {
    if (args.length === 2) {
      const a = c.scalar(args[0], env), b = c.scalar(args[1], env);
      return ir.fn(fn === 'max' ? 'greatest' : 'least', [a, b], ir.unify([a.t, b.t]));
    }
    return column(fn, same)(c, args, env);
  };
}

function concatenateX(c, args, env) {
  const { src, row, arg, inner } = overTable(c, args, env);
  const delim = args[2] && args[2].k !== 'empty' ? c.scalar(args[2], env) : ir.lit('', 'string');
  const order = [];
  for (let i = 3; i < args.length; i += 2) {
    const d = args[i + 1];
    order.push({ expr: c.scalar(args[i], inner), desc: !!d && isDesc(d, false) });
  }
  const node = ir.agg('concat', src, row, arg, 'string', [delim]);
  node.order = order;
  return node;
}

// ASC/DESC (or 1/0, TRUE/FALSE) as an argument.
export function isDesc(ast, dflt) {
  if (!ast || ast.k === 'empty') return dflt;
  if (ast.k === 'name') {
    const n = ast.name.toUpperCase();
    if (n === 'DESC') return true;
    if (n === 'ASC') return false;
  }
  if (ast.k === 'num') return Number(ast.v) === 0;
  if (ast.k === 'bool') return !ast.v;
  throw semantic('expected ASC or DESC');
}

function percentile(fn, x) {
  return (c, args, env) => {
    const o = x ? overTable(c, args, env) : overColumn(c, args[0], env);
    const k = c.scalar(args[x ? 2 : 1], env);
    return ir.agg(fn, o.src, o.row, o.arg, 'double', [k]);
  };
}

// --- the filter context ----------------------------------------------------------------

function calculate(c, args, env) {
  if (!args.length) throw semantic('CALCULATE needs an expression');
  const ctx = c.calculateCtx(args.slice(1), env);
  // Inside CALCULATE the row contexts are filters now: no row context is left.
  return c.scalar(args[0], { ...env, ctx, rows: [] });
}

// A column or a table argument -> the model columns it names.
function columnsOf(c, ast, env) {
  if (ast.k === 'col') return [c.modelColumn(ast, env)];
  if (ast.k === 'name' && c.model.hasTable(ast.name) && !env.vars.has(lc(ast.name))) return c.model.table(ast.name).columns;
  throw semantic('expected a column or a table');
}

function isFiltered(c, args, env) {
  const cols = columnsOf(c, args[0], env);
  return ir.lit(cols.some(x => env.ctx.filtered(x)));
}
function isCrossFiltered(c, args, env) {
  const cols = columnsOf(c, args[0], env), table = cols[0].table;
  const state = c.model.state(env.ctx.mods);
  const hit = env.ctx.filters.some(f => f.cols.some(x => c.model.reaches(x.table, table, state)));
  return ir.lit(hit);
}
function isInScope(c, args, env) {
  return ir.lit(env.grouped.has(c.modelColumn(args[0], env)));
}

// The visible values of a column: one of them, or whether there is exactly one.
function valuesOf(c, ast, env) {
  const col = c.modelColumn(ast, env);
  const src = c.scan(col.table, env.ctx), row = ir.rowOf(src);
  return { src, row, col, value: ir.col(row, col) };
}
function hasOneValue(c, args, env) {
  const { src, row, value } = valuesOf(c, args[0], env);
  return ir.agg('hasone', src, row, value, 'bool');
}
function selectedValue(c, args, env) {
  const { src, row, value } = valuesOf(c, args[0], env);
  const alt = args[1] && args[1].k !== 'empty' ? c.scalar(args[1], env) : ir.BLANK;
  return ir.kase([[ir.agg('hasone', src, row, value, 'bool'), ir.agg('min', src, row, value, value.t)]], alt);
}
function hasOneFilter(c, args, env) {
  const col = c.modelColumn(args[0], env);
  if (!env.ctx.filtered(col)) return ir.FALSE;
  const t = filtersTable(c, col, env);
  const row = ir.rowOf(t);
  return ir.op('eq', ir.agg('countrows', t, row, null, 'int'), ir.lit(1));
}
// FILTERS(T[c]): the values the filters directly on the column allow.
export function filtersTable(c, col, env) {
  const direct = env.ctx.filters.filter(f => f.cols.includes(col));
  const ctx = new env.ctx.constructor(direct, env.ctx.mods);
  const src = c.scan(col.table, ctx), row = ir.rowOf(src);
  return ir.distinct(ir.project(src, row, [ir.itemOf(row, col)]));
}

function lookupValue(c, args, env) {
  const result = c.modelColumn(args[0], env);
  let ctx = env.ctx, i = 1;
  const binds = [];
  for (; i + 1 < args.length; i += 2) {
    const s = c.modelColumn(args[i], env), v = c.scalar(args[i + 1], env);
    binds.push({ kind: 'bind', cols: [s], val: v });
  }
  ctx = ctx.remove(x => binds.some(b => b.cols[0] === x));
  for (const b of binds) ctx = ctx.add(b);
  const alt = i < args.length && args[i].k !== 'empty' ? c.scalar(args[i], env) : ir.BLANK;
  const src = c.scan(result.table, ctx), row = ir.rowOf(src), value = ir.col(row, result);
  return ir.kase([[ir.agg('hasone', src, row, value, 'bool'), ir.agg('min', src, row, value, value.t)]], alt);
}

function related(c, args, env) {
  const col = c.modelColumn(args[0], env, 'RELATED needs a column');
  const state = c.model.state(env.ctx.mods);
  for (let i = env.rows.length - 1; i >= 0; i--) {
    const row = env.rows[i];
    if (row.base && c.model.expand(row.base, state, null, true).has(col.table.name)) return ir.col(row, col);
    // A row of another table that holds the key of a model table: from there.
    for (const rc of row.cols) {
      if (!rc.lineage) continue;
      const path = c.model.expand(rc.lineage.table, state, null, true).get(col.table.name);
      if (path?.length && row.cols.some(x => x.lineage === path[0].from)) return ir.col(row, col);
    }
  }
  throw semantic(`RELATED('${col.table.name}'[${col.name}]): no row context reaches '${col.table.name}' through a relationship`);
}

function earlier(c, args, env, ast) {
  const outermost = ast.fn === 'EARLIEST';
  const n = args[1] ? Number(args[1].v) : 1;
  const a = args[0];
  const matches = [];
  for (let i = env.rows.length - 1; i >= 0; i--) {
    const x = c.rowColumn({ ...env, rows: [env.rows[i]] }, a.table, a.name);
    if (x) matches.push(x);
  }
  const pick = outermost ? matches.at(-1) : matches[n];
  if (!pick) throw semantic(`${ast.fn}: there is no outer row context with '${a.table ?? ''}'[${a.name}]`);
  return pick;
}

function rankX(c, args, env) {
  const { src, row, arg, inner } = overTable(c, args, env);
  void inner;
  const value = args[2] && args[2].k !== 'empty' ? c.scalar(args[2], env) : c.scalar(args[1], env);
  const desc = isDesc(args[3], true);
  const dense = args[4] && args[4].k === 'name' && args[4].name.toUpperCase() === 'DENSE';
  const ahead = ir.op(desc ? 'gt' : 'lt', arg, value);
  const n = dense ? ir.agg('dcount0', src, row, ir.kase([[ahead, arg]], ir.BLANK, arg.t), 'int')
    : ir.agg('count0', src, row, ir.kase([[ahead, ir.lit(1)]], ir.BLANK, 'int'), 'int');
  return ir.op('add', n, ir.lit(1));
}

function contains(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src), inner = { ...env, rows: [...env.rows, row] };
  let pred = ir.TRUE;
  for (let i = 1; i + 1 < args.length; i += 2) pred = ir.op('and', pred, ir.op('eq', c.scalar(args[i], inner), c.scalar(args[i + 1], env)));
  return ir.exists(ir.filter(src, row, pred));
}
function containsRow(c, args, env) {
  const src = c.table(args[0], env);
  const vals = args.slice(1).map(a => c.scalar(a, env));
  if (vals.length !== src.cols.length) throw semantic('CONTAINSROW needs one value per column of the table');
  return { k: 'insub', e: vals, src, t: 'bool', nn: true };
}
function isEmpty(c, args, env) { return ir.op('not', ir.exists(c.table(args[0], env))); }

export const scalar = {
  SUM: column('sum', num), AVERAGE: column('avg', dbl), MIN: minMax('min'), MAX: minMax('max'),
  COUNT: column('count', int), COUNTA: column('count', int), COUNTBLANK: column('countblank', int),
  DISTINCTCOUNT: column('dcount', int), DISTINCTCOUNTNOBLANK: column('dcountnb', int),
  PRODUCT: column('product', num), MEDIAN: column('median', dbl),
  'STDEV.S': column('stdev_s', dbl), 'STDEV.P': column('stdev_p', dbl), 'VAR.S': column('var_s', dbl), 'VAR.P': column('var_p', dbl),
  MINA: minMax('min'), MAXA: minMax('max'), AVERAGEA: column('avg', dbl),
  SUMX: iterator('sum', num), AVERAGEX: iterator('avg', dbl), MINX: iterator('min', same), MAXX: iterator('max', same),
  COUNTX: iterator('count', int), COUNTAX: iterator('count', int), PRODUCTX: iterator('product', num), MEDIANX: iterator('median', dbl),
  'STDEVX.S': iterator('stdev_s', dbl), 'STDEVX.P': iterator('stdev_p', dbl), 'VARX.S': iterator('var_s', dbl), 'VARX.P': iterator('var_p', dbl),
  'PERCENTILE.INC': percentile('pct_inc', false), 'PERCENTILE.EXC': percentile('pct_exc', false),
  'PERCENTILEX.INC': percentile('pct_inc', true), 'PERCENTILEX.EXC': percentile('pct_exc', true),
  COUNTROWS: countRows, CONCATENATEX: concatenateX, RANKX: rankX,
  CALCULATE: calculate,
  ISFILTERED: isFiltered, ISCROSSFILTERED: isCrossFiltered, ISINSCOPE: isInScope,
  HASONEVALUE: hasOneValue, HASONEFILTER: hasOneFilter, SELECTEDVALUE: selectedValue,
  LOOKUPVALUE: lookupValue, RELATED: related, EARLIER: earlier, EARLIEST: earlier,
  CONTAINS: contains, CONTAINSROW: containsRow, ISEMPTY: isEmpty,
};
