// Window functions: INDEX, OFFSET and WINDOW (tables of rows of a relation) and RANK and
// ROWNUMBER (values), with ORDERBY, PARTITIONBY and MATCHBY.
//
// The relation's rows are numbered within their partitions, in the order (ir 'window' and
// 'wrank'; emit.js writes them). The current row is the relation's row whose columns hold the
// outer values: a row context's column of that lineage, or the value the filter context binds
// the column to (a group key, a context transition). A column with no outer value takes each
// of its values in the filter context, and the result is the union over them. With no
// relation, it is ALLSELECTED of the ORDERBY and PARTITIONBY columns.
import * as ir from '../ir.js';
import { semantic, unsupported } from '../errors.js';
import { isDesc } from './aggregate.js';

const lc = s => String(s).toLowerCase();
const word = (a, set) => a?.k === 'name' && set.includes(a.name.toUpperCase());
const BLANKS = ['DEFAULT', 'FIRST', 'LAST'];

// The arguments after the leading ones: relation, ORDERBY(), blanks, PARTITIONBY(), MATCHBY().
function windowArgs(c, args, env, fn) {
  let relAst = null, orderAst = null, partAst = null, matchAst = null, blanks = 'default';
  for (const a of args) {
    if (a.k === 'empty') continue;
    if (a.k === 'call' && a.fn === 'ORDERBY') orderAst = a;
    else if (a.k === 'call' && a.fn === 'PARTITIONBY') partAst = a;
    else if (a.k === 'call' && a.fn === 'MATCHBY') matchAst = a;
    else if (word(a, BLANKS)) blanks = a.name.toLowerCase();
    else if (word(a, ['NONE', 'LOWESTPARENT', 'HIGHESTPARENT'])) throw unsupported(`${fn}'s reset (visual calculations only)`);
    else if (!relAst && c.isTable(a, env)) relAst = a;
    else throw semantic(`${fn}: unexpected argument`);
  }
  // ORDERBY(expr, [ASC|DESC], [FIRST|LAST|DEFAULT], ...)
  const order = [];
  if (orderAst) {
    const o = orderAst.args;
    for (let i = 0; i < o.length;) {
      const ast = o[i++];
      let desc = false, bl = null;
      if (i < o.length && (word(o[i], ['ASC', 'DESC']) || o[i].k === 'num' || o[i].k === 'bool')) {
        bl = o[i].blanks ?? null;   // ASC BLANKS LAST
        desc = isDesc(o[i++], false);
      }
      if (i < o.length && word(o[i], BLANKS)) bl = o[i++].name.toLowerCase();
      order.push({ ast, desc, blanks: bl });
    }
  }
  const part = partAst?.args ?? [], match = matchAst?.args ?? null;

  let rel;
  if (relAst) rel = c.table(relAst, env);
  else {
    if (!orderAst) throw semantic(`${fn} needs a relation or an ORDERBY`);
    const cols = [...order.map(o => o.ast), ...part].map(a => {
      if (a.k !== 'col' || !a.table) throw semantic(`${fn} with no relation: ORDERBY and PARTITIONBY take columns like Table[Column]`);
      return c.modelColumn(a, env);
    });
    const unique = [...new Set(cols)];
    if (unique.some(x => x.table !== unique[0].table)) throw semantic(`${fn} with no relation: the columns must be of one table`);
    // ALLSELECTED of the columns, as a table: their values under the last shadow on them.
    const ctx = c.allSelected(env.ctx.removeAll(), env, new Set(unique), true);
    rel = ir.values(unique[0].table, ctx, unique, (t, x) => c.scan(t, x), c.blankRowRels(unique[0].table).length > 0);
  }
  const row = ir.rowOf(rel, 'table'), inner = c.iter(env, row);
  const index = (a, what) => {
    if (a.k !== 'col') throw semantic(`${fn}: ${what} takes columns`);
    let i = a.table ? rel.cols.findIndex(x => x.lineage && lc(x.lineage.table.name) === lc(a.table) && lc(x.lineage.name) === lc(a.name)) : -1;
    if (i < 0) i = rel.cols.findIndex(x => lc(x.name) === lc(a.name));
    if (i < 0) throw semantic(`${fn}: the relation has no column ${a.table ? `'${a.table}'` : ''}[${a.name}]`);
    return i;
  };
  // PARTITIONBY: columns of the relation, or of a table related to it (read with RELATED).
  const partExprs = [], parts = [];
  for (const a of part) {
    let i = -1;
    try { i = index(a, 'PARTITIONBY'); } catch (e) {
      if (!(a.k === 'col' && a.table && rel.base && c.model.findColumn(a.table, a.name))) throw e;
    }
    if (i >= 0) { parts.push(i); partExprs.push(ir.col(row, i)); } else partExprs.push(c.scalar({ k: 'call', fn: 'RELATED', args: [a] }, inner));
  }
  const related = partExprs.length > parts.length;
  const orderBy = order.length
    ? order.map(o => { const expr = c.scalar(o.ast, inner); return { expr, desc: o.desc, blanks: o.blanks ?? blanks, t: expr.t }; })
    : rel.cols.map((x, i) => (parts.includes(i) ? null : { expr: ir.col(row, i), desc: false, blanks, t: x.t })).filter(Boolean);
  // The columns that say which row is the current one. With a related table's column in
  // PARTITIONBY, the whole row (its partition follows from it).
  const matched = match ? [...new Set([...match.map(a => index(a, 'MATCHBY')), ...(related ? allCols({ rel }) : parts)])] : null;
  return { rel, row, orderBy, parts: related ? null : parts, partExprs, matched, hasMatch: !!match };
}

