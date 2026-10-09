// Intermediate form -> SQL.
//
// A table becomes a Block: one SELECT being built (FROM, joins, WHERE, GROUP BY, ...) and a
// resolver that writes a column of its input row. Iterators extend the block of their table
// when they can (FILTER over a scan is a WHERE) and wrap it in a subquery when they cannot.
// An aggregate is a scalar subquery over its table's block, correlated to the rows it reads
// (DuckDB decorrelates them), except where it can be fused: aggregates of SUMMARIZECOLUMNS
// (and ROW) over the same model table under the same filters, up to the group's keys, are
// one GROUP BY in a CTE, joined to the groups.
//
// A scan's WHERE is the filter context applied to that table: every filter on a column of
// its expanded table (joined from the scan's table through the relationships, or read off
// the foreign key when the relationship relies on referential integrity), and the filters
// that reach it over bidirectional or many-to-many relationships, as semi-joins.
import * as ir from './ir.js';
import { Ctx, narrow, EMPTY_CTX as EMPTY } from './context.js';
import { semantic } from './errors.js';

const lc = s => String(s).toLowerCase();

export class Emitter {
  constructor(model, dialect, options = {}) {
    this.model = model;
    this.d = dialect;
    this.options = options;
    this.n = 0;
    this.ctes = [];
    this.memo = new Map();        // shared IR -> CTE name
    this.fusions = [];            // stack: the Fusion aggregates go to, or null
    this.fusedIn = new WeakMap(); // agg node -> fused group
  }

  alias(p) { return `${p}${++this.n}`; }
  ident(n) { return this.d.ident(n); }

  // --- the query -------------------------------------------------------------------------

