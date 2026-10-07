// Table functions, the CALCULATE modifiers (ALL and its kind, USERELATIONSHIP, CROSSFILTER),
// and SUMMARIZECOLUMNS.
import * as ir from '../ir.js';
import { rowsTable } from '../ir.js';
import { Ctx } from '../context.js';
import { semantic, unsupported } from '../errors.js';
import { isDesc, filtersTable } from './aggregate.js';

const lc = s => String(s).toLowerCase();
const isModelTableName = (c, ast, env) => ast.k === 'name' && !env.vars.has(lc(ast.name)) && !env.queryTables.has(lc(ast.name)) && c.model.hasTable(ast.name);
const noFilters = ctx => new Ctx([], ctx.mods);

// "name", expression, "name", expression ... from argument `from` on.
function pairs(args, from, what) {
  const out = [];
  for (let i = from; i < args.length; i += 2) {
    if (args[i].k !== 'str' || !args[i + 1]) throw semantic(`${what} expects "name", expression pairs`);
    out.push([args[i].v, args[i + 1]]);
  }
  return out;
}

// An item of SELECTCOLUMNS or ADDCOLUMNS: a plain column keeps its lineage.
function item(c, name, ast, env) {
  const expr = c.scalar(ast, env);
  const lineage = expr.k === 'col' ? (typeof expr.ref === 'number' ? expr.row.cols[expr.ref].lineage : expr.ref) : null;
  return { name, expr, lineage, t: expr.t };
}

// --- reading the model ------------------------------------------------------------------

function all(c, args, env, ast) {
  if (!args.length) throw semantic(`${ast.fn}() with no argument is only valid as a CALCULATE filter`);
  if (args.length === 1 && isModelTableName(c, args[0], env)) return c.scan(c.model.table(args[0].name), noFilters(env.ctx));
  // ALL(T[a], T[b]): the combinations of values the table holds, filters ignored.
  const cols = args.map(a => c.modelColumn(a, env));
  const t = cols[0].table;
  if (cols.some(x => x.table !== t)) throw semantic(`${ast.fn} takes columns of one table`);
  return ir.values(t, noFilters(env.ctx), cols, (tb, ctx) => c.scan(tb, ctx));
}

function allExcept(c, args, env) {
  if (!isModelTableName(c, args[0], env)) throw semantic('ALLEXCEPT(table, column, ...)');
  const t = c.model.table(args[0].name), keep = new Set(args.slice(1).map(a => c.modelColumn(a, env)));
  const exp = c.expandedColumns(t, env.ctx);
  return c.scan(t, env.ctx.remove(x => exp.has(x) && !keep.has(x)));
}

function allSelected(c, args, env) {
  const cols = args.length ? new Set(args.flatMap(a => isModelTableName(c, a, env) ? [...c.expandedColumns(c.model.table(a.name), env.ctx)] : [c.modelColumn(a, env)])) : null;
  const ctx = c.allSelected(env.ctx, env, cols);
  if (args.length === 1 && isModelTableName(c, args[0], env)) return c.scan(c.model.table(args[0].name), ctx);
  if (!args.length) throw semantic('ALLSELECTED() with no argument is only valid as a CALCULATE filter');
  const list = args.map(a => c.modelColumn(a, env));
  return ir.values(list[0].table, ctx, list, (tb, x) => c.scan(tb, x));
}

function valuesFn(c, args, env) {
  const a = args[0];
  if (isModelTableName(c, a, env)) return ir.distinct(c.scan(c.model.table(a.name), env.ctx));
  if (a.k === 'col' && a.table && c.model.findColumn(a.table, a.name)) {
    const col = c.modelColumn(a, env);
    return ir.values(col.table, env.ctx, [col], (tb, ctx) => c.scan(tb, ctx));
  }
  return ir.distinct(c.table(a, env));
}

function calculateTable(c, args, env) {
  const ctx = c.calculateCtx(args.slice(1), env);
  return c.table(args[0], { ...env, ctx, rows: [] });
}

