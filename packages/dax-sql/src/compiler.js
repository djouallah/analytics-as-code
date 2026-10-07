// DAX tree -> intermediate form (ir.js), with DAX's evaluation rules.
//
// The compiler walks an expression with an environment `env`:
//   ctx      the filter context (context.js)
//   rows     the row contexts, outermost first: RowRefs of the tables being iterated
//   vars     variables in scope: name -> { ast, env, scalar?, table? }, compiled when used
//   grouped  the columns SUMMARIZECOLUMNS groups by here (ISINSCOPE)
//   shadow   the filter context the query set before grouping (ALLSELECTED)
//   stack    the measures being expanded (a measure cannot name itself)
// What DAX does at run time, the compiler does with these at compile time: CALCULATE builds a
// new ctx (its filter arguments evaluated in the outer one, then context transition, then
// ALL and the other modifiers, then the filters, each replacing what the context said about
// its columns unless it is KEEPFILTERS); a measure is its expression under CALCULATE; an
// aggregate is a scan of its table under the ctx of where it stands.
import { parseExpression, parseQuery } from './parser.js';
import { DaxError, semantic, unsupported } from './errors.js';
import { Ctx, EMPTY_CTX } from './context.js';
import { isDateKey } from './model.js';
import * as ir from './ir.js';
import { dateLit, rowsTable } from './ir.js';
import { SCALAR, TABLE, MODIFIERS } from './functions/index.js';

const lc = s => String(s).toLowerCase();

export class Compiler {
  constructor(model, options = {}) {
    this.model = model;
    this.options = options;
  }

  // A DAX query -> [{ table, order, define }] one per EVALUATE.
  query(src) {
    const q = parseQuery(src);
    const model = this.model.fork(), c = new Compiler(model, this.options);
    const queryVars = new Map(), queryTables = new Map();
    const env0 = c.env({ vars: queryVars, queryTables, queryVarsTop: queryVars });
    for (const d of q.defines) {
      if (d.kind === 'measure') {
        const table = model.table(d.table);
        model.measures.set(lc(d.name), { name: d.name, table, text: null, ast: d.e, query: true });
      } else if (d.kind === 'var') queryVars.set(lc(d.name), { ast: d.e, env: { ...env0, vars: new Map(queryVars) } });
      else if (d.kind === 'table') queryTables.set(lc(d.name), { ast: d.e, env: { ...env0, vars: new Map(queryVars) } });
      else throw unsupported(`DEFINE ${d.kind.toUpperCase()}`);
    }
    return q.evaluates.map(ev => {
      const table = c.table(ev.e, env0);
      const row = ir.rowOf(table, 'table');
      const order = ev.order.map(o => ({ expr: c.scalar(o.e, { ...env0, rows: [row], orderBy: true }), desc: o.desc }));
      return { table, row, order };
    });
  }

  // One expression (a measure, say) in an empty filter context.
  expression(src, { table: asTable = false } = {}) {
    const ast = typeof src === 'string' ? parseExpression(src) : src;
    return asTable ? this.table(ast, this.env()) : this.scalar(ast, this.env());
  }

  env(o = {}) {
    return { ctx: EMPTY_CTX, rows: [], vars: new Map(), grouped: new Set(), shadow: null, stack: [], queryTables: new Map(), ...o };
  }

  // --- what a name is ------------------------------------------------------------------

  isTable(ast, env) {
    switch (ast.k) {
      case 'call': return TABLE.has(ast.fn) && !SCALAR.has(ast.fn) || ast.fn === 'CALCULATETABLE';
      case 'name': {
        const v = env.vars.get(lc(ast.name));
        if (v) return this.isTable(v.ast, v.env);
        return env.queryTables.has(lc(ast.name)) || this.model.hasTable(ast.name);
      }
      case 'table': return true;
      case 'var': return this.isTable(ast.body, env);
      default: return false;
    }
  }