  query({ table, row, order, start = [] }) {
    const b = this.table(table, new Map());
    const inner = b.render(), names = b.names();
    const r = this.alias('q');
    const style = this.options.columnNames ?? 'short';
    const outNames = outputNames(table.cols, style);
    const cast = this.options.castOutput !== false, by = typeof this.options.castOutput === 'object' ? this.options.castOutput : null;
    const sel = table.cols.map((c, i) => {
      let s = `${r}.${this.ident(names[i])}`;
      if (by) { if (by[c.t]) s = by[c.t](s); }
      else if (cast && (c.t === 'int' || c.t === 'double' || c.t === 'decimal')) s = this.d.cast(s, c.t === 'int' ? 'int' : 'double');
      return `${s} AS ${this.ident(outNames[i])}`;
    });
    let sql = `SELECT ${sel.join(', ')} FROM (${inner}) AS ${r}`;
    if (order.length) {
      const res = new WrapRes(this, null, names.map((n, i) => ({ sql: `${r}.${this.ident(n)}`, lineage: table.cols[i].lineage })), this.model.state(null));
      const scope = new Map([[row.id, res]]);
      const keys = order.map(o => this.scalar(o.expr, scope));
      if (start.length) sql += ` WHERE ${this.startAt(keys, order, start.map(v => this.scalar(v, scope)), start)}`;
      sql += ` ORDER BY ${keys.map((k, i) => `${k} ${order[i].desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`).join(', ')}`;
    }
    if (this.ctes.length) sql = `WITH ${this.ctes.join(',\n')}\n${sql}`;
    return {
      sql,
      columns: table.cols.map((c, i) => ({ name: outNames[i], dax: daxName(c), type: c.t, lineage: c.lineage ? `'${c.lineage.table.name}'[${c.lineage.name}]` : null })),
    };
  }

  // START AT: the rows from the first that is at or after the values, in the order (a blank
  // comes first ascending, last descending). Each value counts within the rows equal on the
  // ones before it.
  startAt(keys, order, vals, lits) {
    const after = i => {
      const k = keys[i], v = vals[i], blank = lits[i].v === null;
      if (order[i].desc) return blank ? 'FALSE' : `(${k} < ${v} OR ${k} IS NULL)`;
      return blank ? `${k} IS NOT NULL` : `${k} > ${v}`;
    };
    const same = i => this.d.isNotDistinct(keys[i], vals[i]);
    const alts = vals.map((_, i) => [...vals.slice(0, i).map((__, j) => same(j)), after(i)].join(' AND '));
    alts.push(vals.map((_, i) => same(i)).join(' AND '));
    return `(${alts.map(paren).join(' OR ')})`;
  }

  // --- tables ----------------------------------------------------------------------------

  table(x, scope) {
    switch (x.k) {
      case 'scan': return this.scanBlock(x.table, x.ctx, scope);
      case 'filter': {
        const b = this.open(this.table(x.src, scope));
        b.where.push(this.scalar(x.pred, withRow(scope, x.row, b.res), true));
        return b;
      }
      case 'project': {
        const b = this.open(this.table(x.src, scope));
        const s2 = withRow(scope, x.row, b.res);
        const kept = x.keep ? b.outList() : [];
        const items = x.items.map(i => ({ sql: this.scalar(i.expr, s2) }));
        b.setOut(x.cols, [...kept.map(k => k.sql), ...items.map(i => i.sql)]);
        return b;
      }
      case 'distinct': {
        let b = this.table(x.src, scope);
        if (!b.open || b.group) b = this.wrap(b);
        b.distinct = true;
        b.open = false;
        return b;
      }
      case 'group': {
        const b = this.open(this.table(x.src, scope));
        const s2 = withRow(scope, x.row, b.res);
        const keys = x.keys.map(k => this.scalar(k.expr, s2));
        const items = x.items.map(i => this.scalar(i.expr, s2));
        b.group = keys;
        b.setOut(x.cols, [...keys, ...items]);
        b.open = false;
        return b;
      }
      case 'topn': return this.topn(x, scope);
      case 'cross': {
        const parts = x.srcs.map(s => this.wrap(this.table(s, scope)));
        return this.combine(parts, ' CROSS JOIN ', x.cols);
      }
      case 'union': {
        const parts = x.srcs.map(s => this.table(s, scope));
        return this.fromSql(`(${parts.map(p => p.render()).join(' UNION ALL ')})`, x.cols, parts[0].names());
      }
      case 'intersect': case 'except': {
        const b = this.wrap(this.table(x.srcs[0], scope));
        for (const s of x.srcs.slice(1)) {
          const r = this.table(s, scope), a = this.alias('e'), rn = r.names();
          const on = x.cols.map((_, i) => this.d.isNotDistinct(`${a}.${this.ident(rn[i])}`, b.res.col(i)));
          b.where.push(`${x.k === 'except' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM (${r.render()}) AS ${a} WHERE ${on.join(' AND ')})`);
        }
        return b;
      }
      case 'rows': return this.rowsBlock(x, scope);
      case 'series': {
        const a = this.alias('g');
        const from = `${this.d.series(this.scalar(x.start, scope), this.scalar(x.end, scope), this.scalar(x.step, scope), x.cols[0].t)} AS ${a}`;
        return this.fromSql(from, x.cols, ['v'], a);
      }
      case 'generate': {
        const l = this.wrap(this.table(x.left, scope));
        const r = this.table(x.right, withRow(scope, x.lrow, l.res));
        const a = this.alias('l'), rn = r.names();
        l.from += x.outer ? ` LEFT JOIN LATERAL (${r.render()}) AS ${a} ON TRUE` : `, LATERAL (${r.render()}) AS ${a}`;
        const cols = [...l.res.list, ...rn.map((n, i) => ({ sql: `${a}.${this.ident(n)}`, lineage: x.right.cols[i].lineage }))];
        l.res = new WrapRes(this, l, cols, l.res.state);
        l.cols = x.cols;
        l._names = null;
        return l;
      }
      case 'shared': {
        if (ir.freeRows(x.src).size) return this.table(x.src, scope);
        let name = this.memo.get(x);
        if (!name) {
          name = this.alias('v');
          const b = this.isolated(() => this.table(x.src, new Map()));
          this.ctes.push(`${name} AS ${this.d.materialized}(${b.render()})`);
          this.memo.set(x, name);
          this.memo.set(name, b.names());
        }
        const a = this.alias('s');
        return this.fromSql(`${name} AS ${a}`, x.cols, this.memo.get(name), a);
      }
      case 'sc': return this.summarizeColumns(x, scope);
      case 'window': return this.windowRows(x, scope);
      case 'withblank': {
        // VALUES, ALL: the rows, and the table's blank row when it has one.
        const b = this.table(x.src, scope), names = b.names();
        const blank = this.blankRow(x.table, x.ctx, scope, bb => {
          bb.setOut(x.cols, x.lineage.map(l => bb.res.meta(l)));
          bb._names = names;
          bb.out.forEach((o, i) => { o.name = names[i]; });
          return bb.render();
        });
        if (!blank) return b;
        return this.fromSql(`(${b.render()} UNION ${blank})`, x.cols, names);
      }
      case 'prefix': {
        const b = this.wrap(this.table(x.src, scope));
        const vals = x.vals.map(v => this.scalar(v, scope));
        b.setOut(x.cols, [...vals, ...b.outList().map(o => o.sql)]);
        if (!(x.cond.k === 'lit' && x.cond.v === true)) b.where.push(this.scalar(x.cond, scope, true));
        b.open = false;
        return b;
      }
      case 'onerow': {
        const b = new Block(this, null, x.cols);
        b.setOut(x.cols, x.vals.map(v => this.scalar(v, scope)));
        if (!(x.cond.k === 'lit' && x.cond.v === true)) b.where.push(this.scalar(x.cond, scope, true));
        b.open = false;
        return b;
      }
      case 'currentgroup': throw semantic('CURRENTGROUP() is only valid in an aggregate inside GROUPBY');
    }
    throw new Error(`emit: table ${x.k}`);
  }

  // The rows of a model table the filter context keeps.
  // `self` ([row, columns]): the row's columns are this scan's own (a group key the scan is
  // filtered to), read off its rows.
  // `from`: another source for the table's rows (its blank row).
  scanBlock(table, ctx, scope, excluded = null, self = null, from = null) {
    const a = this.alias('t');
    const b = new Block(this, `${from ?? this.source(table)} AS ${a}`, table.columns.map(c => ({ name: c.name, lineage: c, t: c.type })));
    b.res = new ScanRes(this, b, table, a, this.model.state(ctx.mods));
    b.res.blankRow = !!from;
    if (self) {
      const [row, cols] = self, res = b.res;
      scope = withRow(scope, row, { col: i => res.meta(cols[i]), meta: m => res.meta(m) });
    }
    // The same condition once: a date range on a fact and on its date table is one.
    b.where.push(...new Set([...this.conds(table, ctx, b.res, scope, excluded), ...this.securityConds(table, b.res, scope)]));
    return b;
  }

  source(table) {
    if (table.calc) return this.calcTableSource(table);
    if (table.calcGroup) return this.calcGroupSource(table);
    if (this.options.tableSource) return this.options.tableSource(table);
    const s = table.source;
    return s.schema ? `${this.ident(s.schema)}.${this.ident(s.entity)}` : this.ident(s.entity);
  }

  // A calculated table: its expression, evaluated as at refresh (no filter, no security), as
  // a CTE with the model's columns (matched to the expression's by their source names).
  calcTableSource(table) {
    let name = this.memo.get(table);
    if (name) return name;
    const x = this.options.calcTable(table);
    const b = this.unsecured(() => this.isolated(() => this.table(x, new Map())));
    const inner = b.names(), a = this.alias('c');
    const strip = s => lc(String(s).replace(/^.*\[(.*)\]$/, '$1'));
    const cols = table.columns.filter(c => !c.expr);
    const sel = cols.map((c, i) => {
      let j = x.cols.findIndex(o => lc(o.name) === strip(c.source));
      if (j < 0) j = x.cols.findIndex(o => lc(o.name) === lc(c.name));
      if (j < 0 && x.cols.length === cols.length) j = i;
      if (j < 0) throw semantic(`calculated table '${table.name}': its expression has no column ${c.source}`);
      return `${a}.${this.ident(inner[j])} AS ${this.ident(c.source)}`;
    });
    name = this.alias('ct');
    this.ctes.push(`${name} AS ${this.d.materialized}(SELECT ${sel.join(', ')} FROM (${b.render()}) AS ${a})`);
    this.memo.set(table, name);
    return name;
  }

  // A calculation group: a row per item, its name and its ordinal.
  calcGroupSource(table) {
    const g = table.calcGroup;
    const cols = [g.column, g.ordinal].filter(Boolean);
    const rows = g.items.map(it => `(${this.d.str(it.name)}${g.ordinal ? `, ${this.d.num(it.ordinal)}` : ''})`);
    if (!rows.length) return `(SELECT ${cols.map(c => `NULL AS ${this.ident(c.source)}`).join(', ')} WHERE FALSE)`;
    return `(SELECT * FROM (VALUES ${rows.join(', ')}) AS v(${cols.map(c => this.ident(c.source)).join(', ')}))`;
  }

  // Code that writes what is evaluated without row-level security (calculated tables and
  // columns, the security filters themselves).
  unsecured(f) {
    const was = this.insecure;
    this.insecure = true;
    try { return f(); } finally { this.insecure = was; }
  }

  // Row-level security on a scan of `table`: each role's filters, as a filter context whose
  // relationships are those security moves along (model.securityState), so they reach the
  // scan as other filters do: from its expanded table, and as semi-joins across relationships
  // that filter both ways for security and many-to-many ones. A row is kept when some role
  // keeps it.
  securityConds(table, res, scope) {
    const roles = this.options.security;
    if (!roles?.length || this.insecure) return [];
    const per = roles.map(role => this.unsecured(() => this.conds(table, role.ctx, res, scope)));
    if (per.some(c => !c.length)) return [];
    return [per.length === 1 ? per[0].join(' AND ') : `(${per.map(c => `(${c.join(' AND ')})`).join(' OR ')})`];
  }

  // A block whose input row is its output: extend it, or wrap it if it is not.
  open(b) { return b.open && b.plain ? b : this.wrap(b); }
  wrap(b) { return this.fromSql(`(${b.render()})`, b.cols, b.names()); }
  // A block over a FROM item whose columns are `names`; with `alias`, `from` names it already.
  fromSql(from, cols, names, alias = null) {
    const a = alias ?? this.alias('s');
    const nb = new Block(this, alias ? from : `${from} AS ${a}`, cols);
    nb.res = new WrapRes(this, nb, names.map((n, i) => ({ sql: `${a}.${this.ident(n)}`, lineage: cols[i]?.lineage ?? null })), this.model.state(null));
    return nb;
  }
  combine(parts, sep, cols) {
    const from = parts.map(p => p.from).join(sep);
    const nb = new Block(this, from, cols);
    nb.res = new WrapRes(this, nb, parts.flatMap(p => p.res.list), this.model.state(null));
    nb.where.push(...parts.flatMap(p => p.where));
    return nb;
  }

  topn(x, scope) {
    let b = this.open(this.table(x.src, scope));
    const s2 = withRow(scope, x.row, b.res);
    const order = x.order.map(o => ({ sql: this.scalar(o.expr, s2), desc: o.desc }));
    const n = this.scalar(x.n, scope);
    if (order.some(o => /\bSELECT\b/i.test(o.sql))) {
      // The ordering values first, as columns: a window cannot order by a subquery.
      const base = b.outList();
      const cols = [...x.src.cols, ...order.map((_, i) => ({ name: `__order${i}`, lineage: null, t: 'variant' }))];
      b.setOut(cols, [...base.map(o => o.sql), ...order.map(o => o.sql)]);
      const w = this.wrap(b);
      w.qualify = `RANK() OVER (ORDER BY ${order.map((o, i) => `${w.res.col(base.length + i)} ${o.desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`).join(', ')}) <= ${n}`;
      w.setOut(x.cols, x.cols.map((_, i) => w.res.col(i)));
      w.open = false;
      return w;
    }
    b.qualify = `RANK() OVER (ORDER BY ${order.map(o => `${o.sql} ${o.desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`).join(', ')}) <= ${n}`;
    b.open = false;
    return b;
  }

  rowsBlock(x, scope) {
    if (x.rows.length === 1) return this.fusedRow(x, scope);
    const names = uniqNames(x.cols.map(c => c.name));
    if (!x.rows.length) {
      const b = new Block(this, null, x.cols);
      b.setOut(x.cols, x.cols.map(() => 'NULL'));
      b.where.push('FALSE');
      b.open = false;
      return b;
    }
    const parts = x.rows.map(r => `SELECT ${r.map((v, i) => `${this.scalar(v, scope)} AS ${this.ident(names[i])}`).join(', ')}`);
    return this.fromSql(`(${parts.join(' UNION ALL ')})`, x.cols, names);
  }

  // Code that writes a CTE: it reads no row and fuses nothing.
  isolated(f) {
    this.fusions.push(null);
    try { return f(); } finally { this.fusions.pop(); }
  }

  // --- window functions -------------------------------------------------------------------

  // The relation's rows with their ordering values (__o<i>), partition values (__p<i>), and
  // their number in the partition (__rn, ties broken by every column), its size (__n), and
  // their rank (__rank, __drank).
  numbered(x, scope) {
    const b = this.wrap(this.table(x.rel, scope));
    const s2 = withRow(scope, x.row, b.res);
    const base = b.outList();
    const os = x.order.map(o => this.scalar(o.expr, s2)), ps = x.parts.map(p => this.scalar(p, s2));
    b.setOut([...x.rel.cols, ...os.map((_, i) => ({ name: `__o${i}` })), ...ps.map((_, i) => ({ name: `__p${i}` }))],
      [...base.map(o => o.sql), ...os, ...ps]);
    const names = b.names(), n = this.alias('w'), q = v => `${n}.${this.ident(v)}`;
    const part = ps.length ? `PARTITION BY ${ps.map((_, i) => q(`__p${i}`)).join(', ')} ` : '';
    const order = x.order.map((o, i) => orderTerm(q(`__o${i}`), o)).join(', ');
    const ties = x.rel.cols.map((_, i) => `${q(names[i])} ASC NULLS FIRST`).join(', ');
    const num = `SELECT ${n}.*, ROW_NUMBER() OVER (${part}ORDER BY ${[order, ties].filter(Boolean).join(', ')}) AS "__rn",
      COUNT(*) OVER (${part.trim()}) AS "__n", RANK() OVER (${part}ORDER BY ${order || ties}) AS "__rank",
      DENSE_RANK() OVER (${part}ORDER BY ${order || ties}) AS "__drank" FROM (${b.render()}) AS ${n}`;
    return { num, names };
  }

  // The rows of the numbered relation that are the current row: its columns hold the outer
  // values, and those with none hold a value they have in the filter context.
  currentRows(x, scope, num, names) {
    const y = this.alias('y'), q = i => `${y}.${this.ident(names[i])}`;
    const conds = x.match.map(m => this.d.isNotDistinct(q(m.i), this.scalar(m.val, scope)));
    if (x.unbound) {
      const u = this.isolated(() => this.table(x.unbound.table, scope)), un = u.names(), a = this.alias('u');
      conds.push(`EXISTS (SELECT 1 FROM (${u.render()}) AS ${a} WHERE ${x.unbound.idx.map((i, j) => this.d.isNotDistinct(`${a}.${this.ident(un[j])}`, q(i))).join(' AND ')})`);
    }
    return `SELECT * FROM (${num}) AS ${y}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`;
  }

  // INDEX, OFFSET, WINDOW: the rows of the relation at the position, the offset or within the
  // window, in the current row's partition.
  windowRows(x, scope) {
    const { num, names } = this.numbered(x, scope);
    const r = this.alias('x'), c = this.alias('c');
    const xr = v => `${r}.${this.ident(v)}`, cr = v => `${c}.${this.ident(v)}`;
    const abs = v => `CASE WHEN ${v} > 0 THEN ${v} WHEN ${v} = 0 THEN 1 ELSE ${xr('__n')} + ${v} + 1 END`;
    let cond;
    if (x.fn === 'offset') cond = `${xr('__rn')} = ${cr('__rn')} + ${this.scalar(x.delta, scope)}`;
    else if (x.fn === 'index') {
      const p = this.scalar(x.pos, scope);
      cond = `${xr('__rn')} = CASE WHEN ${p} > 0 THEN ${p} WHEN ${p} < 0 THEN ${xr('__n')} + ${p} + 1 END`;
    } else {
      const f = this.scalar(x.from, scope), t = this.scalar(x.to, scope);
      cond = `${xr('__rn')} BETWEEN ${x.fromAbs ? abs(f) : `${cr('__rn')} + ${f}`} AND ${x.toAbs ? abs(t) : `${cr('__rn')} + ${t}`}`;
    }
    const sel = x.rel.cols.map((_, i) => xr(names[i])).join(', ');
    let sql;
    if (x.needCur) {
      const same = x.parts.map((_, i) => this.d.isNotDistinct(xr(`__p${i}`), cr(`__p${i}`)));
      let cur = this.currentRows(x, scope, num, names);
      // INDEX, and WINDOW with both ends absolute: once per current partition, not per row
      // of it (only the partition counts).
      if (x.fn === 'index' || x.fn === 'window' && x.fromAbs && x.toAbs) {
        const k = this.alias('k');
        cur = `SELECT DISTINCT ${x.parts.length ? x.parts.map((_, i) => `${k}."__p${i}"`).join(', ') : '1 AS one'} FROM (${cur}) AS ${k}`;
      }
      sql = `SELECT ${sel} FROM (${num}) AS ${r} JOIN (${cur}) AS ${c} ON ${[...same, cond].join(' AND ')}`;
    } else sql = `SELECT ${sel} FROM (${num}) AS ${r} WHERE ${cond}`;
    return this.fromSql(`(${sql})`, x.rel.cols, names.slice(0, x.rel.cols.length));
  }

  // --- the filter context on a scan -------------------------------------------------------

  conds(table, ctx, res, scope, excluded = null) {
    if (!ctx.filters.length) return [];
    const state = this.model.state(ctx.mods);
    const exp = this.model.expand(table, state, excluded);
    const inExp = c => exp.has(c.table.name);
    const out = [];
    this.fusions.push(null);
    try {
      for (const f of ctx.filters) {
        const D = f.cols.filter(inExp);
        if (!D.length) continue;
        if (f.kind === 'bind') {
          if (f.implied && ctx.filters.includes(f.implied)) continue;
          out.push(this.d.isNotDistinct(res.meta(D[0]), this.scalar(f.val, scope)));
          if (f.guard) out.push(paren(this.scalar(f.guard, scope, true)));
        }
        else if (f.kind === 'pred' && D.length === f.cols.length) out.push(paren(this.scalar(f.pred, withRow(scope, f.row, res), true)));
        else out.push(this.relCond(f.kind === 'pred' ? narrow(f, D) : f, D, table, res, scope, state));
      }
      // Filters that arrive over bidirectional and many-to-many relationships.
      for (const name of exp.keys()) {
        for (const e of this.model.inbound(this.model.table(name), state)) {
          const X = e.there.table;
          if (exp.has(X.name) || excluded?.has(X.name)) continue;
          const sub = this.scanBlock(X, ctx, scope, new Set([...(excluded ?? []), ...exp.keys()]));
          if (!sub.where.length) continue;
          sub.setOut([{ name: 'k', lineage: null }], [sub.res.meta(e.there)]);
          out.push(`${res.meta(e.here)} IN (${sub.render()})`);
        }
      }
    } finally { this.fusions.pop(); }
    return out;
  }

  // A filter that is a table, on the columns D of the scan's expanded table.
  relCond(f, D, table, res, scope, state) {
    if (!f.base) {
      const b = this.table(f.src, scope), names = b.names(), a = this.alias('r');
      const sel = D.map(c => `${a}.${this.ident(names[f.idx[f.cols.indexOf(c)]])}`);
      const blanks = D.some(c => this.blankSide(table, c, res, state) && mayBeBlank(f.src, f.idx[f.cols.indexOf(c)]));
      return this.member(D.map(c => res.meta(c)), sel, `(${b.render()}) AS ${a}`, blanks, ir.freeRows(f.src).size > 0);
    }
    // Rows of a model table, as the scan's own rows: its conditions, inline.
    const chain = filterChain(f.src);
    const full = this.model.expand(f.base, state);
    const whole = [...full.keys()].every(n => this.model.table(n).columns.every(c => f.cols.includes(c)));
    if (chain && table === f.base && whole) {
      const parts = [...this.conds(table, chain.scan.ctx, res, scope)];
      for (const p of chain.preds) parts.push(paren(this.scalar(p.pred, withRow(scope, p.row, res), true)));
      return parts.length ? parts.join(' AND ') : 'TRUE';
    }
    // Otherwise matched on the keys of the tables both expanded tables hold whole, and on the
    // columns of the others.
    const tables = [...new Set(D.map(c => c.table))];
    const covered = tables.filter(V => V.key && V.columns.every(c => f.cols.includes(c)));
    const minimal = covered.filter(V => !covered.some(W => W !== V && this.model.expand(W, state).has(V.name)));
    const settled = new Set(minimal.flatMap(W => [...this.model.expand(W, state).keys()]));
    const cols = [...minimal.map(V => V.key), ...D.filter(c => !settled.has(c.table.name))];
    const b = this.open(this.table(f.src, scope));
    b.setOut(cols.map(c => ({ name: c.name, lineage: c })), cols.map(c => b.res.meta(c)));
    const a = this.alias('r'), names = b.names();
    // A column read through a relationship is blank for rows that match no row of its table.
    const blanks = cols.some(c => this.blankSide(table, c, res, state) && this.blankSide(f.base, c, null, state));
    return this.member(cols.map(c => res.meta(c)), names.map(n => `${a}.${this.ident(n)}`), `(${b.render()}) AS ${a}`, blanks, ir.freeRows(f.src).size > 0);
  }

  // Whether a scan of `table` can read a blank in column c: on its blank row, or through a
  // relationship (not relying on referential integrity) for rows that match no row of c's
  // table. (A NULL stored in a column is taken as not there: SQL's comparison applies to it.)
  blankSide(table, c, res, state) {
    if (res?.blankRow) return true;
    if (c.table === table) return false;
    const path = this.model.expand(table, state, null, true).get(c.table.name);
    return !path || path.some(h => !(h.rel.ri || this.options.assumeIntegrity));
  }

  // Whether the values `left` are a row of `from` (its columns `right`), a blank matching a
  // blank as in DAX. IN for one column that cannot be blank on both sides; one that can, IN or
  // else a blank in `from` (as fast as IN when `from` reads no outer row); EXISTS otherwise.
  member(left, right, from, blanks = false, correlated = true) {
    if (left.length === 1 && !blanks) return `${left[0]} IN (SELECT ${right[0]} FROM ${from})`;
    if (left.length === 1 && !correlated)
      return `(${left[0]} IN (SELECT ${right[0]} FROM ${from}) OR ${left[0]} IS NULL AND EXISTS (SELECT 1 FROM ${from} WHERE ${right[0]} IS NULL))`;
    return `EXISTS (SELECT 1 FROM ${from} WHERE ${left.map((l, i) => this.d.isNotDistinct(right[i], l)).join(' AND ')})`;
  }

  // --- scalars ---------------------------------------------------------------------------

  scalar(x, scope, pred = false) {
    if (x.shared && !this.inCte && !ir.freeRows(x).size) return this.sharedScalar(x);
    switch (x.k) {
      case 'lit': return this.d.literal(x.v, x.t);
      case 'col': {
        const res = scope.get(x.row.id);
        if (!res) throw new Error(`emit: no row ${x.row.id} in scope`);
        return res.col(x.ref);
      }
      case 'op': return this.op(x, scope, pred);
      case 'fn': {
        // Values of different kinds together (a number or a text): as text.
        const as = x.t === 'variant' && ['coalesce', 'greatest', 'least'].includes(x.name) ? v => this.variant(v, scope) : v => this.scalar(v, scope);
        return this.d.fn(x.name, x.a.map(as), x.a);
      }
      case 'case': {
        const val = v => (x.t === 'variant' ? this.variant(v, scope) : this.scalar(v, scope));
        const w = x.w.map(([c, v]) => `WHEN ${this.scalar(c, scope, true)} THEN ${val(v)}`).join(' ');
        const e = x.e.k === 'lit' && x.e.v === null ? '' : ` ELSE ${val(x.e)}`;
        return `CASE ${w}${e} END`;
      }
      case 'agg': return this.agg(x, scope);
      case 'exists': return `EXISTS (${this.isolated(() => this.table(x.src, scope).render())})`;
      case 'wrank': {
        const { num, names } = this.numbered(x, scope);
        const cur = this.currentRows(x, scope, num, names);
        // One current row (rows tied in the order share a rank); several give no value.
        const c = this.alias('c'), col = x.fn === 'rownumber' ? '__rn' : x.dense ? '__drank' : '__rank';
        return `(SELECT CASE WHEN COUNT(DISTINCT ${c}.${col}) = 1 THEN MIN(${c}.${col}) END FROM (${cur}) AS ${c})`;
      }
      case 'blankexists': {
        const sql = this.blankRow(x.table, x.ctx, scope, b => { b.setOut([{ name: 'one', lineage: null }], ['1']); return b.render(); });
        return sql ? `EXISTS (${sql})` : 'FALSE';
      }
      case 'insub': {
        const b = this.isolated(() => this.table(x.src, scope)), names = b.names(), a = this.alias('i');
        const blanks = x.e.some((e, j) => !e.nn && mayBeBlank(x.src, j));
        const s = this.member(x.e.map(e => this.scalar(e, scope)), names.map(n => `${a}.${this.ident(n)}`), `(${b.render()}) AS ${a}`, blanks, ir.freeRows(x.src).size > 0);
        return pred ? `(${s})` : `COALESCE(${s}, FALSE)`;
      }
    }
    throw new Error(`emit: scalar ${x.k}`);
  }

  // A value among values of other kinds, as text.
  variant(v, scope) {
    const s = this.scalar(v, scope);
    return v.t === 'string' || v.t === 'blank' ? s : this.d.text(s, v.t);
  }

  // A value in arithmetic: a whole-number constant as a 64-bit one, as DAX computes.
  num(v, scope) {
    return v.k === 'lit' && v.t === 'int' ? this.d.bigint(v.v) : this.scalar(v, scope);
  }

  // A variable that reads nothing outside itself: one CTE, read where it is named. It is a
  // ROW of one value, so its aggregates are fused as ROW's are.
  sharedScalar(x) {
    let name = this.memo.get(x);
    if (!name) {
      name = this.alias('v');
      this.inCte = true;
      const fusion = new Fusion(this, null, [], []);
      this.fusions.push(fusion);
      let sql;
      try { sql = this.scalar({ ...x, shared: false }, new Map()); } finally { this.fusions.pop(); this.inCte = false; }
      const mark = this.ctes.length;
      const groups = fusion.finish();
      const from = groups.length ? ` FROM ${groups.map(g => g.alias).join(' CROSS JOIN ')}` : '';
      const body = `(SELECT ${sql} AS v${from})`;
      // The same value (its CTEs and its SELECT, up to their names) named again elsewhere in
      // the query, through another measure: the CTE already written.
      const own = new Map(groups.map((g, i) => [g.alias, `g${i}`]));
      const key = `shared|${canonical(renameAliases([...this.ctes.slice(mark), body].join('; '), own))}`;
      const same = this.memo.get(key);
      if (same) {
        this.ctes.length = mark;
        name = same;
      } else {
        this.ctes.push(`${name} AS ${this.d.materialized}${body}`);
        this.memo.set(key, name);
      }
      this.memo.set(x, name);
    }
    return `(SELECT v FROM ${name})`;
  }

  op(x, scope, pred) {
    const [l, r] = x.a;
    const S = (v, p = false) => this.scalar(v, scope, p);
    const d = this.d;
    switch (x.op) {
      case 'add': case 'sub': {
        const sub = x.op === 'sub';
        const date = t => t === 'datetime' || t === 'date';
        if (date(l.t) && ir.isNum(r.t)) return d.fn('add_interval', [S(l), sub ? `-(${S(r)})` : S(r), "'day'"]);
        if (!sub && ir.isNum(l.t) && date(r.t)) return d.fn('add_interval', [S(r), S(l), "'day'"]);
        if (sub && date(l.t) && date(r.t)) return d.fn('datediff', [S(r), S(l), "'day'"]);
        if (date(l.t) && date(r.t)) return d.fn('add_datetimes', [S(l), S(r)]);
        const N = v => this.num(v, scope);
        if (l.nn && r.nn) return `(${N(l)} ${sub ? '-' : '+'} ${N(r)})`;
        if (l.nn) return `(${N(l)} ${sub ? '-' : '+'} COALESCE(${S(r)}, 0))`;
        if (r.nn) return `(COALESCE(${S(l)}, 0) ${sub ? '-' : '+'} ${N(r)})`;
        return d.blankAdd(S(l), S(r), sub);
      }
      case 'mul': return `(${this.num(l, scope)} * ${this.num(r, scope)})`;
      // x / BLANK() is x / 0: infinity (or NaN), not blank; BLANK() / x is blank.
      case 'div': return d.div(S(l), r.nn ? S(r) : `COALESCE(${S(r)}, 0)`);
      case 'pow': return d.fn('power', [S(l), S(r)]);
      case 'neg': return `(-${this.num(l, scope)})`;
      case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': return this.compare(x.op, l, r, scope, pred);
      case 'eqs': return `(${d.isNotDistinct(S(l), S(r))})`;
      case 'and': return `(${this.bool(l, scope, pred)} AND ${this.bool(r, scope, pred)})`;
      case 'or': return `(${this.bool(l, scope, pred)} OR ${this.bool(r, scope, pred)})`;
      case 'not': return `(NOT ${this.bool(l, scope, false)})`;
      case 'bool': return this.bool(l, scope, pred);
      case 'concat': {
        const t = v => (v.nn ? d.text(S(v), v.t) : `COALESCE(${d.text(S(v), v.t)}, '')`);
        return `(${t(l)} || ${t(r)})`;
      }
      case 'in': {
        const vals = x.a.slice(1), blank = vals.some(v => v.k === 'lit' && v.v === null);
        const list = vals.filter(v => !(v.k === 'lit' && v.v === null)).map(v => S(v));
        const L = S(l);
        let s = list.length ? `${L} IN (${list.join(', ')})` : 'FALSE';
        if (blank) s = `(${s} OR ${L} IS NULL)`;
        return pred || blank ? `(${s})` : `COALESCE(${s}, FALSE)`;
      }
    }
    throw new Error(`emit: op ${x.op}`);
  }

  // A value as a condition: blank is FALSE, a number is its being other than 0.
  bool(v, scope, pred) {
    const s = this.scalar(v, scope, pred);
    if (v.t === 'bool' || v.t === 'blank') return v.nn || pred ? s : `COALESCE(${s}, FALSE)`;
    if (ir.isNum(v.t)) return `(COALESCE(${s}, 0) <> 0)`;
    if (v.t === 'variant') return v.nn || pred ? s : `COALESCE(${s}, FALSE)`;
    throw semantic(`a ${v.t} cannot be used as TRUE/FALSE`);
  }

  // DAX compares a blank as the other side's default (0, "", FALSE); a comparison is never
  // blank. Against a constant, the column is compared as it is and the blank case added.
  compare(o, l, r, scope, pred) {
    const sym = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[o];
    const t = [l.t, r.t].find(x => x !== 'blank' && x !== 'variant') ?? 'int';
    const L = this.scalar(l, scope), R = this.scalar(r, scope);
    if (l.nn && r.nn) return `(${L} ${sym} ${R})`;
    const constant = (v, side) => v.k === 'lit' && v.v !== null ? side : null;
    const litSide = constant(r, 'r') ?? constant(l, 'l');
    if (litSide) {
      const [lit, colSql, litSql] = litSide === 'r' ? [r, L, R] : [l, R, L];
      const blankHolds = compareJs(o, ...(litSide === 'r' ? [blankOf(t), lit.v] : [lit.v, blankOf(t)]));
      const c = litSide === 'r' ? `${colSql} ${sym} ${litSql}` : `${litSql} ${sym} ${colSql}`;
      if (blankHolds) return `(${c} OR ${colSql} IS NULL)`;
      return pred ? `(${c})` : `COALESCE(${c}, FALSE)`;
    }
    const z = this.d.blankOf(t);
    const side = (v, s) => (v.nn ? s : v.k === 'lit' && v.v === null ? z : `COALESCE(${s}, ${z})`);
    return `(${side(l, L)} ${sym} ${side(r, R)})`;
  }

  // --- aggregates --------------------------------------------------------------------------

  agg(x, scope) {
    const fusion = this.fusions.at(-1);
    if (fusion) {
      const s = fusion.add(x, scope);
      if (s) return s;
    }
    if (x.src.k === 'currentgroup') return this.aggExpr(x, scope);
    // A subquery: what it holds is not fused (SQL would read an aggregate of a column of the
    // outer query as the outer query's aggregate).
    const sql = this.isolated(() => {
      const b = this.open(this.table(x.src, scope));
      const s2 = withRow(scope, x.row, b.res);
      b.setOut([{ name: 'v', lineage: null }], [x.fn === 'single' ? this.scalar(x.arg, s2) : this.aggExpr(x, s2)]);
      return b.render();
    });
    return ir.freeRows(x).size ? `(${sql})` : this.once(sql);
  }

  // A subquery that reads nothing of the query around it, written once: the same SQL (up to
  // its aliases) anywhere in the query is one CTE.
  once(sql) {
    const key = `once|${canonical(sql)}`;
    let name = this.memo.get(key);
    if (!name) {
      name = this.alias('o');
      this.ctes.push(`${name} AS ${this.d.materialized}(${sql})`);
      this.memo.set(key, name);
    }
    return `(SELECT v FROM ${name})`;
  }

  aggExpr(x, scope) {
    const p = this.aggParts(x, scope);
    return this.d.agg(p.fn, p.arg, p.extra);
  }

  // What an aggregate is written from: its function, its argument and the rest, as SQL.
  aggParts(x, scope) {
    const arg = x.arg ? this.scalar(x.arg, scope) : null;
    const extra = {};
    if (x.fn === 'concat') {
      extra.delim = this.scalar(x.a[0], scope);
      extra.order = (x.order ?? []).map(o => `${this.scalar(o.expr, scope)}${o.desc ? ' DESC NULLS LAST' : ' ASC NULLS FIRST'}`);
      return { fn: 'concat', arg: this.d.text(arg, x.arg.t), extra };
    }
    if (x.fn === 'pct_inc' || x.fn === 'pct_exc') extra.k = this.scalar(x.a[0], scope);
    return { fn: x.fn, arg, extra };
  }

  // --- SUMMARIZECOLUMNS ----------------------------------------------------------------

  summarizeColumns(x, scope) {
    const keyNames = uniqNames(x.keyCols.map(c => c.name));
    const flagNames = x.rolls.map(r => r.flag), itemNames = x.levels[0].items.map(i => i.name);
    const names = uniqNames([...keyNames, ...flagNames, ...itemNames]);
    const levels = x.levels.map(L => this.level(x, L, scope, names, keyNames));
    return this.fromSql(levels.length === 1 ? `(${levels[0]})` : `(${levels.join(' UNION ALL ')})`, x.cols, names);
  }

  level(x, L, scope, names, keyNames) {
    const k = this.alias('k');
    const active = L.active.map(c => x.keyCols.indexOf(c));
    const keyRes = new WrapRes(this, null, x.keyCols.map((c, i) => ({ sql: `${k}.${this.ident(keyNames[i])}`, lineage: c })), this.model.state(x.ctx0.mods));
    const fusion = new Fusion(this, x.keyRow, active, x.keyCols);
    this.fusions.push(fusion);
    let items;
    try { items = L.items.map(i => this.scalar(i.expr, withRow(scope, x.keyRow, keyRes))); } finally { this.fusions.pop(); }
    const groupsSql = fusion.finish();

    // The groups: from the fused aggregates when every expression is blank without their
    // rows; else every combination of the keys' values.
    const counted = L.items.filter(i => !i.ignore);
    let keys;
    const supports = counted.map(i => support(i.expr, this.fusedIn));
    const full = g => g.keys.length === active.length;
    if (active.length && counted.length && supports.every(s => s && [...s].every(full))) {
      const gs = [...new Set(supports.flatMap(s => [...s]))];
      keys = gs.length
        ? gs.map(g => `SELECT ${active.map((ki, j) => `${g.alias}.g${g.keys.indexOf(ki)} AS ${this.ident(keyNames[ki])}`).join(', ')} FROM ${g.alias}`).join(' UNION ')
        : `SELECT ${active.map(ki => `NULL AS ${this.ident(keyNames[ki])}`).join(', ')} WHERE FALSE`;
    } else if (active.length) {
      keys = this.keyCombinations(x, L, keyNames, scope);
    } else keys = 'SELECT 1 AS one';

    const sel = [
      ...x.keyCols.map((_, i) => `${active.includes(i) ? `${k}.${this.ident(keyNames[i])}` : 'NULL'} AS ${this.ident(names[i])}`),
      ...L.flags.map((f, i) => `${f ? 'TRUE' : 'FALSE'} AS ${this.ident(names[x.keyCols.length + i])}`),
      ...items.map((s, i) => `${s} AS ${this.ident(names[x.keyCols.length + L.flags.length + i])}`),
    ];
    let sql = `SELECT ${sel.join(', ')} FROM (${keys}) AS ${k}${groupsSql.map(g => ` LEFT JOIN ${g.alias} ON ${g.on(k, keyNames)}`).join('')}`;
    if (counted.length) {
      const z = this.alias('z');
      const test = L.items.map((it, i) => it.ignore ? null : `${z}.${this.ident(names[x.keyCols.length + L.flags.length + i])} IS NOT NULL`).filter(Boolean);
      sql = `SELECT * FROM (${sql}) AS ${z} WHERE ${test.join(' OR ')}`;
    }
    return sql;
  }

  // Every combination of the grouping columns' values: within a table those it holds, under
  // the query's filters; across tables, all.
  keyCombinations(x, L, keyNames, scope) {
    const byTable = new Map();
    for (const c of L.active) {
      if (!byTable.has(c.table)) byTable.set(c.table, []);
      byTable.get(c.table).push(c);
    }
    const parts = [...byTable].map(([t, cols]) => {
      const out = b => {
        b.setOut(cols.map(c => ({ name: keyNames[x.keyCols.indexOf(c)], lineage: c })), cols.map(c => b.res.meta(c)));
        b.distinct = true;
        return b.render();
      };
      const rows = out(this.isolated(() => this.scanBlock(t, x.ctx0, scope)));
      const blank = this.blankRow(t, x.ctx0, scope, out);
      return blank ? `${rows} UNION ${blank}` : rows;
    });
    if (parts.length === 1) return parts[0];
    return `SELECT * FROM ${parts.map(p => `(${p}) AS ${this.alias('c')}`).join(' CROSS JOIN ')}`;
  }

  // The blank row DAX adds to a table on the one side of a relationship when rows of the
  // many side match none of its rows: with the filters on it (it is blank in every column),
  // when there are such rows. None where the relationship relies on referential integrity.
  blankRow(table, ctx, scope, out) {
    const rels = this.model.relationships.filter(r => r.to.table === table && r.fromCard === 'many' && r.toCard === 'one'
      && !r.ri && !this.options.assumeIntegrity);
    if (!rels.length || this.options.blankRows === false) return null;
    const nulls = table.columns.filter(c => !c.expr).map(c => `${c.type === 'variant' ? 'NULL' : this.d.cast('NULL', c.type)} AS ${this.ident(c.source)}`);
    const b = this.isolated(() => this.scanBlock(table, ctx, scope, null, null, `(SELECT ${nulls.join(', ')})`));
    b.where.push(`(${this.orphans(table)})`);
    return out(b);
  }

  // Whether the table has a blank row: some row on the many side of a relationship to it has a
  // key it lacks, or that table has a blank row itself (whose key matches nothing: a sale of an
  // unknown product is in the blank category too).
  orphans(table, seen = new Set()) {
    seen.add(table);
    const parts = [];
    for (const r of this.model.relationships) {
      if (r.to.table !== table || r.fromCard !== 'many' || r.toCard !== 'one' || r.ri) continue;
      const f = this.alias('o'), d = this.alias('o');
      parts.push(`EXISTS (SELECT 1 FROM ${this.source(r.from.table)} AS ${f} LEFT JOIN ${this.source(table)} AS ${d} ON ${d}.${this.ident(r.to.source)} = ${f}.${this.ident(r.from.source)} WHERE ${d}.${this.ident(r.to.source)} IS NULL)`);
      if (!seen.has(r.from.table)) {
        const inner = this.orphans(r.from.table, seen);
        if (inner) parts.push(inner);
      }
    }
    return parts.join(' OR ');
  }

  // ROW(...): one row, its aggregates fused where they can be.
  fusedRow(x, scope) {
    const fusion = new Fusion(this, null, [], []);
    this.fusions.push(fusion);
    let vals;
    try { vals = x.rows[0].map(v => this.scalar(v, scope)); } finally { this.fusions.pop(); }
    const groups = fusion.finish();
    const names = uniqNames(x.cols.map(c => c.name));
    const b = new Block(this, groups.length ? groups.map(g => g.alias).join(' CROSS JOIN ') : null, x.cols);
    b.setOut(x.cols, vals);
    b.open = false;
    b._names = names;
    return b;
  }
}

// --- fusion --------------------------------------------------------------------------------

// The aggregates of one SUMMARIZECOLUMNS level (or ROW) that can share a GROUP BY: over a
// scan, reading no row but the group's keys, which they filter by. A group is one CTE: the
// scan's table and its other filters (compared as SQL), and the keys that filter it.
class Fusion {
  constructor(em, keyRow, active, keyCols) {
    this.em = em;
    this.keyRow = keyRow;
    this.active = active;
    this.keyCols = keyCols;
    this.groups = [];
  }

  add(x, scope) {
    const em = this.em, S = x.src;
    if (S.k !== 'scan' || x.fn === 'single') return null;
    const kid = this.keyRow?.id;
    for (const id of ir.freeRows(x)) if (id !== kid) return null;
    for (const part of [x.arg, ...x.a, ...(x.order ?? []).map(o => o.expr)]) {
      if (!part) continue;
      for (const id of ir.freeRows(part)) if (id !== x.row.id) return null;
    }
    const state = em.model.state(S.ctx.mods);
    const exp = em.model.expand(S.table, state);
    const keys = new Set(), rest = [], guards = [], via = [];
    for (const f of S.ctx.filters) {
      if (f.kind === 'bind' && f.val.k === 'col' && f.val.row === this.keyRow) {
        const c = f.cols[0];
        if (exp.has(c.table.name)) keys.add(f.val.ref);
        // A key on a table whose filter reaches the scan over a relationship that filters
        // back (both ways, many-to-many): kept for the mapping below.
        else if (em.model.reaches(c.table, S.table, state)) via.push({ ref: f.val.ref, col: c });
        else continue;
        // A guarded key (a value of the group, when a condition on the group holds): the
        // condition is the group's, read where the group is.
        if (f.guard && !guards.includes(f.guard)) guards.push(f.guard);
        continue;
      }
      rest.push(f);
    }
    // Keys that reach the scan over a relationship that filters back: the scan is joined to
    // the pairs (key, value of the relationship's column) that the filter context keeps on the
    // keys' table, and grouped by the key. A row of the scan is in a key's group when its
    // column is one of that key's values, as the filter's IN says, once per key.
    let edge = null;
    if (via.length) {
      const X = via[0].col.table;
      if (via.some(v => v.col.table !== X)) return null;
      for (const name of exp.keys()) {
        for (const e of em.model.inbound(em.model.table(name), state)) if (e.there.table === X) edge ??= e;
      }
      if (!edge) return null;
    }
    // The other filters read no row, or only keys the scan is filtered to: those are its own
    // columns, row by row.
    let readsKeys = false;
    for (const f of rest) {
      const free = ir.freeRows({ k: 'scan', ctx: new Ctx([f]) });
      for (const id of free) if (id !== kid) return null;
      if (free.size) {
        for (const i of ir.rowRefs(f, kid)) if (!keys.has(i)) return null;
        readsKeys = true;
      }
    }
    const block = em.isolated(() => em.scanBlock(S.table, new Ctx(rest, S.ctx.mods), new Map(), null, readsKeys ? [this.keyRow, this.keyCols] : null));
    const keyExpr = new Map();
    if (edge) {
      const m = em.isolated(() => em.scanBlock(edge.there.table, new Ctx(rest, S.ctx.mods), new Map(), new Set(exp.keys())));
      m.setOut([...via.map((_, j) => ({ name: `g${j}` })), { name: 'y' }], [...via.map(v => m.res.meta(v.col)), m.res.meta(edge.there)]);
      m._names = [...via.map((_, j) => `g${j}`), 'y'];
      m.distinct = true;
      const ma = em.alias('m');
      block.joins.push(`JOIN (${m.render()}) AS ${ma} ON ${block.res.meta(edge.here)} = ${ma}.y`);
      via.forEach((v, j) => { keys.add(v.ref); keyExpr.set(v.ref, `${ma}.g${j}`); });
    }
    const keyList = [...keys].sort((a, b) => a - b);
    const sig = `${S.table.name}|${state.key}|${keyList.join(',')}|${canonical(`${block.from} ${block.joins.join(' ')} ${block.where.join(' AND ')}`)}`;
    let g = this.groups.find(x => x.sig === sig), rename = s => s, conds = null, parts = null;
    if (!g && !keyList.length && !readsKeys && em.d.aggFilter) {
      // An aggregate over the whole of another scan of the same tables (no keys: one row
      // each) is that scan's, over the rows its own conditions on the joined tables keep:
      // one scan for both. Its
      // SQL is written first, on its own scan, since that can join a table to it.
      parts = em.isolated(() => em.aggParts(x, withRow(new Map(), x.row, block.res)));
      const into = `${S.table.name}|${state.key}`;
      const from = b => [b.from, ...b.joins].join(' ');
      const same = this.groups.find(x => x.merge === into && canonical(from(x.block)) === canonical(from(block)));
      const map = same && aliasMap(from(block), from(same.block));
      // Only conditions on joined tables may differ: a condition on the scanned table's own
      // columns is what lets the engine skip its rows, so the scans must agree on those.
      const base = same && / AS (\w+)$/.exec(same.block.from)?.[1];
      const own = cs => cs.filter(c => c.split(/('(?:[^']|'')*')/).some((part, i) => i % 2 === 0 && part.includes(`${base}.`))).sort().join(' AND ');
      const mapped = map && block.where.map(s => renameAliases(s, map));
      if (map && base && own(mapped) === own(same.aggs[0].conds)) {
        g = same;
        rename = s => renameAliases(s, map);
        conds = mapped;
      }
    }
    if (!g) {
      g = { sig, alias: em.alias('f'), block, keys: keyList, aggs: [], merge: !keyList.length && !readsKeys ? `${S.table.name}|${state.key}` : null };
      g.keyExprs = keyList.map(i => keyExpr.get(i) ?? block.res.meta(this.keyCols[i]));
      g.on = (k, keyNames) => keyList.length
        ? keyList.map((ki, j) => em.d.isNotDistinct(`${g.alias}.g${j}`, `${k}.${em.ident(keyNames[ki])}`)).join(' AND ')
        : 'TRUE';
      this.groups.push(g);
    }
    // Each aggregate keeps the conditions of its own scan; finish() writes the ones the
    // others of its group lack as its FILTER.
    if (!conds) {
      parts = g.block === block && parts ? parts : em.isolated(() => em.aggParts(x, withRow(new Map(), x.row, g.block.res)));
      conds = [...g.block.where];
    }
    const p = { ...parts, arg: parts.arg && rename(parts.arg), extra: Object.fromEntries(Object.entries(parts.extra)
      .map(([k, v]) => [k, Array.isArray(v) ? v.map(rename) : rename(v)])) };
    const make = filter => em.d.agg(p.fn, p.arg, filter ? { ...p.extra, filter } : p.extra);
    const key = `${make(null)}|${[...conds].sort().join(' AND ')}`;
    let i = g.aggs.findIndex(a => a.key === key);
    if (i < 0) { g.aggs.push({ key, conds, make }); i = g.aggs.length - 1; }
    em.fusedIn.set(x, g);
    if (!guards.length) return `${g.alias}.a${i}`;
    const when = em.isolated(() => guards.map(c => paren(em.scalar(c, scope, true))).join(' AND '));
    return `CASE WHEN ${when} THEN ${g.alias}.a${i}${x.fn === 'count0' || x.fn === 'dcount0' ? ' ELSE 0' : ''} END`;
  }

  // The CTEs, written once every aggregate is known.
  finish() {
    for (const g of this.groups) {
      const b = g.block;
      // The scan keeps the conditions every aggregate has; an aggregate's others are its FILTER.
      const common = b.where.filter(c => g.aggs.every(a => a.conds.includes(c)));
      b.where = common;
      const aggs = g.aggs.map(a => {
        const own = a.conds.filter(c => !common.includes(c));
        return a.make(own.length ? own.map(paren).join(' AND ') : null);
      });
      b.setOut([...g.keyExprs.map((_, j) => ({ name: `g${j}` })), ...aggs.map((_, i) => ({ name: `a${i}` }))], [...g.keyExprs, ...aggs]);
      b._names = [...g.keyExprs.map((_, j) => `g${j}`), ...aggs.map((_, i) => `a${i}`)];
      if (g.keyExprs.length) b.group = g.keyExprs;
      this.em.ctes.push(`${g.alias} AS (${b.render()})`);
    }
    return this.groups;
  }
}

// The fused groups without whose rows an expression is blank, or null if it can be
// non-blank without any: whether SUMMARIZECOLUMNS can take its groups from them.
function support(x, fusedIn) {
  const all = xs => {
    const out = new Set();
    for (const v of xs) {
      const s = support(v, fusedIn);
      if (!s) return null;
      s.forEach(g => out.add(g));
    }
    return out;
  };
  switch (x.k) {
    case 'lit': return x.v === null ? new Set() : null;
    case 'agg': {
      const g = fusedIn.get(x);
      return g && !['count0', 'dcount0', 'hasone'].includes(x.fn) ? new Set([g]) : null;
    }
    case 'op':
      if (x.op === 'add' || x.op === 'sub') return all(x.a);
      // BLANK() * x and BLANK() / x are blank; x / BLANK() is not (it is infinity).
      if (x.op === 'mul') return support(x.a[0], fusedIn) ?? support(x.a[1], fusedIn);
      if (x.op === 'div') return support(x.a[0], fusedIn);
      if (x.op === 'neg') return support(x.a[0], fusedIn);
      return null;
    case 'fn':
      if (x.name === 'divide') return x.a.length === 2 || (x.a[2].k === 'lit' && x.a[2].v === null)
        ? support(x.a[0], fusedIn) ?? support(x.a[1], fusedIn) : null;
      if (x.name === 'coalesce') return all(x.a);
      if (x.strict || x.name === 'cast') return support(x.a[0], fusedIn);
      return null;
    case 'case': return all([...x.w.map(w => w[1]), x.e]);
    default: return null;
  }
}

// --- blocks and resolvers ----------------------------------------------------------------

class Block {
  constructor(em, from, cols) {
    this.em = em;
    this.from = from;
    this.cols = cols;
    this.joins = [];
    this.where = [];
    this.group = null;
    this.distinct = false;
    this.qualify = null;
    this.out = null;       // [{ name, sql }], or null: the input row's columns
    this.open = true;      // WHERE and the select list can still be written over the input row
    this.plain = true;     // the output is the input row
    this._names = null;
  }
  names() { return this._names ??= uniqNames(this.cols.map(c => c.name)); }
  outList() {
    if (this.out) return this.out;
    const names = this.names();
    return this.cols.map((_, i) => ({ name: names[i], sql: this.res.col(i) }));
  }
  setOut(cols, sqls) {
    this.cols = cols;
    this._names = uniqNames(cols.map(c => c.name));
    this.out = sqls.map((sql, i) => ({ name: this._names[i], sql }));
    this.plain = false;
  }
  render() {
    const id = n => this.em.ident(n);
    const out = this.outList().map(o => (o.sql.endsWith(`.${id(o.name)}`) ? o.sql : `${o.sql} AS ${id(o.name)}`));
    const parts = [`SELECT ${this.distinct ? 'DISTINCT ' : ''}${out.length ? out.join(', ') : '1 AS one'}`];
    if (this.from) parts.push(`FROM ${this.from}${this.joins.length ? ' ' + this.joins.join(' ') : ''}`);
    if (this.where.length) parts.push(`WHERE ${this.where.join(' AND ')}`);
    if (this.group?.length) parts.push(`GROUP BY ${this.group.join(', ')}`);
    if (this.qualify) parts.push(`QUALIFY ${this.qualify}`);
    return parts.join(' ');
  }
}

// Writes the columns of a row, and joins related tables into its block to reach theirs.
class Res {
  constructor(em, block, state) {
    this.em = em;
    this.block = block;
    this.state = state;
    this.joinAlias = new Map();
  }
  meta(m) {
    const own = this.own(m);
    if (own != null) return own;
    for (const t of this.anchors()) {
      const path = this.em.model.expand(t, this.state, null, true).get(m.table.name);
      if (path?.length && this.own(path[0].from) != null) return this.via(path, m);
    }
    throw semantic(`'${m.table.name}'[${m.name}] cannot be reached from this row`);
  }
  // Through the joins of `path` to column m of its last table; a foreign key stands for the
  // key it references when the relationship relies on referential integrity.
  via(path, m) {
    const last = path.at(-1);
    if (last.to === m && (last.rel.ri || this.em.options.assumeIntegrity) && last.rel.to === m)
      return path.length === 1 ? this.own(last.from) : this.via(path.slice(0, -1), last.from);
    return this.physical(this.join(path), m);
  }
  join(path) {
    const key = path.map(h => `${h.rel.name}${h.from === h.rel.from ? '>' : '<'}`).join('/');
    let a = this.joinAlias.get(key);
    if (a) return a;
    const from = path.length === 1 ? this.own(path[0].from) : this.physical(this.join(path.slice(0, -1)), path.at(-1).from);
    const hop = path.at(-1);
    a = this.em.alias('j');
    if (!this.block) throw semantic(`'${hop.to.table.name}' cannot be joined here`);
    this.block.joins.push(`LEFT JOIN ${this.em.source(hop.to.table)} AS ${a} ON ${a}.${this.em.ident(hop.to.source)} = ${from}`);
    this.joinAlias.set(key, a);
    (this.joinKey ??= new Map()).set(a, `${a}.${this.em.ident(hop.to.source)}`);
    return a;
  }
  physical(alias, m) {
    if (!m.expr) return `${alias}.${this.em.ident(m.source)}`;
    // A calculated column: its expression on this row, in an empty filter context and without
    // row-level security, as computed at refresh. Blank on the blank row (a join that found
    // no row, or the blank row itself).
    if (alias === this.alias && this.blankRow) return this.em.d.cast('NULL', m.type);
    const { row, expr } = this.em.options.calcColumn(m);
    const res = new ScanRes(this.em, this.block, m.table, alias, this.state);
    // One that needs its own values (a window function over its own table) cannot be written.
    const busy = (this.em.calcBusy ??= new Set());
    if (busy.has(m)) throw semantic(`calculated column '${m.table.name}'[${m.name}] depends on itself`);
    busy.add(m);
    let sql;
    try { sql = `(${this.em.unsecured(() => this.em.isolated(() => this.em.scalar(expr, new Map([[row.id, res]]))))})`; } finally { busy.delete(m); }
    const key = this.joinKey?.get(alias);
    return key ? `CASE WHEN ${key} IS NULL THEN NULL ELSE ${sql} END` : sql;
  }
}

class ScanRes extends Res {
  constructor(em, block, table, alias, state) {
    super(em, block, state);
    this.table = table;
    this.alias = alias;
  }
  own(m) { return m.table === this.table ? this.physical(this.alias, m) : null; }
  anchors() { return [this.table]; }
  col(ref) { return this.meta(typeof ref === 'number' ? this.table.columns[ref] : ref); }
}

class WrapRes extends Res {
  constructor(em, block, list, state) {
    super(em, block, state);
    this.list = list;   // [{ sql, lineage }]
  }
  own(m) { return this.list.find(c => c.lineage === m)?.sql ?? null; }
  anchors() { return [...new Set(this.list.filter(c => c.lineage).map(c => c.lineage.table))]; }
  col(ref) {
    if (typeof ref === 'number') {
      if (!this.list[ref]) throw new Error(`emit: no column ${ref}`);
      return this.list[ref].sql;
    }
    return this.meta(ref);
  }
}

// --- helpers -------------------------------------------------------------------------------

function withRow(scope, row, res) {
  const s = new Map(scope);
  s.set(row.id, res);
  return s;
}
const paren = s => `(${s})`;

// An ORDER BY term with DAX's blanks: DEFAULT puts a numeric blank between the negative
// numbers and zero, and a text blank before every text; FIRST and LAST say.
function orderTerm(v, o) {
  const dir = o.desc ? 'DESC' : 'ASC';
  if (o.blanks === 'first') return `${v} ${dir} NULLS FIRST`;
  if (o.blanks === 'last') return `${v} ${dir} NULLS LAST`;
  if (ir.isNum(o.t)) return `COALESCE(${v}, 0) ${dir}, (${v} IS NULL) ${o.desc ? 'ASC' : 'DESC'}`;
  return `${v} ${dir} NULLS ${o.desc ? 'LAST' : 'FIRST'}`;
}

// Whether a table can hold the blank row (and so a key matched against it can be blank).
// Whether column i of table x can hold a blank, as far as the compiler can tell: a constant
// is one or not; a model table's own column is not (a NULL stored in it aside); the blank row
// is; anything else may be.
function mayBeBlank(x, i) {
  if (i == null || i < 0) return true;
  const lit = v => v?.k === 'lit' && v.v !== null;
  switch (x.k) {
    case 'rows': return x.rows.some(r => !lit(r[i]));
    case 'onerow': return !lit(x.vals[i]) && !x.vals[i]?.nn;
    case 'distinct': case 'shared': case 'filter': case 'topn': return mayBeBlank(x.src, i);
    case 'project': {
      if (x.keep && i < x.src.cols.length) return mayBeBlank(x.src, i);
      const e = x.items[x.keep ? i - x.src.cols.length : i]?.expr;
      if (e?.k === 'col' && e.row === x.row) return mayBeBlank(x.src, typeof e.ref === 'number' ? e.ref : x.src.cols.findIndex(c => c.lineage === e.ref));
      return !e?.nn;
    }
    case 'scan': return !(x.cols[i]?.lineage?.table === x.table);
    case 'union': case 'intersect': case 'except': return x.srcs.some(s => mayBeBlank(s, i));
  }
  return true;
}

// A filter's table as FILTER(..FILTER(scan)..): the scan and the predicates.
function filterChain(x) {
  const preds = [];
  while (x.k === 'filter' || x.k === 'distinct') {
    if (x.k === 'filter') preds.push({ pred: x.pred, row: x.row });
    x = x.src;
  }
  return x.k === 'scan' ? { scan: x, preds } : null;
}

// Names unique without regard to case, as SQL compares them.
function uniqNames(names) {
  const seen = new Set();
  return names.map(n => {
    let name = String(n || 'col'), i = 1;
    while (seen.has(lc(name))) name = `${n}_${++i}`;
    seen.add(lc(name));
    return name;
  });
}

function daxName(c) {
  return c.lineage ? `'${c.lineage.table.name}'[${c.lineage.name}]` : `[${c.name}]`;
}
function outputNames(cols, style) {
  if (style === 'dax') return uniqNames(cols.map(c => (c.lineage ? `${c.lineage.table.name}[${c.lineage.name}]` : `[${c.name}]`)));
  // Short names; where two collide, the later ones say their table.
  const seen = new Set();
  return uniqNames(cols.map(c => {
    let n = c.name;
    if (seen.has(lc(n)) && c.lineage) n = `${c.lineage.table.name}[${c.name}]`;
    seen.add(lc(n));
    return n;
  }));
}

// SQL with its generated aliases numbered by first appearance: the same filters give the
// same text.
// The aliases of one FROM (with its joins) as those of another written the same way
// (canonical), or null.
function aliasMap(from, to) {
  const re = /\b[a-z]\d+\b/g, a = from.match(re) ?? [], b = to.match(re) ?? [];
  if (a.length !== b.length) return null;
  const map = new Map();
  for (let i = 0; i < a.length; i++) {
    if (map.has(a[i]) && map.get(a[i]) !== b[i]) return null;
    map.set(a[i], b[i]);
  }
  return map;
}
// SQL with its aliases renamed, outside its string literals.
function renameAliases(sql, map) {
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => i % 2 ? part
    : part.replace(/\b[a-z]\d+\b/g, m => map.get(m) ?? m)).join('');
}

// SQL with the aliases it declares (AS t3) numbered in order of appearance, so that two
// writings of the same SQL compare equal. A name it only refers to (a CTE) is kept: two
// subqueries over different CTEs are different.
function canonical(sql) {
  const declared = new Set([...sql.matchAll(/\bAS ([a-z]\d+)\b/g)].map(m => m[1]));
  const map = new Map();
  return sql.replace(/\b([a-z])(\d+)\b/g, (m) => {
    if (!declared.has(m)) return m;
    if (!map.has(m)) map.set(m, `@${map.size}`);
    return map.get(m);
  });
}

const blankOf = t => (t === 'string' ? '' : t === 'bool' ? false : t === 'datetime' || t === 'date' ? '1899-12-30' : 0);
function compareJs(o, a, b) {
  switch (o) {
    case 'eq': return a === b || (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase());
    case 'ne': return !compareJs('eq', a, b);
    case 'lt': return a < b;
    case 'le': return a <= b;
    case 'gt': return a > b;
    case 'ge': return a >= b;
  }
  return false;
}