function relatedTable(c, args, env) {
  if (!isModelTableName(c, args[0], env)) throw semantic('RELATEDTABLE(table)');
  return c.scan(c.model.table(args[0].name), c.transition(env));
}

function filterFn(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src);
  return ir.filter(src, row, c.scalar(args[1], { ...env, rows: [...env.rows, row] }));
}

function addColumns(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src), inner = { ...env, rows: [...env.rows, row] };
  return ir.project(src, row, pairs(args, 1, 'ADDCOLUMNS').map(([n, x]) => item(c, n, x, inner)), true);
}

function selectColumns(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src), inner = { ...env, rows: [...env.rows, row] };
  const items = [];
  for (let i = 1; i < args.length;) {
    if (args[i].k === 'str') { items.push(item(c, args[i].v, args[i + 1], inner)); i += 2; continue; }
    // SELECTCOLUMNS(t, T[c]): named after the column.
    if (args[i].k !== 'col') throw semantic('SELECTCOLUMNS expects "name", expression pairs');
    items.push(item(c, args[i].name, args[i], inner));
    i++;
  }
  return ir.project(src, row, items);
}

// The columns of a table named by Table[Column] or [Column]: their positions.
function columnsIn(c, t, asts, env, what) {
  return asts.map(a => {
    if (a.k !== 'col') throw semantic(`${what} groups by columns`);
    let i = a.table ? t.cols.findIndex(x => x.lineage && lc(x.lineage.table.name) === lc(a.table) && lc(x.lineage.name) === lc(a.name)) : -1;
    if (i < 0) i = t.cols.findIndex(x => lc(x.name) === lc(a.name) && (!a.table || !x.lineage));
    if (i < 0 && a.table && t.base) {
      // A column of a related table, through the expanded table (SUMMARIZE(Sales, Product[Color])).
      const col = c.model.findColumn(a.table, a.name);
      if (col && c.model.expand(t.base, c.model.state(env.ctx.mods), null, true).has(col.table.name)) return col;
    }
    if (i < 0) throw semantic(`${what}: the table has no column ${a.table ? `'${a.table}'` : ''}[${a.name}]`);
    return i;
  });
}

// How a grouping column is read off a row: a model table's row by the model column, any
// other (or a column added to it) by position.
const keyRef = (row, src, r) => (row.kind === 'scan' && typeof r === 'number' && src.cols[r].lineage ? src.cols[r].lineage : r);

function summarize(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src);
  let i = 1;
  while (i < args.length && args[i].k === 'col') i++;
  if (args[i]?.k === 'call' && (args[i].fn === 'ROLLUP' || args[i].fn === 'ROLLUPGROUP')) throw unsupported('ROLLUP in SUMMARIZE (SUMMARIZECOLUMNS with ROLLUPADDISSUBTOTAL is)');
  const refs = columnsIn(c, src, args.slice(1, i), env, 'SUMMARIZE');
  const keys = refs.map(r => ir.itemOf(row, keyRef(row, src, r)));
  const grouped = { k: 'group', src, row, keys, items: [], cols: keys.map(k => ({ name: k.name, lineage: k.lineage, t: k.t })), base: null };
  const ext = pairs(args, i, 'SUMMARIZE');
  if (!ext.length) return grouped;
  // Its expressions, as ADDCOLUMNS over the groups, each with its group as the filter
  // context (SUMMARIZE's own context transition) and its row.
  const grow = ir.rowOf(grouped, 'table');
  const inner = { ...env, ctx: c.transitionRow(env.ctx, grow), rows: [...env.rows, grow] };
  return ir.project(grouped, grow, ext.map(([n, x]) => item(c, n, x, inner)), true);
}

function groupBy(c, args, env) {
  const src = c.table(args[0], env), row = ir.rowOf(src);
  let i = 1;
  while (i < args.length && args[i].k === 'col') i++;
  const refs = columnsIn(c, src, args.slice(1, i), env, 'GROUPBY');
  const keys = refs.map(r => ir.itemOf(row, keyRef(row, src, r)));
  const inner = { ...env, rows: env.rows, currentGroup: { src, row } };
  const items = pairs(args, i, 'GROUPBY').map(([n, x]) => {
    const expr = c.scalar(x, inner);
    return { name: n, expr, t: expr.t };
  });
  return { k: 'group', src, row, keys, items, cols: [...keys, ...items].map(k => ({ name: k.name, lineage: k.lineage ?? null, t: k.t })), base: null };
}