  // A column of a row context, innermost first: Table[Column], or [Column] by name.
  rowColumn(env, table, name) {
    for (let i = env.rows.length - 1; i >= 0; i--) {
      const row = env.rows[i];
      if (row.kind === 'virtual' && table) {
        const c = this.model.findColumn(table, name);
        if (!c) continue;
        if (!row.cols.some(x => x.lineage === c)) {
          if (!row.open) continue;
          if (row.cols.length && row.cols[0].lineage.table !== c.table)
            throw semantic(`a CALCULATE filter can name the columns of one table only ('${row.cols[0].lineage.table.name}', '${c.table.name}')`);
          row.cols.push({ name: c.name, lineage: c, t: c.type });
        }
        return ir.col(row, c);
      }
      const idx = row.cols.findIndex(x => table
        ? x.lineage && lc(x.lineage.table.name) === lc(table) && lc(x.lineage.name) === lc(name)
        : lc(x.name) === lc(name));
      if (idx >= 0) return (row.kind === 'scan' || row.kind === 'virtual') && row.cols[idx].lineage ? ir.col(row, row.cols[idx].lineage) : ir.col(row, idx);
    }
    return null;
  }

  // [Name]: a column of the row (a renamed or added one first), else a measure.
  ref(ast, env) {
    const { table, name } = ast;
    if (table) {
      const t = env.vars.get(lc(table)) || env.queryTables.get(lc(table));
      const m = this.model.measure(name);
      if (!t && m && !this.model.findColumn(table, name)) return this.measureRef(m, env);
      const c = this.rowColumn(env, t ? null : table, name);
      if (c) return c;
      if (!t && !this.model.findColumn(table, name)) throw semantic(`the model has no column or measure '${table}'[${name}]`);
      throw semantic(`a single value for column '${table}'[${name}] cannot be determined here: there is no row context on '${table}'`);
    }
    for (let i = env.rows.length - 1; i >= 0; i--) {
      const row = env.rows[i];
      const idx = row.cols.findIndex(x => lc(x.name) === lc(name) && (!x.lineage || lc(x.lineage.name) !== lc(name)));
      if (idx >= 0) return ir.col(row, idx);
    }
    const m = this.model.measure(name);
    if (m) return this.measureRef(m, env);
    const c = this.rowColumn(env, null, name);
    if (c) return c;
    throw semantic(`there is no column or measure [${name}] here`);
  }

  measureRef(m, env) {
    if (env.stack.includes(m)) throw semantic(`measure [${m.name}] refers to itself`);
    m.ast ??= parse(m.text, `measure [${m.name}]`);
    const ctx = this.transition(env);
    return this.scalar(m.ast, { ...env, ctx, rows: [], vars: m.query ? (env.queryVarsTop ?? new Map()) : new Map(), stack: [...env.stack, m] });
  }

  // Context transition: each row context becomes filters on its columns.
  transition(env, ctx = env.ctx) {
    for (const row of env.rows) ctx = this.transitionRow(ctx, row);
    return ctx;
  }
  transitionRow(ctx, row) {
    if (row.kind === 'scan' && row.base) {
      // A row of a model table: its key says which row, when it has one; the filters on the
      // table's other columns give way.
      const t = row.base;
      ctx = ctx.remove(c => c.table === t);
      const keys = t.key ? [t.key] : t.columns.filter(c => !c.expr);
      for (const k of keys) ctx = ctx.add({ kind: 'bind', cols: [k], val: ir.col(row, k) });
      return ctx;
    }
    row.open = false;
    row.cols.forEach((c, i) => {
      if (!c.lineage) return;
      ctx = ctx.remove(x => x === c.lineage).add({ kind: 'bind', cols: [c.lineage], val: ir.col(row, row.kind === 'virtual' ? c.lineage : i) });
    });
    return ctx;
  }

  // --- scalars ---------------------------------------------------------------------------

  scalar(ast, env) {
    switch (ast.k) {
      case 'num': return ir.lit(Number(ast.v), /[.eE]/.test(ast.v) ? 'double' : 'int');
      case 'str': return ir.lit(ast.v, 'string');
      case 'bool': return ir.lit(ast.v, 'bool');
      case 'date': return dateLit(ast.v);
      case 'col': return this.ref(ast, env);
      case 'name': {
        const v = env.vars.get(lc(ast.name));
        if (v) return this.varValue(v, ast.name);
        if (this.isTable(ast, env)) return this.single(this.table(ast, env));
        throw semantic(`there is no variable ${ast.name}`);
      }
      case 'var': return this.scalar(ast.body, this.withVars(ast.defs, env));
      case 'neg': return ir.op('neg', this.scalar(ast.e, env));
      case 'not': return ir.op('not', this.scalar(ast.e, env));
      case 'bin': {
        const o = BINOPS[ast.op];
        const l = this.scalar(ast.l, env);
        // && and || on a constant do not look at the other side.
        if (o === 'and' && l.k === 'lit' && l.v === false) return ir.FALSE;
        if (o === 'or' && l.k === 'lit' && l.v === true) return ir.TRUE;
        return ir.op(o, l, this.scalar(ast.r, env));
      }
      case 'in': return this.inOp(ast, env);
      case 'call': return this.call(ast, env);
      case 'table': return this.single(this.table(ast, env));
      case 'empty': return ir.BLANK;
      case 'row': throw semantic('a row (a, b) is only valid left of IN');
    }
    throw semantic(`unexpected ${ast.k}`);
  }