// The current row's columns' outer values; those with none, from their values in context.
function currentRow(c, env, rel, idx) {
  const match = [], loose = [];
  for (const i of idx) {
    const l = rel.cols[i].lineage;
    if (!l) continue;   // a column a table function added has no outer value
    const fromRow = c.rowColumn(env, l.table.name, l.name);
    if (fromRow) { match.push({ i, val: fromRow }); continue; }
    const b = env.ctx.filters.find(f => f.kind === 'bind' && f.cols[0] === l);
    if (b) { match.push({ i, val: b.val }); continue; }
    loose.push(i);
  }
  let unbound = null;
  if (loose.length) {
    const byTable = new Map();
    for (const i of loose) {
      const l = rel.cols[i].lineage;
      if (!byTable.has(l.table)) byTable.set(l.table, []);
      byTable.get(l.table).push(i);
    }
    const parts = [...byTable].map(([t, is]) => ir.values(t, env.ctx, is.map(i => rel.cols[i].lineage), (tb, x) => c.scan(tb, x)));
    const order = [...byTable.values()].flat();
    const table = parts.length === 1 ? parts[0] : { k: 'cross', srcs: parts, cols: parts.flatMap(p => p.cols), base: null };
    unbound = { table, idx: order };
  }
  return { match, unbound };
}

function node(k, fn, w, cur, extra) {
  return { k, fn, rel: w.rel, row: w.row, order: w.orderBy, parts: w.partExprs,
    match: cur.match, unbound: cur.unbound, cols: w.rel.cols, base: w.rel.base, ...extra };
}
const allCols = w => w.rel.cols.map((_, i) => i);
// The columns that say which partition is the current one: PARTITIONBY's (all of the
// relation's when one is a related table's).
const partCols = w => w.parts ?? allCols(w);
// RANK's current row: the ORDERBY and PARTITIONBY columns, as the documentation says (when
// every ORDERBY expression is a column of the relation; else the whole row). Rows tied on
// them share the rank.
function rankCols(w) {
  if (!w.parts) return allCols(w);
  const ids = w.orderBy.map(o => (o.expr.k === 'col' && o.expr.row === w.row
    ? (typeof o.expr.ref === 'number' ? o.expr.ref : w.rel.cols.findIndex(c => c.lineage === o.expr.ref)) : -1));
  return ids.includes(-1) ? allCols(w) : [...new Set([...ids, ...w.parts])];
}

function offset(c, args, env) {
  const delta = c.scalar(args[0], env);
  const w = windowArgs(c, args.slice(1), env, 'OFFSET');
  return node('window', 'offset', w, currentRow(c, env, w.rel, w.matched ?? allCols(w)), { delta, needCur: true });
}

function index(c, args, env) {
  const pos = c.scalar(args[0], env);
  const w = windowArgs(c, args.slice(1), env, 'INDEX');
  const idx = w.matched ?? partCols(w);
  return node('window', 'index', w, currentRow(c, env, w.rel, idx), { pos, needCur: idx.length > 0 });
}

function windowFn(c, args, env) {
  // WINDOW(from[, ABS|REL], to[, ABS|REL], ...)
  let i = 0;
  const from = c.scalar(args[i++], env);
  let fromAbs = false, toAbs = false;
  if (word(args[i], ['ABS', 'REL'])) fromAbs = args[i++].name.toUpperCase() === 'ABS';
  const to = c.scalar(args[i++], env);
  if (word(args[i], ['ABS', 'REL'])) toAbs = args[i++].name.toUpperCase() === 'ABS';
  const w = windowArgs(c, args.slice(i), env, 'WINDOW');
  const needCur = !fromAbs || !toAbs || w.partExprs.length > 0 || w.hasMatch;
  const idx = w.matched ?? (fromAbs && toAbs ? partCols(w) : allCols(w));
  return node('window', 'window', w, currentRow(c, env, w.rel, idx), { from, to, fromAbs, toAbs, needCur });
}

function rank(fn) {
  return (c, args, env) => {
    let dense = false, rest = args;
    if (fn === 'rank' && word(args[0], ['DENSE', 'SKIP'])) { dense = args[0].name.toUpperCase() === 'DENSE'; rest = args.slice(1); }
    else if (fn === 'rank' && args[0]?.k === 'empty') rest = args.slice(1);
    const w = windowArgs(c, rest, env, fn.toUpperCase());
    const x = node('wrank', fn, w, currentRow(c, env, w.rel, w.matched ?? (fn === 'rank' ? rankCols(w) : allCols(w))), { dense, needCur: true });
    return { ...x, t: 'int', nn: false };
  };
}

const onlyInside = name => () => { throw semantic(`${name} is only valid as an argument of INDEX, OFFSET, WINDOW, RANK or ROWNUMBER`); };

export const table = { INDEX: index, OFFSET: offset, WINDOW: windowFn };
export const scalar = {
  RANK: rank('rank'), ROWNUMBER: rank('rownumber'),
  ORDERBY: onlyInside('ORDERBY'), PARTITIONBY: onlyInside('PARTITIONBY'), MATCHBY: onlyInside('MATCHBY'),
};
