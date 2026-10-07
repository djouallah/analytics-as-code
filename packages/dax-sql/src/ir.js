// The intermediate form between DAX and SQL.
//
// A row is a RowRef: { id, cols: [{ name, lineage, t }], kind }. Every table that is
// iterated (SUMX, FILTER, an aggregate, a group) gets one, and expressions name its columns
// through it: { k:'col', row, ref } where ref is an index into row.cols or, for a row of a
// model table, the model column itself (which can be a column of a related table: RELATED).
//
// Scalars (all carry `t`, the type, and `nn`, true when the value can never be blank):
//   lit   { v }                       a constant; v null is BLANK()
//   col   { row, ref }
//   op    { op, a }                   DAX operators, with DAX's rules for blanks (see emit.js)
//   fn    { name, a }                 a function the dialect writes (see dialects/)
//   case  { w: [[cond, value]], e }
//   agg   { fn, src, row, arg, a }    an aggregate over the rows of table `src`, `arg`
//                                     evaluated on each (in `row`)
//   exists { src }
// Tables (all carry `cols`: [{ name, lineage, t }]; `base` when the rows are rows of a
// model table, which as a filter filters its expanded table):
//   scan     { table, ctx }          the rows of a model table that the filter context keeps
//   filter   { src, row, pred }
//   project  { src, row, items: [{ name, expr, lineage, t }], keep }
//   distinct { src }
//   group    { src, row, keys: [{ name, expr, lineage, t }], items: [{ name, expr, t }] }
//   cross    { srcs }     union / intersect / except { srcs }
//   rows     { rows: [[scalar]] }    a table constructor, ROW, DATATABLE
//   series   { start, end, step }
//   topn     { src, row, n, order: [{ expr, desc }] }
//   generate { left, lrow, right, outer }
//   sc       SUMMARIZECOLUMNS (see compiler.js)
//   shared   { src }                 a table VAR: written once when nothing outside it varies
//   onerow   { vals, cond }          one row of values when cond holds (VALUES of a column the
//                                    context binds to one value), else none
//   prefix   { vals, cond, src }     the rows of src after those values, when cond holds

import { semantic } from './errors.js';

let nextId = 1;
export const newRow = (cols, kind = 'table', extra = {}) => ({ id: nextId++, cols, kind, ...extra });
export const rowOf = (src, kind) => newRow(src.cols, kind ?? (src.base ? 'scan' : 'table'), { base: src.base ?? null, src });

export const NUMERIC = new Set(['int', 'double', 'decimal']);
export const isNum = t => NUMERIC.has(t);

// The type of values of several types together, as a CASE gives them: numbers widen (whole
// to decimal to double); different kinds (a number and a text) are a variant, written as text.
export function unify(types) {
  const ts = [...new Set(types.filter(t => t && t !== 'blank'))];
  if (!ts.length) return 'blank';
  if (ts.length === 1) return ts[0];
  if (ts.every(isNum)) return ts.includes('double') ? 'double' : ts.includes('decimal') ? 'decimal' : 'int';
  if (ts.every(t => t === 'datetime' || t === 'date')) return 'datetime';
  return 'variant';
}

// --- scalars ---------------------------------------------------------------------------