  call(ast, env) {
    const f = SCALAR.get(ast.fn);
    if (f) return f(this, ast.args, env, ast);
    if (TABLE.has(ast.fn)) return this.single(this.table(ast, env));
    if (MODIFIERS.has(ast.fn)) throw semantic(`${ast.fn} can only be a filter argument of CALCULATE or CALCULATETABLE`);
    throw unsupported(`function ${ast.fn}`);
  }

  // A table where a value is expected: its one value (blank when it has no row).
  single(t) {
    if (t.cols.length !== 1) throw semantic(`a table of ${t.cols.length} columns cannot be a value`);
    const row = ir.rowOf(t);
    return ir.agg('single', t, row, ir.col(row, row.kind === 'scan' && t.cols[0].lineage ? t.cols[0].lineage : 0), t.cols[0].t);
  }

  inOp(ast, env) {
    const left = ast.e.k === 'row' ? ast.e.items.map(x => this.scalar(x, env)) : [this.scalar(ast.e, env)];
    if (ast.set.k === 'table' && ast.set.rows.every(r => r.length === left.length)) {
      // x IN { 1, 2 }: compared with ==, so a blank matches only a blank.
      const rows = ast.set.rows.map(r => r.map(x => this.scalar(x, env)));
      if (left.length === 1) return ir.op('in', left[0], ...rows.map(r => r[0]));
      return rows.map(r => r.map((v, i) => ir.op('eqs', left[i], v)).reduce((a, b) => ir.op('and', a, b)))
        .reduce((a, b) => ir.op('or', a, b));
    }
    const t = this.table(ast.set, env);
    if (t.cols.length !== left.length) throw semantic(`IN compares ${left.length} value(s) with a table of ${t.cols.length} column(s)`);
    return { k: 'insub', e: left, src: t, t: 'bool', nn: true };
  }

  withVars(defs, env) {
    const vars = new Map(env.vars);
    let e = { ...env, vars };
    for (const d of defs) {
      vars.set(lc(d.name), { ast: d.e, env: { ...e, vars: new Map(vars) } });
    }
    return e;
  }

  // A variable is compiled the first time it is named, where it was defined.
  varValue(v, name) {
    if (this.isTable(v.ast, v.env)) {
      const t = this.varTable(v);
      return this.single(t);
    }
    if (!v.scalar) {
      if (v.busy) throw semantic(`variable ${name} refers to itself`);
      v.busy = true;
      try { v.scalar = this.scalar(v.ast, v.env); } finally { v.busy = false; }
      if (ir.heavy(v.scalar)) v.scalar = { ...v.scalar, shared: true };
    }
    return v.scalar;
  }
  varTable(v) {
    if (!v.table) {
      const t = this.table(v.ast, v.env);
      // A scan, or a value as a table, is cheap to write where it is used; anything else is
      // written once when nothing outside it varies.
      v.table = t.k === 'scan' || t.k === 'onerow' || t.k === 'prefix' ? t : { k: 'shared', src: t, cols: t.cols, base: t.base };
    }
    return v.table;
  }

  // --- tables ----------------------------------------------------------------------------