function currentGroup(c, args, env) {
  if (!env.currentGroup) throw semantic('CURRENTGROUP() is only valid inside GROUPBY');
  return { k: 'currentgroup', cols: env.currentGroup.src.cols, group: env.currentGroup };
}

function topN(c, args, env) {
  const n = c.scalar(args[0], env), src = c.table(args[1], env), row = ir.rowOf(src);
  const inner = { ...env, rows: [...env.rows, row] }, order = [];
  for (let i = 2; i < args.length; i += 2) order.push({ expr: c.scalar(args[i], inner), desc: isDesc(args[i + 1], true) });
  if (!order.length) throw unsupported('TOPN without an order');
  return { k: 'topn', src, row, n, order, cols: src.cols, base: src.base };
}

function crossJoin(c, args, env) {
  const srcs = args.map(a => c.table(a, env));
  // Rows of one value each: one row of all of them; before other tables, a prefix of theirs.
  const ones = srcs.findIndex(s => !(s.k === 'onerow' && s.cols.every(x => x.lineage)));
  const head = ones < 0 ? srcs : srcs.slice(0, ones), rest = ones < 0 ? [] : srcs.slice(ones);
  if (head.length) {
    const vals = head.flatMap(s => s.vals), lineages = head.flatMap(s => s.cols.map(x => x.lineage));
    const cond = head.map(s => s.cond).reduce((a, b) => ir.op('and', a, b));
    if (!rest.length) return ir.oneRow(vals, cond, lineages);
    const tail = rest.length === 1 ? rest[0] : { k: 'cross', srcs: rest, cols: rest.flatMap(s => s.cols), base: null };
    return ir.prefix(vals, cond, lineages, tail);
  }
  return { k: 'cross', srcs, cols: srcs.flatMap(s => s.cols), base: null };
}

function setOp(k) {
  return (c, args, env) => {
    const srcs = args.map(a => c.table(a, env));
    const n = srcs[0].cols.length;
    // One value EXCEPT (or INTERSECT) a column: that value, if it is not (is) in the column.
    if (k !== 'union' && srcs[0].k === 'onerow' && srcs.slice(1).every(s => s.cols.length === n)) {
      let cond = srcs[0].cond;
      for (const s of srcs.slice(1)) {
        const hit = { k: 'insub', e: srcs[0].vals, src: s, t: 'bool', nn: true };
        cond = ir.op('and', cond, k === 'except' ? ir.op('not', hit) : hit);
      }
      return { ...srcs[0], cond };
    }
    // Values before a table, EXCEPT (or INTERSECT) a table: the rows of the table that, after
    // the values, are not (are) in it.
    if (k !== 'union' && srcs[0].k === 'prefix' && srcs.slice(1).every(s => s.cols.length === n)) {
      const p = srcs[0];
      let src = p.src;
      for (const s of srcs.slice(1)) {
        const row = ir.rowOf(src, 'table');
        const hit = { k: 'insub', e: [...p.vals, ...src.cols.map((_, i) => ir.col(row, i))], src: s, t: 'bool', nn: true };
        src = ir.filter(src, row, k === 'except' ? ir.op('not', hit) : hit);
      }
      return { ...p, src };
    }
    if (srcs.some(s => s.cols.length !== n)) throw semantic(`${k.toUpperCase()}: the tables have different numbers of columns`);
    // UNION keeps a column's lineage when every table agrees on it; the others the first's.
    const cols = srcs[0].cols.map((col, i) => ({ ...col,
      lineage: k !== 'union' || srcs.every(s => s.cols[i].lineage === col.lineage) ? col.lineage : null }));
    return { k, srcs, cols, base: k === 'union' ? null : srcs[0].base };
  };
}