export const lit = (v, t) => ({ k: 'lit', v, t: t ?? (v === null ? 'blank' : typeof v === 'boolean' ? 'bool'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double') : 'string'), nn: v !== null });
export const BLANK = lit(null, 'blank');
export const TRUE = lit(true), FALSE = lit(false);

export function col(row, ref) {
  const c = typeof ref === 'number' ? row.cols[ref] : ref;
  return { k: 'col', row, ref, t: typeof ref === 'number' ? c.t : c.type, nn: false };
}

const isLit = (x, v) => x.k === 'lit' && (v === undefined || x.v === v);

export function op(o, ...a) {
  const [l, r] = a;
  // Constants fold: the conditions ISFILTERED and its kind settle at compile time.
  if (o === 'and') {
    if (isLit(l, false) || isLit(r, false)) return FALSE;
    if (isLit(l, true)) return boolOf(r);
    if (isLit(r, true)) return boolOf(l);
  }
  if (o === 'or') {
    if (isLit(l, true) || isLit(r, true)) return TRUE;
    if (isLit(l, false)) return boolOf(r);
    if (isLit(r, false)) return boolOf(l);
  }
  if (o === 'not' && l.k === 'lit' && typeof l.v === 'boolean') return lit(!l.v);
  if (o === 'neg' && l.k === 'lit' && typeof l.v === 'number') return lit(-l.v, l.t);
  let t;
  if (['eq', 'eqs', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'not', 'in'].includes(o)) t = 'bool';
  else if (o === 'concat') t = 'string';
  else if (o === 'div' || o === 'pow') t = 'double';
  else if (o === 'neg') t = l.t;
  else if ((o === 'add' || o === 'sub') && (l.t === 'datetime' || l.t === 'date')) t = isNum(r.t) ? l.t : o === 'add' ? 'datetime' : 'double';
  else if (o === 'add' && isNum(l.t) && (r.t === 'datetime' || r.t === 'date')) t = 'datetime';
  else t = l.t === 'int' && r.t === 'int' ? 'int' : l.t === 'decimal' && r.t === 'decimal' && o !== 'mul' ? 'decimal' : 'double';
  // Comparisons and logic never give a blank; + and - give one only when both sides do.
  const nn = t === 'bool' || o === 'concat' || (o === 'add' || o === 'sub') && (l.nn || r.nn)
    || (o === 'mul' || o === 'neg') && a.every(x => x.nn);
  return { k: 'op', op: o, a, t, nn };
}
const boolOf = x => x.t === 'bool' && x.nn ? x : { k: 'op', op: 'bool', a: [x], t: 'bool', nn: true };

// `strict`: the function gives a blank when its first argument is blank (and on a constant
// blank, is one).
export const fn = (name, a, t, { nn = false, strict = false } = {}) =>
  strict && a[0]?.k === 'lit' && a[0].v === null ? lit(null, t) : ({ k: 'fn', name, a, t, nn, strict });
export function kase(w, e, t) {
  w = w.filter(([c]) => !isLit(c, false) && !(c.k === 'lit' && c.v === null));
  const first = w.findIndex(([c]) => isLit(c, true));
  if (first === 0) return w[0][1];
  if (first > 0) { e = w[first][1]; w = w.slice(0, first); }
  e ??= BLANK;
  if (!w.length) return e;
  const all = [...w.map(x => x[1]), e];
  t ??= unify(all.map(x => x.t));
  return { k: 'case', w, e, t, nn: all.every(x => x.nn) };
}
export const agg = (f, src, row, arg, t, a = []) => ({ k: 'agg', fn: f, src, row, arg, a, t, nn: false });
export const exists = src => ({ k: 'exists', src, t: 'bool', nn: true });

// --- tables ----------------------------------------------------------------------------

export const scan = (table, ctx) => ({ k: 'scan', table, ctx, base: table,
  cols: table.columns.map(c => ({ name: c.name, lineage: c, t: c.type })) });

// The rows of `src` an expression keeps. A filter, a TOPN and a CALCULATETABLE keep the rows
// what they were, so a table of a model's rows stays one.
export const filter = (src, row, pred) => isLit(pred, true) ? src : ({ k: 'filter', src, row, pred, cols: src.cols, base: src.base });

export function project(src, row, items, keep = false) {
  const cols = [...(keep ? src.cols : []), ...items.map(i => ({ name: i.name, lineage: i.lineage ?? null, t: i.t ?? i.expr.t }))];
  return { k: 'project', src, row, items, keep, cols, base: keep ? src.base : null };
}
// Distinct rows of a model table are still rows of it.
export const distinct = src => src.k === 'distinct' ? src : ({ k: 'distinct', src, cols: src.cols, base: src.base ?? null });

// A column of a row as an item: it keeps its lineage.
export const itemOf = (row, ref, name) => {
  const c = typeof ref === 'number' ? row.cols[ref] : null;
  return { name: name ?? (c ? c.name : ref.name), expr: col(row, ref), lineage: c ? c.lineage : ref, t: c ? c.t : ref.type };
};

// The values of some model columns that the filter context keeps (VALUES, SUMMARIZE).
// Where the context binds the one column to a value (a group key, a context transition),
// that is the value, when a row holds it: a table of one row, with no scan to group.
// With `blank` (VALUES and ALL, not DISTINCT and ALLNOBLANKROW), the table's blank row is one
// of them when it has one.
export function values(table, ctx, columns, scanOf, blank = false) {
  const src = scanOf(table, ctx);
  if (columns.length === 1) {
    const b = ctx.filters.find(f => f.kind === 'bind' && f.cols[0] === columns[0]);
    if (b) {
      let cond = exists(src);
      if (blank) cond = op('or', cond, op('and', fn('isblank', [b.val], 'bool', { nn: true }), { k: 'blankexists', table, ctx, t: 'bool', nn: true }));
      return oneRow([b.val], cond, [columns[0]]);
    }
  }
  const row = rowOf(src);
  const out = distinct(project(src, row, columns.map(c => itemOf(row, c))));
  return blank ? withBlank(out, table, ctx) : out;
}

// The rows of `src` (of model table `table`, or values of its columns) and the table's blank
// row, as the filter context `ctx` leaves it.
// `lineage`: the columns of the table the blank row is read as (TREATAS may rename `cols`).
export const withBlank = (src, table, ctx) => ({ k: 'withblank', src, table, ctx, cols: src.cols, base: src.base,
  lineage: src.cols.map(c => c.lineage) });

// A table of one row, the values `vals` in columns of lineage `lineages`, when `cond` holds;
// of no row when it does not.
export const oneRow = (vals, cond, lineages) => ({ k: 'onerow', vals, cond, base: null,
  cols: lineages.map(l => ({ name: l.name, lineage: l, t: l.type })) });

// The rows of `src`, each with the values `vals` before it, when `cond` holds: a CROSSJOIN of
// a one-row table and another.
export const prefix = (vals, cond, lineages, src) => ({ k: 'prefix', vals, cond, src, base: null,
  cols: [...lineages.map(l => ({ name: l.name, lineage: l, t: l.type })), ...src.cols] });

export function dateLit(v) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v.trim());
  if (!m) throw semantic(`"${v}" is not a date (expected dt"YYYY-MM-DD")`);
  const p = n => String(n).padStart(2, '0');
  const d = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  return lit(m[4] ? `${d} ${p(m[4])}:${m[5]}:${m[6] ?? '00'}` : d, 'datetime');
}

export function rowsTable(names, rows) {
  const t = names.map((n, i) => rows.map(r => r[i].t).find(x => x !== 'blank') ?? 'blank');
  return { k: 'rows', rows, cols: names.map((name, i) => ({ name, lineage: null, t: t[i] })), base: null };
}

// --- analysis --------------------------------------------------------------------------

// The rows an expression or a table reads from outside itself: the correlation of its SQL.
const _free = new WeakMap();
export function freeRows(x) {
  if (!x || typeof x !== 'object') return EMPTY;
  if (_free.has(x)) return _free.get(x);
  _free.set(x, EMPTY);   // a cycle (there should be none) reads as closed
  const out = new Set();
  const add = y => { for (const id of freeRows(y)) out.add(id); };
  const bound = new Set();
  switch (x.k) {
    case 'lit': break;
    case 'col': out.add(x.row.id); break;
    case 'op': case 'fn': x.a.forEach(add); break;
    case 'case': x.w.forEach(([c, v]) => { add(c); add(v); }); add(x.e); break;
    case 'agg': add(x.src); add(x.arg); x.a.forEach(add); x.order?.forEach(o => add(o.expr)); bound.add(x.row?.id); break;
    case 'insub': x.e.forEach(add); add(x.src); break;
    case 'exists': add(x.src); break;
    case 'scan': for (const f of x.ctx.filters) addFilter(f, add, bound); break;
    case 'filter': add(x.src); add(x.pred); bound.add(x.row.id); break;
    case 'project': add(x.src); x.items.forEach(i => add(i.expr)); bound.add(x.row.id); break;
    case 'distinct': case 'shared': add(x.src); break;
    case 'group': add(x.src); x.keys.forEach(i => add(i.expr)); x.items.forEach(i => add(i.expr)); bound.add(x.row.id); break;
    case 'cross': case 'union': case 'intersect': case 'except': x.srcs.forEach(add); break;
    case 'rows': x.rows.forEach(r => r.forEach(add)); break;
    case 'series': add(x.start); add(x.end); add(x.step); break;
    case 'topn': add(x.src); add(x.n); x.order.forEach(o => add(o.expr)); bound.add(x.row.id); break;
    case 'generate': add(x.left); add(x.right); bound.add(x.lrow.id); break;
    case 'sc': add(x.ctx0 && { k: 'scan', ctx: x.ctx0 }); x.levels.forEach(l => l.items.forEach(i => add(i.expr))); bound.add(x.keyRow.id); break;
    case 'currentgroup': break;
    case 'onerow': x.vals.forEach(add); add(x.cond); break;
    case 'withblank': add(x.src); add({ k: 'scan', ctx: x.ctx }); break;
    case 'blankexists': add({ k: 'scan', ctx: x.ctx }); break;
    case 'window': case 'wrank':
      add(x.rel); x.order.forEach(o => add(o.expr)); x.parts.forEach(add); x.match.forEach(m => add(m.val)); add(x.unbound?.table);
      [x.delta, x.pos, x.from, x.to].forEach(add); bound.add(x.row.id); break;
    case 'prefix': x.vals.forEach(add); add(x.cond); add(x.src); break;
    default: throw new Error(`freeRows: ${x.k}`);
  }
  for (const id of bound) out.delete(id);
  const res = out.size ? out : EMPTY;
  _free.set(x, res);
  return res;
}
const EMPTY = new Set();
function addFilter(f, add, bound) {
  if (f.kind === 'bind') { add(f.val); add(f.guard); }
  else if (f.kind === 'pred') { add(f.pred); bound.add(f.row.id); }
  else add(f.src);
}

// Whether an expression holds an aggregate (a subquery in SQL).
export function heavy(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.k === 'agg' || x.k === 'exists') return true;
  if (x.k === 'op' || x.k === 'fn') return x.a.some(heavy);
  if (x.k === 'case') return x.w.some(([c, v]) => heavy(c) || heavy(v)) || heavy(x.e);
  return false;
}

// The positions of the columns of row `row` that an expression or table reads.
export function rowRefs(x, rowId, out = new Set(), seen = new Set()) {
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (x.k === 'col' && x.row.id === rowId) { out.add(x.ref); return out; }
  for (const [k, v] of Object.entries(x)) {
    if (k === 'row' || k === 'lrow' || k === 'cols' || k === 'table' || k === 'base' || k === 'lineage') continue;
    if (k === 'ctx') { for (const f of v.filters) rowRefs(f, rowId, out, seen); continue; }
    if (Array.isArray(v)) v.forEach(y => rowRefs(y, rowId, out, seen));
    else if (v && typeof v === 'object') rowRefs(v, rowId, out, seen);
  }
  return out;
}
