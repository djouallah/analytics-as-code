// DAX tree -> intermediate form (ir.js), with DAX's evaluation rules.
//
// The compiler walks an expression with an environment `env`:
//   ctx      the filter context (context.js)
//   rows     the row contexts, outermost first: RowRefs of the tables being iterated
//   vars     variables in scope: name -> { ast, env, scalar?, table? }, compiled when used
//   grouped  the columns SUMMARIZECOLUMNS groups by here (ISINSCOPE)
//   shadows  the shadow filter contexts, innermost last: each iterator's (and SUMMARIZECOLUMNS')
//            columns with the values it iterates them over, which ALLSELECTED restores
//   stack    the measures being expanded (a measure cannot name itself)
//   cg       inside a calculation item: { measure, applied } (SELECTEDMEASURE)
//   cgApplied  the calculation items already applied to the measure being expanded
// What DAX does at run time, the compiler does with these at compile time: CALCULATE builds a
// new ctx (its filter arguments evaluated in the outer one, then context transition, then
// ALL and the other modifiers, then the filters, each replacing what the context said about
// its columns unless it is KEEPFILTERS); a measure is its expression under CALCULATE; an
// aggregate is a scan of its table under the ctx of where it stands.
import { parseExpression, parseQuery } from './parser.js';
import { DaxError, semantic, unsupported } from './errors.js';
import { Ctx, EMPTY_CTX, narrow } from './context.js';
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
      // START AT: constants (or parameters), one per ORDER BY column from the first.
      const start = ev.start.map(v => {
        const x = c.scalar(v, env0);
        if (x.k !== 'lit') throw semantic('START AT takes constants or parameters');
        return x;
      });
      return { table, row, order, start };
    });
  }

  // One expression (a measure, say) in an empty filter context.
  expression(src, { table: asTable = false } = {}) {
    const ast = typeof src === 'string' ? parseExpression(src) : src;
    return asTable ? this.table(ast, this.env()) : this.scalar(ast, this.env());
  }

  env(o = {}) {
    return { ctx: EMPTY_CTX, rows: [], vars: new Map(), grouped: new Set(), shadows: [], stack: [], queryTables: new Map(), ...o };
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

  // [Measure]: its expression under CALCULATE, through the calculation groups the filter
  // context selects an item of.
  measureRef(m, env) {
    if (env.stack.includes(m)) throw semantic(`measure [${m.name}] refers to itself`);
    const ctx = this.transition(env);
    return this.applyGroups(m, { ...env, ctx, rows: [], cg: null }, 0);
  }
  measureBody(m, env) {
    m.ast ??= parse(m.text, `measure [${m.name}]`);
    return this.scalar(m.ast, { ...env, cg: null, vars: m.query ? (env.queryVarsTop ?? new Map()) : new Map(), stack: [...env.stack, m] });
  }

  // --- calculation groups --------------------------------------------------------------
  // The groups apply from the highest precedence: the item a group's filter selects replaces
  // the measure, SELECTEDMEASURE() in it being the measure with the groups after it applied.
  // An item applied once is not applied again in the same expansion (SELECTEDMEASURE() under
  // the same selection is the measure); another item of the same group is (sideways
  // recursion). A selection known at compile time keeps one item; one that varies (a group
  // by the group's column) is a CASE on SELECTEDVALUE of it.
  applyGroups(m, env, from) {
    const groups = this.model.calcGroups;
    for (let i = from; i < groups.length; i++) {
      const r = this.applyGroup(m, env, groups[i], i);
      if (r) return r;
    }
    return this.measureBody(m, env);
  }

  applyGroup(m, env, g, i) {
    const applied = env.cgApplied ?? new Set();
    const next = () => this.applyGroups(m, env, i + 1);
    const item = it => (applied.has(it) ? next() : this.applyItem(m, env, it, applied));
    // The group's expression for no selection, or for several (or none) selected: parsed once.
    const special = (text, key) => {
      const it = (g.special ??= {})[key] ??= { name: key, text, ast: null };
      return applied.has(it) ? next() : this.applyItem(m, env, it, applied);
    };
    const sel = this.selection(g, env);
    if (sel.kind === 'none') return g.noSelection ? special(g.noSelection, `${g.table.name}:none`) : null;
    if (!sel.dynamic) {
      if (sel.items.length === 1) return item(sel.items[0]);
      return g.multipleOrEmpty ? special(g.multipleOrEmpty, `${g.table.name}:multiple`) : null;
    }
    const src = this.scan(g.table, env.ctx), row = ir.rowOf(src), value = ir.col(row, g.column);
    const name = ir.kase([[ir.agg('hasone', src, row, value, 'bool'), ir.agg('min', src, row, value, 'string')]], ir.BLANK, 'string');
    // In the branch of an item, the selection is that item while the filters on the group
    // stay the same ones.
    const own = groupFilters(g, env.ctx);
    const w = sel.items.map(it => {
      const known = new Map(env.cgKnown ?? []).set(g, { item: it, filters: own });
      return [ir.op('eqs', name, ir.lit(it.name, 'string')), this.withKnown(env, known, () => item(it))];
    });
    return ir.kase(w, g.multipleOrEmpty ? special(g.multipleOrEmpty, `${g.table.name}:multiple`) : next());
  }

  // Compiles `f` with the selections known in a branch (env.cgKnown), passed on through the
  // environments made under it.
  withKnown(env, known, f) {
    const was = this._known;
    this._known = known;
    try { return f(); } finally { this._known = was; }
  }

  // The item applied: in its expression, a measure it names directly is not given the same
  // item again (DAX ignores the second application), only the items not yet applied.
  applyItem(m, env, it, applied) {
    it.ast ??= parse(it.text, `calculation item ${it.name}`);
    const now = new Set([...applied, it]);
    return this.scalar(it.ast, { ...env, vars: new Map(), cg: { measure: m, applied: now }, cgApplied: now });
  }

  // What the filter context selects of a calculation group: { kind: 'none' } when nothing
  // filters it, else { items, dynamic }: the items the filters known at compile time allow,
  // and whether some filter is only known at run time.
  selection(g, env) {
    const filters = groupFilters(g, env.ctx);
    if (!filters.length) return { kind: 'none' };
    const known = this._known?.get(g);
    if (known && known.filters.length === filters.length && known.filters.every((f, i) => f === filters[i]))
      return { kind: 'items', items: [known.item], dynamic: false };
    let items = g.items, dynamic = false;
    for (const f of filters) {
      const r = this.filterItems(g, f, items);
      items = r.items;
      if (r.dynamic) dynamic = true;
    }
    return { kind: 'items', items, dynamic };
  }

  // What one filter on a group's columns keeps of `items`: { items, dynamic }, dynamic when
  // which of them it keeps is only known at run time (items is then those it may keep: a
  // row of the group's own rows or of a table of constants, say, so that the CASE has a
  // branch for those only).
  filterItems(g, f, items) {
    const value = itemValue(g);
    const within = (r, dynamic) => (r ? { items: items.filter(it => r.items.includes(it)), dynamic: dynamic || !r.exact } : { items, dynamic: true });
    if (f.kind === 'bind') {
      if (f.val.k === 'lit' && !f.guard) return { items: items.filter(it => sameValue(value(it, f.cols[0]), f.val.v)), dynamic: false };
      // A row of a table (an iteration, a context transition): the items that table holds.
      const v = f.val;
      const r = v.k === 'col' && v.row.src ? this.itemsOfTable(g, v.row.src, colIndex(v), f.cols[0]) : null;
      return within(r, !(r && r.exact && r.items.length === 1));
    }
    if (f.kind === 'pred') {
      try {
        return { items: items.filter(it => constValue(f.pred, x => (x.row === f.row ? value(it, colOf(x)) : DYNAMIC)) === true), dynamic: false };
      } catch (e) { if (e !== DYNAMIC) throw e; }
      // T[c] = a column of another row: the values that row's table holds.
      const p = f.pred;
      if (p.k === 'op' && (p.op === 'eq' || p.op === 'eqs')) {
        const [a, b] = p.a[0].k === 'col' && p.a[0].row === f.row ? p.a : [p.a[1], p.a[0]];
        if (a.k === 'col' && a.row === f.row && b.k === 'col' && b.row !== f.row && b.row.src) {
          const r = this.itemsOfTable(g, b.row.src, colIndex(b), colOf(a));
          return within(r, !(r && r.exact && r.items.length === 1));
        }
      }
      return { items, dynamic: true };
    }
    // A table: the items its rows can hold, on each of the group's columns it names.
    let r = { items: g.items, exact: true }, seen = 0;
    for (let j = 0; j < f.cols.length; j++) {
      const c = f.cols[j];
      if (c !== g.column && c !== g.ordinal) continue;
      const i = f.idx ? f.idx[j] : f.src.cols.findIndex(x => x.lineage === c);
      const t = i >= 0 ? this.itemsOfTable(g, f.src, i, c) : null;
      if (!t) return { items, dynamic: true };
      r = { items: r.items.filter(it => t.items.includes(it)), exact: r.exact && t.exact && ++seen === 1 };
    }
    return within(r, false);
  }

  // The items of group g the rows of table `src` stand for, its column i holding the group's
  // column `col` (the name or the ordinal): { items, exact } (exact: those, not a few more),
  // or null when the compiler cannot tell.
  itemsOfTable(g, src, i, col) {
    const value = itemValue(g);
    const sctx = valuesCtx(src);
    if (sctx && src.cols[i]?.lineage === col) {
      const sel = this.selection(g, { ctx: sctx });
      return sel.kind === 'none' ? { items: g.items, exact: true } : { items: sel.items, exact: !sel.dynamic };
    }
    switch (src.k) {
      case 'distinct': case 'shared': return this.itemsOfTable(g, src.src, i, col);
      case 'project': {
        if (src.keep && i < src.src.cols.length) return this.itemsOfTable(g, src.src, i, col);
        const e = src.items[src.keep ? i - src.src.cols.length : i]?.expr;
        return e?.k === 'col' && e.row === src.row ? this.itemsOfTable(g, src.src, colIndex(e), col) : null;
      }
      case 'filter': {
        const inner = this.itemsOfTable(g, src.src, i, col) ?? { items: g.items, exact: false };
        let exact = inner.exact;
        const items = inner.items.filter(it => {
          try { return constValue(src.pred, x => (x.row === src.row && colIndex(x) === i ? value(it, col) : DYNAMIC)) === true; } catch (e) {
            if (e !== DYNAMIC) throw e;
            exact = false;
            return true;
          }
        });
        return { items, exact };
      }
      case 'rows':
        if (!src.rows.every(r => r[i]?.k === 'lit')) return null;
        return { items: g.items.filter(it => src.rows.some(r => sameValue(value(it, col), r[i].v))), exact: true };
      case 'onerow':
        if (src.vals[i]?.k !== 'lit') return null;
        return { items: g.items.filter(it => sameValue(value(it, col), src.vals[i].v)), exact: src.cond.k === 'lit' && src.cond.v === true };
      case 'union': {
        const parts = src.srcs.map(s => this.itemsOfTable(g, s, i, col));
        if (parts.some(p => !p)) return null;
        return { items: g.items.filter(it => parts.some(p => p.items.includes(it))), exact: parts.every(p => p.exact) };
      }
    }
    return null;
  }

  // SELECTEDMEASURE(): the measure, as a measure reference (context transition), with the
  // groups applied that are not yet.
  selectedMeasure(env) {
    if (!env.cg) throw semantic('SELECTEDMEASURE() is only valid in a calculation item');
    const ctx = this.transition(env);
    return this.applyGroups(env.cg.measure, { ...env, ctx, rows: [], cg: null, cgApplied: env.cg.applied }, 0);
  }

  // A query parameter (@name), from options.params.
  param(name) {
    const params = this.options.params ?? {};
    const key = Object.keys(params).find(k => lc(k) === lc(name));
    if (key === undefined) throw semantic(`the query parameter @${name} has no value (options.params)`);
    const v = params[key];
    if (v === null || v === undefined) return ir.BLANK;
    if (v instanceof Date) return dateLit(v.toISOString().slice(0, 19).replace('T', ' ').replace(' 00:00:00', ''));
    if (typeof v === 'number') return ir.lit(v, Number.isInteger(v) ? 'int' : 'double');
    if (typeof v === 'boolean') return ir.lit(v, 'bool');
    return ir.lit(String(v), 'string');
  }

  // An iterator's row context. The iteration is also a shadow filter context on the columns it
  // iterates (those with a lineage): their values as iterated, what ALLSELECTED restores.
  iter(env, row) {
    const cols = new Set(row.cols.map(c => c.lineage).filter(Boolean));
    const shadows = cols.size && row.src ? [...env.shadows, { cols, src: row.src, ctx: env.ctx }] : env.shadows;
    return { ...env, rows: [...env.rows, row], shadows };
  }

  // Whether a table can have DAX's blank row: it is the one side of a relationship whose many
  // side may hold keys it lacks.
  blankRowRels(table) {
    if (this.options.blankRows === false || this.options.assumeIntegrity) return [];
    return this.model.relationships.filter(r => r.to.table === table && r.fromCard === 'many' && r.toCard === 'one' && !r.ri);
  }

  // Context transition: each row context becomes filters on its columns.
  transition(env, ctx = env.ctx) {
    for (const row of env.rows) ctx = this.transitionRow(ctx, row);
    return ctx;
  }
  transitionRow(ctx, row) {
    if (row.kind === 'scan' && row.base) {
      // A row of a model table: a filter on each of its columns, replacing the table's. With a
      // key, the key's says which row on its own; the others are `implied` by it, written only
      // when something removes the key's (ALLEXCEPT, REMOVEFILTERS of the key).
      const t = row.base;
      ctx = ctx.remove(c => c.table === t);
      const cols = t.columns.filter(c => !c.expr);
      const key = t.key && !t.key.expr ? { kind: 'bind', cols: [t.key], val: ir.col(row, t.key) } : null;
      if (key) ctx = ctx.add(key);
      for (const c of cols) if (!key || c !== t.key) ctx = ctx.add({ kind: 'bind', cols: [c], val: ir.col(row, c), implied: key });
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
      case 'param': return this.param(ast.name);
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
      else if (a.kind === 'selected') ctx = this.allSelected(ctx, env, a.cols, a.clear);
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

  // ALLSELECTED (SQLBI's "definitive guide"): each of the columns `target` (null: every column
  // some shadow filter context covers) takes the filter of the last shadow that covers it in
  // place of its own. A column no shadow covers keeps its filters, or with `clear` (ALLSELECTED
  // of columns) loses them: all its values.
  allSelected(ctx, env, target = null, clear = false) {
    const shadows = env.shadows ?? [];
    const cols = target ? [...target] : [...new Set(shadows.flatMap(s => [...s.cols]))];
    const by = new Map(), drop = new Set();
    for (const c of cols) {
      let s = null;
      for (let i = shadows.length - 1; i >= 0 && !s; i--) if (shadows[i].cols.has(c)) s = shadows[i];
      if (s) {
        if (!by.has(s)) by.set(s, new Set());
        by.get(s).add(c);
        drop.add(c);
      } else if (clear) drop.add(c);
    }
    if (drop.size) ctx = ctx.remove(c => drop.has(c));
    for (const [s, on] of by) ctx = this.shadowFilter(ctx, s, on);
    return ctx;
  }

  // What a shadow filter context puts back on its columns `on`.
  shadowFilter(ctx, s, on) {
    const sctx = s.src ? valuesCtx(s.src) : s.ctx;
    if (!sctx) {
      // Rows iterated that are not some columns' values: those rows, on the columns.
      for (const f of [this.tableFilter(s.src, s.ctx)].flat().filter(Boolean)) {
        const keep = f.cols.filter(c => on.has(c));
        if (keep.length) ctx = ctx.add(keep.length === f.cols.length ? f : narrow(f, keep));
      }
      return ctx;
    }
    // The values the filter context sctx leaves the columns. When the filters of sctx the
    // context lacks are all on those columns, putting them back is the same; otherwise the
    // values are a table.
    const missing = sctx.filters.filter(f => !ctx.filters.includes(f));
    if (missing.every(f => f.cols.every(c => on.has(c)))) return missing.reduce((x, f) => x.add(f), ctx);
    const byTable = new Map();
    for (const c of on) {
      if (!byTable.has(c.table)) byTable.set(c.table, []);
      byTable.get(c.table).push(c);
    }
    for (const [t, cs] of byTable) {
      const src = ir.values(t, sctx, cs, (tb, x) => this.scan(tb, x), this.blankRowRels(t).length > 0);
      ctx = ctx.add({ kind: 'rel', cols: cs, src, idx: cs.map((_, i) => i), base: null });
    }
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

// The filter context a table is some columns' values in (VALUES, ALL, DISTINCT, a model
// table's rows, with columns added or not), or null.
function valuesCtx(x) {
  for (;;) {
    if (x.k === 'distinct' || x.k === 'withblank' || x.k === 'shared') x = x.src;
    else if (x.k === 'project' && (x.keep || x.items.every(i => i.expr.k === 'col' && i.expr.row === x.row))) x = x.src;
    else break;
  }
  return x.k === 'scan' ? x.ctx : null;
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

const DYNAMIC = Symbol('dynamic');
// An item's value in one of its group's columns.
const itemValue = g => (it, c) => (c === g.column ? it.name : c === g.ordinal ? it.ordinal : DYNAMIC);
// The model column (or the position) a column reference names, and its position in its row.
const colOf = x => (typeof x.ref === 'number' ? x.row.cols[x.ref].lineage ?? x.ref : x.ref);
const colIndex = x => (typeof x.ref === 'number' ? x.ref : x.row.cols.findIndex(c => c.lineage === x.ref));
// The filters on a calculation group's columns.
const groupFilters = (g, ctx) => ctx.filters.filter(f => f.cols.some(c => c.table === g.table));
// DAX's =: text without regard to case.
const sameValue = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The value of an expression of constants (and of `col`, which gives a column's value), or
// DYNAMIC (thrown) when it is not one this can work out.
function constValue(x, col) {
  const v = y => constValue(y, col);
  switch (x.k) {
    case 'lit': return x.v;
    case 'col': { const r = col(x); if (r === DYNAMIC) throw DYNAMIC; return r; }
    case 'op': {
      const a = x.a.map(v);
      switch (x.op) {
        case 'eq': case 'eqs': return sameValue(a[0], a[1]);
        case 'ne': return !sameValue(a[0], a[1]);
        case 'lt': return a[0] < a[1];
        case 'le': return a[0] <= a[1];
        case 'gt': return a[0] > a[1];
        case 'ge': return a[0] >= a[1];
        case 'and': return !!a[0] && !!a[1];
        case 'or': return !!a[0] || !!a[1];
        case 'not': return !a[0];
        case 'bool': return !!a[0];
        case 'in': return a.slice(1).some(y => sameValue(a[0], y));
        case 'concat': return `${a[0] ?? ''}${a[1] ?? ''}`;
      }
      throw DYNAMIC;
    }
    case 'fn':
      if (x.name === 'isblank') return v(x.a[0]) === null;
      if (x.name === 'upper') return String(v(x.a[0]) ?? '').toUpperCase();
      if (x.name === 'lower') return String(v(x.a[0]) ?? '').toLowerCase();
      throw DYNAMIC;
    case 'case': {
      for (const [c, r] of x.w) if (v(c) === true) return v(r);
      return v(x.e);
    }
  }
  throw DYNAMIC;
}