  table(ast, env) {
    switch (ast.k) {
      case 'name': {
        const v = env.vars.get(lc(ast.name));
        if (v) {
          if (!this.isTable(v.ast, v.env)) throw semantic(`variable ${ast.name} is a value, not a table`);
          return this.varTable(v);
        }
        const qt = env.queryTables.get(lc(ast.name));
        if (qt) return this.varTable(qt);
        return this.scan(this.model.table(ast.name), env.ctx);
      }
      case 'var': return this.table(ast.body, this.withVars(ast.defs, env));
      case 'call': {
        const f = TABLE.get(ast.fn);
        if (!f) {
          if (SCALAR.has(ast.fn)) throw semantic(`${ast.fn} returns a value, not a table`);
          if (MODIFIERS.has(ast.fn)) throw semantic(`${ast.fn} can only be a filter argument of CALCULATE`);
          throw unsupported(`function ${ast.fn}`);
        }
        return f(this, ast.args, env, ast);
      }
      case 'table': {
        // { 1, 2 } is a column "Value"; { (1, "a") } columns Value1, Value2.
        const rows = ast.rows.map(r => r.map(x => this.scalar(x, env)));
        const n = rows[0]?.length ?? 1;
        if (rows.some(r => r.length !== n)) throw semantic('the rows of a table constructor have different lengths');
        const names = n === 1 ? ['Value'] : Array.from({ length: n }, (_, i) => `Value${i + 1}`);
        return rowsTable(names, rows);
      }
      case 'col': throw semantic(`'${ast.table ?? ''}'[${ast.name}] is a column; a table is expected (VALUES(${ast.table ?? ''}[${ast.name}])?)`);
    }
    throw semantic(`a ${ast.k} is not a table`);
  }

  scan(table, ctx) { return ir.scan(table, ctx); }

  // A column argument (SUM(T[c]), VALUES(T[c])): the model column.
  modelColumn(ast, env, what = 'a column') {
    if (ast.k !== 'col' || !ast.table) {
      if (ast.k === 'col') {
        // [c] in a row context of a model table, or a column with that name in one table.
        const c = this.rowColumn(env, null, ast.name);
        if (c && typeof c.ref === 'object') return c.ref;
      }
      throw semantic(`${what} like Table[Column] is expected`);
    }
    const v = env.vars.get(lc(ast.table));
    if (v) throw unsupported(`a column of table variable ${ast.table} here`);
    return this.model.column(ast.table, ast.name);
  }

  // --- CALCULATE -------------------------------------------------------------------------

  // The filter context CALCULATE(_, args) evaluates its expression in.
  calculateCtx(args, env) {
    // 1. The filter arguments, in the context outside.
    const actions = args.filter(a => a.k !== 'empty').flatMap(a => this.filterArg(a, env, false));
    // 2. Context transition.
    let ctx = this.transition(env);
    // 3. The modifiers: relationships first, then what is removed.
    for (const a of actions) if (a.kind === 'mods') ctx = ctx.withMods(a.change);
    for (const a of actions) {
      if (a.kind === 'remove') ctx = a.all ? ctx.removeAll() : ctx.remove(a.drop(ctx));
      else if (a.kind === 'selected') ctx = this.allSelected(ctx, env, a.cols);
    }
    // 4. The filters: each replaces what the context says about its columns, unless kept.
    const filters = actions.filter(a => a.kind === 'filter');
    const replaced = new Set();
    for (const { filter: f, keep } of filters) {
      if (keep) continue;
      for (const c of f.cols) {
        replaced.add(c);
        // A filter on a date table's date removes the filters on the rest of that table.
        if (isDateKey(this.model, c)) for (const x of c.table.columns) replaced.add(x);
      }
    }
    if (replaced.size) ctx = ctx.remove(c => replaced.has(c));
    for (const { filter: f } of filters) ctx = ctx.add(f);
    return ctx;
  }

  // One filter argument -> actions: { kind:'filter', filter, keep } | { kind:'remove', drop } |
  // { kind:'mods', change } | { kind:'selected', cols }.
  filterArg(ast, env, keep) {
    if (ast.k === 'call') {
      if (ast.fn === 'KEEPFILTERS') return this.filterArg(ast.args[0], env, true);
      const m = MODIFIERS.get(ast.fn);
      if (m) return [m(this, ast.args, env)];
    }
    if (this.isTable(ast, env)) {
      const f = this.tableFilter(this.table(ast, env), env.ctx);
      return [f].flat().filter(Boolean).map(filter => ({ kind: 'filter', filter, keep }));
    }
    return [{ kind: 'filter', filter: this.boolFilter(ast, env), keep }];
  }