function generate(outer) {
  return (c, args, env) => {
    const left = c.table(args[0], env), lrow = ir.rowOf(left);
    const right = c.table(args[1], { ...env, rows: [...env.rows, lrow] });
    return { k: 'generate', left, lrow, right, outer, cols: [...left.cols, ...right.cols], base: null };
  };
}

function rowFn(c, args, env) {
  const p = pairs(args, 0, 'ROW');
  return rowsTable(p.map(x => x[0]), [p.map(x => c.scalar(x[1], env))]);
}

function dataTable(c, args, env) {
  const data = args.at(-1);
  if (data?.k !== 'table') throw semantic('DATATABLE ends with the rows, { { ... } }');
  const names = [];
  for (let i = 0; i + 1 < args.length - 1; i += 2) names.push(args[i].v);
  // { { 1, "a" }, { 2, "b" } }: each inner { } is a row.
  const rows = data.rows.map(r => {
    const cells = r.length === 1 && r[0].k === 'table' ? r[0].rows.map(x => x[0]) : r;
    return cells.map(x => c.scalar(x, env));
  });
  return rowsTable(names, rows);
}

function series(c, args, env) {
  const start = c.scalar(args[0], env), end = c.scalar(args[1], env), step = args[2] ? c.scalar(args[2], env) : ir.lit(1);
  const t = [start, end, step].every(x => x.t === 'int') ? 'int' : 'double';
  return { k: 'series', start, end, step, cols: [{ name: 'Value', lineage: null, t }], base: null };
}
function calendar(c, args, env) {
  const start = c.scalar(args[0], env), end = c.scalar(args[1], env);
  return { k: 'series', start, end, step: ir.lit(1), cols: [{ name: 'Date', lineage: null, t: 'datetime' }], base: null };
}

function treatAs(c, args, env) {
  const t = c.table(args[0], env);
  const cols = args.slice(1).map(a => c.modelColumn(a, env));
  if (cols.length !== t.cols.length) throw semantic(`TREATAS: the table has ${t.cols.length} column(s) and ${cols.length} are named`);
  return { ...t, cols: t.cols.map((x, i) => ({ ...x, lineage: cols[i] })), base: null };
}

function keepFiltersTable(c, args, env) { return c.table(args[0], env); }

function filters(c, args, env) { return filtersTable(c, c.modelColumn(args[0], env), env); }

// FIRSTNONBLANK(T[c], expr): the first value of the column for which expr is not blank.
function nonBlank(fn) {
  return (c, args, env) => {
    const col = c.modelColumn(args[0], env);
    const src = ir.values(col.table, env.ctx, [col], (tb, ctx) => c.scan(tb, ctx));
    const row = ir.rowOf(src, 'table');
    const e = c.scalar(args[1], { ...env, rows: [...env.rows, row] });
    const kept = ir.filter(src, row, ir.op('not', ir.fn('isblank', [e], 'bool', { nn: true })));
    const krow = ir.rowOf(kept, 'table');
    const v = ir.agg(fn, kept, krow, ir.col(krow, 0), col.type);
    return { k: 'rows', rows: [[v]], cols: [{ name: col.name, lineage: col, t: col.type }], base: null, nonEmpty: true };
  };
}