  // A table as a filter: on the columns it has lineage for. Rows of a model table filter its
  // expanded table.
  tableFilter(t, ctx) {
    // A row of values is those values: binds, each guarded by its condition.
    if (t.k === 'onerow') return t.cols.map((c, i) => c.lineage && { kind: 'bind', cols: [c.lineage], val: t.vals[i], guard: t.cond }).filter(Boolean);
    // Values before a table: those values, and the table on its own columns.
    if (t.k === 'prefix') {
      const binds = t.vals.map((v, i) => ({ kind: 'bind', cols: [t.cols[i].lineage], val: v, guard: t.cond }));
      return [...binds, this.tableFilter(t.src, ctx)].flat().filter(Boolean);
    }
    if (t.base) {
      const tables = this.model.expand(t.base, this.model.state(ctx.mods));
      const cols = [...tables.keys()].flatMap(n => this.model.table(n).columns);
      return { kind: 'rel', cols, src: t, idx: null, base: t.base };
    }
    const cols = [], idx = [];
    t.cols.forEach((c, i) => {
      if (c.lineage && !cols.includes(c.lineage)) { cols.push(c.lineage); idx.push(i); }
    });
    if (!cols.length) return null;
    return { kind: 'rel', cols, src: t, idx, base: null };
  }

  // A boolean filter, T[c] > 5: FILTER(ALL(T[c]), T[c] > 5), the predicate read on the
  // values of the columns it names.
  boolFilter(ast, env) {
    const cols = [];
    collectColumns(ast, this.model, cols);
    const tables = new Set(cols.map(c => c.table));
    if (tables.size > 1) throw semantic(`a CALCULATE filter can name the columns of one table only (${[...tables].map(t => `'${t.name}'`).join(', ')})`);
    const row = ir.newRow(cols.map(c => ({ name: c.name, lineage: c, t: c.type })), 'virtual', { open: true });
    const pred = this.scalar(ast, { ...env, rows: [...env.rows, row] });
    row.open = false;
    if (!row.cols.length) throw semantic('a CALCULATE filter has to name a column');
    return { kind: 'pred', cols: row.cols.map(c => c.lineage), row, pred };
  }

  allSelected(ctx, env, cols) {
    const shadow = env.shadow ?? EMPTY_CTX;
    if (!cols) return new Ctx(shadow.filters, ctx.mods);
    const hit = c => cols.has(c);
    ctx = ctx.remove(hit);
    for (const f of shadow.filters) if (f.cols.some(hit)) ctx = ctx.add(f);
    return ctx;
  }

  // The columns a table name covers, for ALL(T): its expanded table.
  expandedColumns(table, ctx) {
    const tables = this.model.expand(table, this.model.state(ctx.mods));
    return new Set([...tables.keys()].flatMap(n => this.model.table(n).columns));
  }
}

const BINOPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow', '&': 'concat', '=': 'eq', '==': 'eqs',
  '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '&&': 'and', '||': 'or' };

function parse(text, what) {
  try { return parseExpression(text); } catch (e) {
    if (e instanceof DaxError) e.message = `${what}: ${e.message}`;
    throw e;
  }
}

// The model columns an expression names directly (not inside an aggregate or an iterator):
// the columns of a boolean filter.
const OPAQUE = new Set(['CALCULATE', 'CALCULATETABLE', 'FILTER', 'SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'COUNTX', 'COUNTAX',
  'CONCATENATEX', 'PRODUCTX', 'MEDIANX', 'RANKX', 'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTROWS',
  'DISTINCTCOUNT', 'DISTINCTCOUNTNOBLANK', 'COUNTBLANK', 'VALUES', 'DISTINCT', 'ALL', 'SELECTEDVALUE', 'HASONEVALUE',
  'ISFILTERED', 'ISCROSSFILTERED', 'ISINSCOPE', 'LOOKUPVALUE', 'RELATED', 'EARLIER', 'EARLIEST', 'TOPN', 'MEDIAN',
  'PRODUCT', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'STDEVX.S', 'STDEVX.P', 'VARX.S', 'VARX.P', 'PERCENTILE.INC',
  'PERCENTILE.EXC', 'PERCENTILEX.INC', 'PERCENTILEX.EXC', 'FIRSTNONBLANK', 'LASTNONBLANK', 'CONTAINS', 'ISEMPTY']);
function collectColumns(ast, model, out) {
  if (!ast || typeof ast !== 'object') return;
  if (ast.k === 'col' && ast.table) {
    const c = model.findColumn(ast.table, ast.name);
    if (c && !out.includes(c)) out.push(c);
    return;
  }
  if (ast.k === 'call' && (OPAQUE.has(ast.fn) || TABLE.has(ast.fn))) return;
  for (const x of [ast.e, ast.l, ast.r, ast.body, ...(ast.args ?? []), ...(ast.items ?? [])]) collectColumns(x, model, out);
  if (ast.k === 'var') ast.defs.forEach(d => collectColumns(d.e, model, out));
}