// --- SUMMARIZECOLUMNS -------------------------------------------------------------------
// The groups: the combinations of the grouping columns' values the filters keep (within one
// table, the combinations it holds; across tables, all of them), and each expression
// evaluated with the group's values as filters. A group whose expressions are all blank is
// left out. With ROLLUPADDISSUBTOTAL, each level of subtotals is the same with fewer keys.
function summarizeColumns(c, args, env) {
  const plain = [], rolls = [], keyCols = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.k === 'col' && a.table && c.model.findColumn(a.table, a.name)) { const k = c.modelColumn(a, env); plain.push(k); keyCols.push(k); continue; }
    if (a.k === 'call' && a.fn === 'ROLLUPADDISSUBTOTAL') { const r = rollup(c, a.args, env); rolls.push(...r); keyCols.push(...r.flatMap(x => x.cols)); continue; }
    if (a.k === 'call' && a.fn === 'ROLLUPGROUP') { const ks = a.args.map(x => c.modelColumn(x, env)); plain.push(...ks); keyCols.push(...ks); continue; }
    break;
  }
  const filterArgs = [];
  for (; i < args.length && args[i].k !== 'str'; i++) filterArgs.push(args[i]);
  const exprs = pairs(args, i, 'SUMMARIZECOLUMNS');
  const ctx0 = filterArgs.length ? c.calculateCtx(filterArgs, { ...env, rows: [] }) : env.ctx;
  if (new Set(keyCols).size !== keyCols.length) throw semantic('SUMMARIZECOLUMNS groups by the same column twice');
  const keyRow = ir.newRow(keyCols.map(k => ({ name: k.name, lineage: k, t: k.type })), 'key');
  const levels = [];
  for (let j = rolls.length; j >= 0; j--) {
    const on = new Set([...plain, ...rolls.slice(0, j).flatMap(r => r.cols)]);
    const active = keyCols.filter(k => on.has(k));
    let ctx = ctx0;
    for (const k of active) ctx = ctx.add({ kind: 'bind', cols: [k], val: ir.col(keyRow, keyCols.indexOf(k)) });
    const inner = { ...env, ctx, rows: [], grouped: new Set(active), shadow: ctx0 };
    const items = exprs.map(([name, x]) => {
      const ignore = x.k === 'call' && (x.fn === 'IGNORE' || x.fn === 'NONVISUAL') ;
      const expr = c.scalar(ignore ? x.args[0] : x, inner);
      return { name, expr, t: expr.t, ignore: x.k === 'call' && x.fn === 'IGNORE' };
    });
    levels.push({ active, flags: rolls.map((_, n) => n >= j), items });
  }
  const cols = [...keyCols.map(k => ({ name: k.name, lineage: k, t: k.type })),
    ...rolls.map(r => ({ name: r.flag, lineage: null, t: 'bool' })),
    ...exprs.map(([name], n) => ({ name, lineage: null, t: levels[0].items[n].t }))];
  return { k: 'sc', keyRow, keyCols, rolls, levels, ctx0, cols, base: null };
}

// ROLLUPADDISSUBTOTAL(col | ROLLUPGROUP(cols), "flag", ...) -> [{ cols, flag }].
function rollup(c, args, env) {
  const out = [];
  for (let i = 0; i < args.length;) {
    const a = args[i];
    let cols;
    if (a.k === 'call' && a.fn === 'ROLLUPGROUP') cols = a.args.map(x => c.modelColumn(x, env));
    else if (a.k === 'col') cols = [c.modelColumn(a, env)];
    else throw unsupported('ROLLUPADDISSUBTOTAL with a filter');
    if (args[i + 1]?.k !== 'str') throw semantic('ROLLUPADDISSUBTOTAL(column, "name", ...)');
    out.push({ cols, flag: args[i + 1].v });
    i += 2;
    // A group-level filter table after the name is not supported.
    if (i < args.length && args[i].k !== 'col' && !(args[i].k === 'call' && args[i].fn === 'ROLLUPGROUP'))
      throw unsupported('ROLLUPADDISSUBTOTAL with a filter');
  }
  return out;
}

// --- modifiers --------------------------------------------------------------------------

// ALL(...) and REMOVEFILTERS(...) as filter arguments: remove filters.
function removeMod(c, args, env) {
  if (!args.length || args.every(a => a.k === 'empty')) return { kind: 'remove', all: true };
  const tables = [], cols = new Set();
  for (const a of args) {
    if (isModelTableName(c, a, env)) tables.push(c.model.table(a.name));
    else cols.add(c.modelColumn(a, env));
  }
  return { kind: 'remove', drop: ctx => {
    const hit = new Set(cols);
    for (const t of tables) for (const x of c.expandedColumns(t, ctx)) hit.add(x);
    return x => hit.has(x);
  } };
}
function allExceptMod(c, args, env) {
  if (!isModelTableName(c, args[0], env)) throw semantic('ALLEXCEPT(table, column, ...)');
  const t = c.model.table(args[0].name), keep = new Set(args.slice(1).map(a => c.modelColumn(a, env)));
  return { kind: 'remove', drop: ctx => { const exp = c.expandedColumns(t, ctx); return x => exp.has(x) && !keep.has(x); } };
}
function allSelectedMod(c, args, env) {
  if (!args.length) return { kind: 'selected', cols: null };
  const cols = new Set(args.flatMap(a => isModelTableName(c, a, env) ? [...c.expandedColumns(c.model.table(a.name), env.ctx)] : [c.modelColumn(a, env)]));
  return { kind: 'selected', cols };
}
function useRelationship(c, args, env) {
  const a = c.modelColumn(args[0], env), b = c.modelColumn(args[1], env);
  const rel = c.model.relationshipOf(a, b);
  if (!rel) throw semantic(`USERELATIONSHIP: no relationship between '${a.table.name}'[${a.name}] and '${b.table.name}'[${b.name}]`);
  return { kind: 'mods', change: mods => {
    for (const r of c.model.relationships) {
      const sameTables = new Set([r.from.table, r.to.table]);
      if (r !== rel && sameTables.has(rel.from.table) && sameTables.has(rel.to.table)) mods.active.set(r.name, false);
    }
    mods.active.set(rel.name, true);
  } };
}
function crossFilter(c, args, env) {
  const a = c.modelColumn(args[0], env), b = c.modelColumn(args[1], env);
  const rel = c.model.relationshipOf(a, b);
  if (!rel) throw semantic(`CROSSFILTER: no relationship between '${a.table.name}'[${a.name}] and '${b.table.name}'[${b.name}]`);
  const d = args[2]?.k === 'name' ? args[2].name.toUpperCase() : (args[2]?.k === 'num' ? ['NONE', 'ONEWAY', 'BOTH'][Number(args[2].v)] : null);
  // Left is the first column: LeftFiltersRight is the usual way when it is the one side.
  const leftIsOne = rel.to === a;
  const cross = { NONE: 'none', BOTH: 'both', ONEWAY: 'single',
    ONEWAY_LEFTFILTERSRIGHT: leftIsOne ? 'single' : 'reverse', ONEWAY_RIGHTFILTERSLEFT: leftIsOne ? 'reverse' : 'single' }[d];
  if (!cross) throw semantic('CROSSFILTER(column, column, None | OneWay | Both | OneWay_LeftFiltersRight | OneWay_RightFiltersLeft)');
  return { kind: 'mods', change: mods => mods.cross.set(rel.name, cross) };
}

export const table = {
  ALL: all, ALLNOBLANKROW: all, ALLEXCEPT: allExcept, ALLSELECTED: allSelected, ALLCROSSFILTERED: all,
  VALUES: valuesFn, DISTINCT: valuesFn, CALCULATETABLE: calculateTable, RELATEDTABLE: relatedTable,
  FILTER: filterFn, ADDCOLUMNS: addColumns, SELECTCOLUMNS: selectColumns, SUMMARIZE: summarize, GROUPBY: groupBy,
  CURRENTGROUP: currentGroup, SUMMARIZECOLUMNS: summarizeColumns, TOPN: topN, CROSSJOIN: crossJoin,
  UNION: setOp('union'), INTERSECT: setOp('intersect'), EXCEPT: setOp('except'),
  GENERATE: generate(false), GENERATEALL: generate(true), ROW: rowFn, DATATABLE: dataTable,
  GENERATESERIES: series, CALENDAR: calendar, TREATAS: treatAs, KEEPFILTERS: keepFiltersTable, FILTERS: filters,
  FIRSTNONBLANK: nonBlank('min'), LASTNONBLANK: nonBlank('max'),
};

export const modifiers = {
  ALL: removeMod, ALLNOBLANKROW: removeMod, REMOVEFILTERS: removeMod, ALLCROSSFILTERED: removeMod,
  ALLEXCEPT: allExceptMod, ALLSELECTED: allSelectedMod,
  USERELATIONSHIP: useRelationship, CROSSFILTER: crossFilter,
};
