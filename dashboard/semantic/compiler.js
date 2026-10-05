// =============================================================================
// compiler.js — compiles the semantic model (model.bim) into DuckDB views, and the page's
// DAX queries into SQL over them
// =============================================================================
// The layers of the dashboard, and what stands in each place in a real product:
//   consumer        index.html                 the BI tool
//   query language  DAX                        DAX, MDX, VizQL, Malloy, a metrics request
//   semantic model  model.bim (TMSL)           a Tabular model, LookML, MetricFlow YAML
//   compiler        this file                  Power BI's formula engine, MetricFlow, Cube
//   engine          DuckDB-WASM                the warehouse, VertiPaq, Hyper
//   storage         ../storage/data.js         the lakehouse or warehouse connection
//
// It is a proof of concept, not a DAX engine. It knows the constructs the page uses and
// throws on anything else, and where DAX and SQL differ the result is SQL's: a blank is a
// NULL, and a group whose measures are all blank is kept. There is no filter context: a
// filter is a boolean argument of CALCULATETABLE or CALCULATE, and becomes a WHERE.
//
// Part 1, the model. What model.bim holds and what each entry becomes:
//   measures             nothing of their own: a measure is DAX, written out where a query
//                        names it ([Renewable share]), so a CALCULATE around it reaches its
//                        aggregates
//   tables               a view each, v_<table>, of one of four kinds, told by its partitions:
//     one entity partition with a schema   that attached table, as it is; no view if a
//                        deployed file lacks it
//     two partitions     `history` and `recent`, stitched (the `stitch` annotation, described
//                        in the model's annotations). Schema `p*` is every attached half-year
//                        database. An `optional` column reads NULL from a file that lacks it;
//                        `rollup` is a column's expression on the recent side, which is then
//                        grouped
//     one entity partition without a schema   columns picked from another table of the model,
//                        plus the calculated columns over them
//     a query partition  SQL over other views; `when` names columns that must exist
//   relationships        a view each, under the relationship's name: the `from` side LEFT JOIN
//                        the `to` side, with the columns of `to` (all of them, or the ones in
//                        `columns`). The calculated columns of `to` are worked out again on
//                        the joined row, so a row with no match gets a value too
// In an expression, {name} is one of the model's `expressions`.
//
// Part 2, the queries (toSQL). A DAX query becomes one SELECT over those views:
//   SUMMARIZECOLUMNS, ROW             an aggregate; ROLLUPADDISSUBTOTAL is GROUPING SETS
//   CALCULATETABLE(t, filters)        WHERE; TREATAS(VALUES(..), col) is col IN (SELECT ..)
//   SELECTCOLUMNS, VALUES             a projection, DISTINCT
//   GROUPBY over one of those         the grouping, in the same SELECT when it can be
//   FILTER                            WHERE on rows, HAVING on an aggregate
//   TOPN, ORDER BY                    ORDER BY .. LIMIT
//   UNION, a table VAR                UNION ALL, a CTE; a scalar VAR is a scalar subquery
//   CALCULATE(measure, filter)        the aggregates of the measure with FILTER (WHERE ..)
//   [Name]                            a column of the table being built, else a measure
// Which view a query reads is decided here, from the tables it names: `scada` alone reads
// v_scada, with `unit` v_gen, with `price` v_gen_price. So a query that needs nothing about
// the unit pays for no join, with no rule for the author to remember.
// What comes back is cast by the column's dataType, as the browser wants it: a date as text,
// a whole number as INTEGER, a number as DOUBLE.
//
// createModel(data) wraps a data source (../storage/data.js: init, attachAgg, ensureHistory,
// query) and has its members plus `has`, `needs` and `toSQL`; `query` takes DAX (it starts
// with EVALUATE) or SQL. It compiles the model after every attach, reading what is attached
// from the engine's own catalog: one query for the catalog, one for the statements that
// changed. A view is created once and bound again every time it is read (DuckDB), so the
// ones over a rebuilt view follow it.
//
// Host-independent: it only knows the attached databases by name (dim, today, agg,
// p<YYYY>_h<N>), so a host that ships its own data.js keeps this file and model.bim.
// =============================================================================

// The model, fetched next to this file, with this file's ?v= (the Fabric build's cache-buster).
const MODEL = (await (await fetch(new URL('./model.bim' + new URL(import.meta.url).search, import.meta.url))).json()).model;

const text = s => Array.isArray(s) ? s.join(' ') : s;

// =============================================================================
// DAX: text -> tree
// =============================================================================

function lex(src) {
  const re = /\s+|\/\/[^\n]*|(\d+(?:\.\d+)?)|dt"([^"]*)"|"((?:[^"]|"")*)"|'([^']+)'|\[([^\]]+)\]|([A-Za-z_][\w.]*)|(&&|\|\||<>|<=|>=|[-=<>+*\/&(),{}])/y;
  const out = [];
  while (re.lastIndex < src.length) {
    const at = re.lastIndex, m = re.exec(src);
    if (!m) throw new Error(`DAX: cannot read "${src.slice(at, at + 30)}"`);
    const [, num, date, str, quoted, col, id, op] = m;
    const t = num != null ? 'num' : date != null ? 'date' : str != null ? 'str'
      : quoted != null || id != null ? 'id' : col != null ? 'col' : op != null ? 'op' : null;
    if (t) out.push({ t, v: num ?? date ?? str?.replace(/""/g, '"') ?? quoted ?? col ?? id ?? op, at, end: re.lastIndex });
  }
  return out;
}

// A recursive-descent parser. `query` reads EVALUATE .. ORDER BY, `expr` an expression.
function parse(src) {
  const toks = lex(src);
  let i = 0;
  const here = () => `"${src.slice(toks[i]?.at ?? src.length, (toks[i]?.at ?? src.length) + 30)}"`;
  const op = v => toks[i]?.t === 'op' && toks[i].v === v;
  const kw = v => toks[i]?.t === 'id' && toks[i].v.toUpperCase() === v;
  const eat = v => (op(v) || kw(v)) && !!++i;
  const need = v => { if (!eat(v)) throw new Error(`DAX: expected ${v} at ${here()}`); };
  const chain = (next, ops) => () => {
    let l = next();
    for (let o; (o = ops.find(x => op(x)));) { i++; l = { k: 'bin', op: o, l, r: next() }; }
    return l;
  };
  function args(close) {
    const a = [];
    if (eat(close)) return a;
    do a.push(expr()); while (eat(','));
    need(close);
    return a;
  }
  function primary() {
    const t = toks[i++];
    if (!t) throw new Error('DAX: the expression ends too soon');
    if (t.t === 'num' || t.t === 'str' || t.t === 'date') return { k: t.t, v: t.v };
    if (t.t === 'col') return { k: 'ref', name: t.v };
    if (t.t === 'op' && t.v === '(') { const e = expr(); need(')'); return { k: 'paren', e }; }
    if (t.t === 'op' && t.v === '{') return { k: 'list', items: args('}') };
    if (t.t === 'id') {
      // table[column]: the bracket follows the name with no space.
      if (toks[i]?.t === 'col' && toks[i].at === t.end) return { k: 'col', table: t.v, name: toks[i++].v };
      if (eat('(')) return { k: 'call', fn: t.v, args: args(')') };
      return { k: 'name', name: t.v };
    }
    i--;
    throw new Error(`DAX: unexpected ${here()}`);
  }
  const unary = () => eat('-') ? { k: 'neg', e: unary() } : primary();
  const mul = chain(unary, ['*', '/']), add = chain(mul, ['+', '-']), cat = chain(add, ['&']);
  function cmp() {
    const l = cat(), o = ['=', '<>', '<=', '>=', '<', '>'].find(x => op(x));
    if (o) { i++; return { k: 'bin', op: o, l, r: cat() }; }
    if (eat('IN')) { need('{'); return { k: 'in', e: l, list: args('}') }; }
    return l;
  }
  const not = () => eat('NOT') ? { k: 'not', e: not() } : cmp();
  const and = chain(not, ['&&']), or = chain(and, ['||']);
  function expr() {
    if (!kw('VAR')) return or();
    const defs = [];
    while (eat('VAR')) { const name = toks[i++].v; need('='); defs.push({ name, e: expr() }); }
    need('RETURN');
    return { k: 'var', defs, body: expr() };
  }
  const end = x => { if (i < toks.length) throw new Error(`DAX: unexpected ${here()}`); return x; };
  return {
    expr: () => end(expr()),
    query() {
      need('EVALUATE');
      const e = expr(), order = [];
      if (eat('ORDER')) {
        need('BY');
        do { const o = expr(), desc = eat('DESC'); if (!desc) eat('ASC'); order.push({ e: o, desc }); } while (eat(','));
      }
      return end({ e, order });
    },
  };
}

// =============================================================================
// DAX: tree -> SQL
// =============================================================================

// An expression in SQL: its text `s`, its type `t` (string, int, double, date, bool) and
// its precedence `p`, which says when it needs brackets.
const P = { or: 1, and: 2, not: 3, cmp: 4, cat: 5, add: 6, mul: 7, atom: 9 };
const OPS = {
  '||': ['OR', P.or, true], '&&': ['AND', P.and, true],
  '=': ['=', P.cmp, true], '<>': ['<>', P.cmp, true], '<': ['<', P.cmp, true], '>': ['>', P.cmp, true],
  '<=': ['<=', P.cmp, true], '>=': ['>=', P.cmp, true],
  '+': ['+', P.add], '-': ['-', P.add], '*': ['*', P.mul], '/': ['/', P.mul],
};
const atom = (s, t) => ({ s, t, p: P.atom });
const par = (x, p) => x.p < p ? `(${x.s})` : x.s;
const lit = v => `'${String(v).replace(/'/g, "''")}'`;
const isCall = (e, fn) => e.k === 'call' && e.fn.toUpperCase() === fn;
const TYPES = { string: 'string', int64: 'int', double: 'double', decimal: 'double', dateTime: 'date', boolean: 'bool' };

// The model as DAX sees it: tables and their columns, the measures (parsed when a query
// first names one), and the relationships.
const TABLES = new Map(MODEL.tables.map(t => [t.name, new Map(t.columns.map(c => [c.name,
  { name: c.name, type: TYPES[c.dataType] }]))]));
const MEASURE_DAX = new Map(MODEL.tables.flatMap(t => (t.measures || []).map(m => [m.name, text(m.expression)])));
const _measures = new Map();
function measure(name) {
  if (!_measures.has(name)) _measures.set(name, parse(MEASURE_DAX.get(name)).expr());
  return _measures.get(name);
}
const RELS = MODEL.relationships.map(r => ({ view: r.name, from: r.fromTable, fromColumn: r.fromColumn, to: r.toTable, toColumn: r.toColumn }));
// Rooftop solar at 5 minutes. The model stores the half-hourly estimate (fct_rooftop) and
// [Rooftop MW] works out the times between two half hours, by looking up its neighbours row
// by row. That DAX is not translated: v_fct_rooftop_5min (below) is the same thing in SQL,
// and [Rooftop MW] is the sum of its mw. It is related to what fct_rooftop is.
const ROOFTOP_5MIN = 'fct_rooftop_5min';
TABLES.set(ROOFTOP_5MIN, new Map(['REGIONID', 'date', 'time', 'mw'].map(n => [n, TABLES.get('fct_rooftop').get(n)])));
RELS.push(...RELS.filter(r => r.from === 'fct_rooftop').map(r => ({ ...r, view: null, from: ROOFTOP_5MIN })));
// A measure whose DAX picks its table: IF([Reads 5 minutes], the 5-minute table, the daily
// one). Here it is the first: the page filters the fact's own date column, which is what
// makes [Reads 5 minutes] true in DAX, and names the daily table itself when it wants it.
const READS_5_MINUTES = /^Reads 5 minutes/;

const JOINS = RELS.filter(r => r.view).map(r => ({ view: r.view, tables: new Set([r.from, r.to]) }));
function viewOf(tables) {
  const names = [...tables];
  if (names.length === 1) return `v_${names[0]}`;
  const join = JOINS.find(j => names.every(n => j.tables.has(n)));
  if (!join) throw new Error(`DAX: no relationship holds ${names.join(', ')} together`);
  return join.view;
}
function column(table, name) {
  const c = TABLES.get(table)?.get(name);
  if (!c) throw new Error(`DAX: the model has no ${table}[${name}]`);
  return c;
}
// The key of a dimension (dim_calendar[date], dim_time[time], dim_region[Region],
// dim_duid[DUID]) is the fact's own column: no join for it. Which column is known once the
// query's tables are, so it is written as KEY$dim$column and settled in select(). Reached
// through another dimension (the region of a unit's fact), that dimension is joined.
const isKey = (table, name) => RELS.some(r => r.to === table && r.toColumn === name);
function keyColumn(r, dim, name) {
  const direct = RELS.find(x => x.to === dim && x.toColumn === name && r.tables.has(x.from));
  if (direct) return direct.fromColumn;
  if (r.tables.has(dim) || !r.tables.size) { r.tables.add(dim); return name; }
  const via = RELS.find(x => x.to === dim && x.toColumn === name && RELS.some(y => y.to === x.from && r.tables.has(y.from)));
  if (!via) throw new Error(`DAX: nothing relates ${[...r.tables].join(', ')} to ${dim}`);
  r.tables.add(via.from);
  return via.fromColumn;
}

// One expression. `cx` says what a name means here: `col` a model column, `ref` a [column] of
// the table being built, `names` the variables in scope, `touch` notes a table that an
// iterator runs over, and `filter` is what CALCULATE put on the aggregates. A [Name] that is
// not such a column is a measure of the model, written out in its place.
function scalar(e, cx) {
  const go = x => scalar(x, cx);
  switch (e.k) {
    case 'num': return atom(e.v, e.v.includes('.') ? 'double' : 'int');
    case 'str': return atom(lit(e.v), 'string');
    case 'date': return atom(`DATE ${lit(e.v)}`, 'date');
    case 'paren': { const x = go(e.e); return atom(`(${x.s})`, x.t); }
    case 'neg': { const x = go(e.e); return { s: `-${par(x, P.atom)}`, t: x.t, p: P.mul }; }
    case 'not': {
      if (isCall(e.e, 'ISBLANK')) return { s: `${par(go(e.e.args[0]), P.cat)} IS NOT NULL`, t: 'bool', p: P.cmp };
      return { s: `NOT ${par(go(e.e), P.cmp)}`, t: 'bool', p: P.not };
    }
    case 'in': return { s: `${par(go(e.e), P.cat)} IN (${e.list.map(x => go(x).s).join(', ')})`, t: 'bool', p: P.cmp };
    case 'col': return cx.col(e.table, e.name);
    case 'ref': {
      const c = cx.ref?.(e.name);
      if (c) return c;
      if (!MEASURE_DAX.has(e.name)) throw new Error(`DAX: there is no column or measure [${e.name}] here`);
      if (e.name === 'Rooftop MW') {
        cx.touch(ROOFTOP_5MIN);
        cx.state.agg = true;
        return atom(cx.filter ? `SUM(t.mw) FILTER (WHERE ${cx.filter})` : 'SUM(t.mw)', 'double');
      }
      return scalar(measure(e.name), cx);
    }
    case 'name': {
      const n = cx.names.get(e.name);
      if (n?.lazy) return scalar(n.lazy, cx);
      if (n?.s == null) throw new Error(`DAX: ${e.name} is not a value here`);
      return n;
    }
    // The variables of a measure, translated where they are used: one that is not used (the
    // days the daily table lacks, in a measure read at 5 minutes) is never looked at.
    case 'var': {
      const names = new Map(cx.names);
      for (const d of e.defs) names.set(d.name, { lazy: d.e });
      return scalar(e.body, { ...cx, names });
    }
    case 'bin': {
      const l = go(e.l), r = go(e.r);
      if (e.op === '&') {
        const str = x => x.t === 'string' ? par(x, P.cat) : `CAST(${x.s} AS VARCHAR)`;
        return { s: `${str(l)} || ${str(r)}`, t: 'string', p: P.cat };
      }
      const [sym, p, bool] = OPS[e.op];
      const t = bool ? 'bool' : e.op !== '/' && l.t === 'int' && r.t === 'int' ? 'int' : 'double';
      return { s: `${par(l, p)} ${sym} ${par(r, p <= P.and ? p : p + 1)}`, t, p };
    }
    case 'call': return call(e, cx);
  }
  throw new Error(`DAX: a ${e.k} is not a value`);
}

function call(e, cx) {
  const fn = e.fn.toUpperCase(), a = e.args, arg = i => scalar(a[i], cx);
  const agg = (s, t) => { cx.state.agg = true; return atom(cx.filter ? `${s} FILTER (WHERE ${cx.filter})` : s, t); };
  const over = x => { if (x?.k === 'name' && TABLES.has(x.name)) cx.touch(x.name); };
  const when = pairs => `CASE ${pairs.map(([c, v]) => `WHEN ${c} THEN ${v}`).join(' ')}`;
  switch (fn) {
    case 'TRUE': return atom('TRUE', 'bool');
    case 'FALSE': return atom('FALSE', 'bool');
    case 'BLANK': return atom('NULL', null);
    case 'SUM': return agg(`SUM(${arg(0).s})`, 'double');
    case 'AVERAGE': return agg(`AVG(${arg(0).s})`, 'double');
    case 'COUNT': return agg(`COUNT(${arg(0).s})`, 'int');
    case 'DISTINCTCOUNT': return agg(`COUNT(DISTINCT ${arg(0).s})`, 'int');
    case 'MIN': case 'MAX': {
      if (a.length === 2) return atom(`${fn === 'MAX' ? 'GREATEST' : 'LEAST'}(${arg(0).s}, ${arg(1).s})`, 'double');
      const x = arg(0);
      return agg(`${fn}(${x.s})`, x.t);
    }
    case 'SELECTEDVALUE': { const x = arg(0); return agg(`ANY_VALUE(${x.s})`, x.t); }
    case 'SUMX': over(a[0]); return agg(`SUM(${arg(1).s})`, 'double');
    case 'AVERAGEX': over(a[0]); return agg(`AVG(${arg(1).s})`, 'double');
    case 'MINX': case 'MAXX': { over(a[0]); const x = arg(1); return agg(`${fn.slice(0, 3)}(${x.s})`, x.t); }
    case 'CONCATENATEX': over(a[0]); return agg(`string_agg(${arg(1).s}, ${arg(2).s})`, 'string');
    case 'COUNTROWS': {
      if (isCall(a[0], 'SUMMARIZE')) {
        over(a[0].args[0]);
        const cols = a[0].args.slice(1).map(c => scalar(c, cx).s);
        return agg(`COUNT(DISTINCT ${cols.length > 1 ? `(${cols.join(', ')})` : cols[0]})`, 'int');
      }
      over(a[0]);
      return agg('COUNT(*)', 'int');
    }
    case 'DIVIDE': return { s: `${par(arg(0), P.mul)} / NULLIF(${arg(1).s}, 0)`, t: 'double', p: P.mul };
    case 'IF': {
      if (a[0].k === 'ref' && READS_5_MINUTES.test(a[0].name)) return arg(1);
      const v = arg(1);
      return atom(`${when([[arg(0).s, v.s]])}${a[2] ? ` ELSE ${arg(2).s}` : ''} END`, v.t);
    }
    case 'SWITCH': {
      if (!isCall(a[0], 'TRUE')) throw new Error('DAX: SWITCH is supported as SWITCH(TRUE(), ...)');
      const rest = a.slice(1).map(x => scalar(x, cx)), pairs = [];
      while (rest.length > 1) pairs.push([rest.shift().s, rest[0].s, rest.shift().t]);
      return atom(`${when(pairs)}${rest.length ? ` ELSE ${rest[0].s}` : ''} END`, pairs[0][2]);
    }
    case 'COALESCE': { const xs = a.map(x => scalar(x, cx)); return atom(`COALESCE(${xs.map(x => x.s).join(', ')})`, xs[0].t); }
    case 'ISBLANK': return { s: `${par(arg(0), P.cat)} IS NULL`, t: 'bool', p: P.cmp };
    case 'RELATED': return arg(0);
    case 'ABS': { const x = arg(0); return atom(`abs(${x.s})`, x.t); }
    case 'ROUND': return a[1].v === '0' ? atom(`CAST(ROUND(${arg(0).s}) AS INTEGER)`, 'int') : atom(`ROUND(${arg(0).s}, ${arg(1).s})`, 'double');
    case 'CONVERT': {
      const to = a[1].name?.toUpperCase();
      if (to !== 'INTEGER' && to !== 'DOUBLE') throw new Error('DAX: CONVERT is supported to INTEGER and DOUBLE');
      return atom(`CAST(${arg(0).s} AS ${to})`, to === 'INTEGER' ? 'int' : 'double');
    }
    case 'QUOTIENT': return { s: `${par(arg(0), P.mul)} // ${par(arg(1), P.mul + 1)}`, t: 'int', p: P.mul };
    case 'DATE': {
      // The first of the month, the one date the page builds.
      const [y, m, d] = a, same = JSON.stringify(y.args?.[0]) === JSON.stringify(m.args?.[0]);
      if (!isCall(y, 'YEAR') || !isCall(m, 'MONTH') || !same || d.v !== '1') throw new Error('DAX: DATE is supported as DATE(YEAR(x), MONTH(x), 1)');
      return atom(`CAST(date_trunc('month', ${scalar(y.args[0], cx).s}) AS DATE)`, 'date');
    }
    case 'CALCULATE': {
      const filters = a.slice(1).map(x => par(scalar(x, { ...cx, filter: null }), P.and));
      return scalar(a[0], { ...cx, filter: [cx.filter, ...filters].filter(Boolean).join(' AND ') });
    }
  }
  throw new Error(`DAX: ${e.fn} is not supported`);
}

// A table expression, as the parts of one SELECT read as `t`. `cols` are its columns in
// order (`sql` over the rows read, `agg` if aggregated); `tables` are the model tables it
// names, which pick the view, unless `from` says what it reads (a subquery or a CTE).
// `group` is null until it aggregates.
const rel = o => ({ cols: [], tables: new Set(), from: null, where: [], group: null, sets: null, having: [],
  distinct: false, order: [], limit: null, ...o });
const derived = c => ({ name: c.name, sql: `t.${c.name}`, type: c.type, p: P.atom });
const named = (name, x) => ({ name, sql: x.s, type: x.t, p: x.p, agg: x.agg });
const wrap = r => rel({ from: `(${select(r, true)})`, cols: r.cols.map(derived) });

function emit(e, r, q, names = q.names) {
  const state = { agg: false };
  const x = scalar(e, { state, names, filter: null,
    touch: t => r.tables.add(t),
    col(table, name) {
      const c = column(table, name);
      if (r.from) throw new Error(`DAX: ${table}[${name}] cannot be read from a derived table; name its column`);
      if (isKey(table, name)) return atom(`t.KEY$${table}$${name}`, c.type);
      r.tables.add(table);
      return atom(`t.${name}`, c.type);
    },
    ref(name) {
      const c = r.cols.find(c => c.name === name);
      if (!c) return null;
      if (c.agg) state.agg = true;
      return { s: c.sql, t: c.type, p: c.p };
    } });
  return { ...x, agg: state.agg };
}

// A filter argument of CALCULATETABLE or CALCULATE, as a condition on the rows read.
function condition(f, r, q) {
  if (!isCall(f, 'TREATAS')) return par(emit(f, r, q), P.and);
  const values = table(f.args[0], q);
  values.distinct = false;   // IN does not need it
  return `${emit(f.args[1], r, q).s} IN (${select(values, true)})`;
}

// The value of an expression on its own, as a scalar subquery: a VAR that is not a table.
function subquery(e, q) {
  const r = rel({ group: [] });
  const [inner, ...filters] = isCall(e, 'CALCULATE') ? e.args : [e];
  const x = emit(inner, r, q);
  for (const f of filters) r.where.push(condition(f, r, q));
  r.cols = [{ sql: x.s, type: x.t, p: x.p }];
  return atom(`(${select(r, true)})`, x.t);
}

const TABLE_FNS = new Set(['SUMMARIZECOLUMNS', 'ROW', 'VALUES', 'DISTINCT', 'CALCULATETABLE', 'FILTER',
  'SELECTCOLUMNS', 'GROUPBY', 'UNION', 'TOPN']);
const isTable = (e, q) => e.k === 'call' ? TABLE_FNS.has(e.fn.toUpperCase())
  : e.k === 'name' && (TABLES.has(e.name) || !!q.names.get(e.name)?.rel);
const sortKey = (e, r) => {
  const c = e.k === 'ref' ? r.cols.find(c => c.name === e.name)
    : r.cols.find(c => c.sql === `t.${e.name}`) ?? r.cols.find(c => c.name === e.name);
  if (!c) throw new Error(`DAX: cannot order by ${e.name}: it is not a column of the result`);
  return c.name;
};

function table(e, q) {
  if (e.k === 'paren') return table(e.e, q);
  if (e.k === 'var') {
    for (const d of e.defs) {
      if (isTable(d.e, q)) {
        const r = table(d.e, q);
        q.ctes.push(`${d.name} AS MATERIALIZED (${select(r, true)})`);
        q.names.set(d.name, { rel: r });
      } else q.names.set(d.name, subquery(d.e, q));
    }
    return table(e.body, q);
  }
  if (e.k === 'name') {
    const cte = q.names.get(e.name)?.rel;
    if (cte) return rel({ from: e.name, cols: cte.cols.map(derived) });
    if (!TABLES.has(e.name)) throw new Error(`DAX: the model has no table ${e.name}`);
    return rel({ tables: new Set([e.name]), cols: [...TABLES.get(e.name).values()].map(derived) });
  }
  if (e.k !== 'call') throw new Error(`DAX: a ${e.k} is not a table`);
  const a = e.args;
  // "name", expression, "name", expression, ... from argument `from` on.
  const pairs = from => {
    const out = [];
    for (let i = from; i < a.length; i += 2) {
      if (a[i].k !== 'str' || !a[i + 1]) throw new Error(`DAX: ${e.fn} expects "name", expression pairs`);
      out.push([a[i].v, a[i + 1]]);
    }
    return out;
  };
  switch (e.fn.toUpperCase()) {
    case 'SUMMARIZECOLUMNS': {
      const r = rel({ group: [] }), plain = [], rolled = [], flags = [];
      let i = 0;
      for (; i < a.length && a[i].k !== 'str'; i++) {
        if (a[i].k === 'col') plain.push(a[i]);
        else if (isCall(a[i], 'ROLLUPADDISSUBTOTAL')) {
          const [g, flag] = a[i].args, cols = isCall(g, 'ROLLUPGROUP') ? g.args : [g];
          rolled.push(...cols);
          flags.push({ name: flag.v, first: cols[0], type: 'bool', p: P.cmp, agg: true });
        } else throw new Error('DAX: SUMMARIZECOLUMNS groups by columns; filters go in CALCULATETABLE');
      }
      const key = c => ({ ...named(c.name, emit(c, r, q)), agg: false });
      const keys = plain.map(key), rollup = rolled.map(key);
      for (const f of flags) f.sql = `GROUPING(${key(f.first).sql}) = 1`;
      r.group = [...keys, ...rollup].map(c => c.sql);
      if (rollup.length) r.sets = `(${r.group.join(', ')}), (${keys.map(c => c.sql).join(', ')})`;
      r.cols = [...keys, ...rollup, ...flags, ...pairs(i).map(([n, x]) => named(n, emit(x, r, q)))];
      return r;
    }
    case 'ROW': {
      const r = rel({ group: [] });
      r.cols = pairs(0).map(([n, x]) => named(n, emit(x, r, q)));
      return r;
    }
    case 'VALUES': case 'DISTINCT': {
      const r = rel({ distinct: true });
      r.cols = [named(a[0].name, emit(a[0], r, q))];
      return r;
    }
    case 'CALCULATETABLE': {
      const r = table(a[0], q);
      for (const f of a.slice(1)) r.where.push(condition(f, r, q));
      return r;
    }
    case 'FILTER': {
      const r = table(a[0], q);
      (r.group ? r.having : r.where).push(par(emit(a[1], r, q), P.and));
      return r;
    }
    case 'SELECTCOLUMNS': {
      const r = table(a[0], q);
      r.cols = pairs(1).map(([n, x]) => named(n, emit(x, r, q)));
      return r;
    }
    case 'GROUPBY': {
      let r = table(a[0], q), i = 1;
      if (r.group || r.distinct || r.limit != null) r = wrap(r);
      const keys = [];
      for (; i < a.length && a[i].k === 'ref'; i++) {
        const c = r.cols.find(c => c.name === a[i].name);
        if (!c) throw new Error(`DAX: GROUPBY has no column [${a[i].name}] to group by`);
        keys.push({ ...c, agg: false });
      }
      const measures = pairs(i).map(([n, x]) => named(n, emit(x, r, q)));
      r.group = keys.map(c => c.sql);
      r.cols = [...keys, ...measures];
      return r;
    }
    case 'UNION': {
      const parts = a.map(x => table(x, q));
      return rel({ from: `(${parts.map(p => select(p, true)).join(' UNION ALL ')})`, cols: parts[0].cols.map(derived) });
    }
    case 'TOPN': {
      const r = table(a[1], q);
      r.order = [{ name: sortKey(a[2], r), desc: a[3]?.name?.toUpperCase() === 'DESC' }];
      r.limit = +a[0].v;
      return r;
    }
  }
  throw new Error(`DAX: ${e.fn} is not a table function this compiler knows`);
}

// The SELECT of a table expression. `raw` leaves the values as they are (a subquery, a
// CTE); the result of a query is cast for the browser instead.
function select(r, raw) {
  const out = c => {
    const s = raw ? c.sql
      : c.type === 'date' ? `CAST(${c.sql} AS VARCHAR)` : c.type === 'int' ? `CAST(${c.sql} AS INTEGER)`
      : c.type === 'double' ? `${/^t\.\w+$/.test(c.sql) ? c.sql : `(${c.sql})`}::DOUBLE` : c.sql;
    return !c.name || s === `t.${c.name}` ? s : `${s} AS ${c.name}`;
  };
  const parts = [
    `SELECT ${r.distinct ? 'DISTINCT ' : ''}${r.cols.map(out).join(', ')}`,
    r.where.length && `WHERE ${r.where.join(' AND ')}`,
    r.group?.length && (r.sets ? `GROUP BY GROUPING SETS (${r.sets})` : `GROUP BY ${r.group.join(', ')}`),
    r.having.length && `HAVING ${r.having.join(' AND ')}`,
    r.order.length && `ORDER BY ${r.order.map(o => o.name + (o.desc ? ' DESC' : '')).join(', ')}`,
    r.limit != null && `LIMIT ${r.limit}`,
  ].filter(Boolean);
  // The keys of dimensions first: one of them can add a table, and the tables pick the view.
  const settled = new Map();
  for (const k of new Set(parts.join(' ').match(/KEY\$\w+\$\w+/g) || [])) settled.set(k, keyColumn(r, ...k.split('$').slice(1)));
  parts.splice(1, 0, `FROM ${r.from ?? viewOf(r.tables)} t`);
  return parts.join(' ').replace(/KEY\$\w+\$\w+/g, k => settled.get(k));
}

// A DAX query as SQL. The same text is translated once.
const _translated = new Map();
export function toSQL(dax) {
  let sql = _translated.get(dax);
  if (sql) return sql;
  const { e, order } = parse(dax).query();
  const q = { names: new Map(), ctes: [] };
  const r = table(e, q);
  if (order.length) r.order = order.map(o => ({ name: sortKey(o.e, r), desc: o.desc }));
  sql = (q.ctes.length ? `WITH ${q.ctes.join(', ')} ` : '') + select(r, false);
  if (_translated.size >= 500) _translated.clear();
  _translated.set(dax, sql);
  return sql;
}
const isDax = q => /^\s*EVALUATE\b/i.test(q);

// =============================================================================
// The model -> views
// =============================================================================

// A table of the model is a table of the lakehouse, copied into the files as it is
// (scripts/copy_catalog.py): whole in `dim` or `agg`, or split by date over `today` (the
// newest days, refreshed every 30 minutes) and the half-year files. v_<table> is that table
// over what is attached; where two files hold a day, `today` has it. One split table is also
// whole in `agg` (fct_rooftop: the daily charts read it over any range, with no half-year
// attached): its older days are then read from there.
const ENTITIES = MODEL.tables.map(t => ({ name: `v_${t.name}`, table: t.partitions[0].source.entityName }));
const RELATIONSHIPS = RELS.filter(r => r.view).map(r => ({ name: r.view, from: `v_${r.from}`, to: `v_${r.to}`, on: [r.fromColumn, r.toColumn] }));
// [Rooftop MW] in SQL: a half hour and the five times after it, on the straight line to the
// next half hour. A time between two half hours exists only if both do; nothing is carried
// forward. A half hour and its five times are on one date, so a filter on date reaches the scan.
const MINUTE = '(time // 100) * 60 + time % 100', HHMM = m => `CAST((${m}) // 60 * 100 + (${m}) % 60 AS INTEGER)`;
const ROOFTOP = { name: `v_${ROOFTOP_5MIN}`, reads: 'v_fct_rooftop', sql: `
  SELECT a.REGIONID, a.date, ${HHMM('a.minute + 5 * s.step')} AS time,
    CAST(CASE WHEN s.step = 0 THEN a.mw ELSE a.mw + (b.mw - a.mw) * s.step / 6.0 END AS DOUBLE) AS mw
  FROM (SELECT *, ${MINUTE} AS minute FROM v_fct_rooftop) a
  CROSS JOIN range(6) s(step)
  LEFT JOIN v_fct_rooftop b ON b.REGIONID = a.REGIONID
    AND b.date = CASE WHEN a.minute = 1410 THEN a.date + 1 ELSE a.date END
    AND b.time = CASE WHEN a.minute = 1410 THEN 0 ELSE ${HHMM('a.minute + 30')} END
  WHERE s.step = 0 OR b.mw IS NOT NULL` };
// In the order they are created: every view after the ones it reads.
const ITEMS = [...ENTITIES, ...RELATIONSHIPS, ROOFTOP];
const PERIOD = /^p\d{4}_h[12]$/;
const mentions = (s, name) => new RegExp(`\\b${name}\\b`, 'i').test(s);

export function createModel(data) {
  // The views that exist by now, name -> { cols }, and what each needs attached to hold all
  // its rows: the half-year files of a date range (`history`) or the aggregates (`agg`).
  let _views = new Map(), _requires = new Map();
  let _recentFrom = null;    // the first day `today` holds
  const _sent = new Map();   // statement name -> the SQL last run for it

  // Columns of every attached table, by `<db>.<table>`.
  async function catalog() {
    const r = await data.query(`SELECT table_catalog || '.' || table_name AS t, column_name AS c
      FROM information_schema.columns WHERE table_catalog <> current_database()`);
    const tables = new Map();
    for (const { t, c } of r.toArray()) {
      if (!tables.has(t)) tables.set(t, new Set());
      tables.get(t).add(c);
    }
    return tables;
  }

  // The SELECT of one view over what is attached, or null if it cannot exist yet.
  function build(item, tables, views) {
    if (item.table) {
      const dbs = [...tables.keys()].filter(t => t.endsWith(`.${item.table}`)).map(t => t.split('.')[0]);
      const read = db => `SELECT * FROM ${db}.${item.table}`;
      const periods = dbs.filter(db => PERIOD.test(db)).sort(), recent = dbs.includes('today');
      const requires = new Set(recent ? ['history'] : dbs.includes('dim') ? [] : ['agg']);
      if (!dbs.length) return { requires };
      const older = recent && dbs.includes('agg') ? ['agg'] : periods;
      const sql = recent && older.length
        ? `SELECT * FROM (${older.map(read).join(' UNION ALL ')}) WHERE date < DATE '${_recentFrom}' UNION ALL ${read('today')}`
        : dbs.sort().map(read).join(' UNION ALL ');
      return { sql, cols: tables.get(`${dbs[0]}.${item.table}`), requires };
    }
    if (item.to) {
      const from = views.get(item.from), to = views.get(item.to);
      const requires = new Set([..._requires.get(item.from), ..._requires.get(item.to)]);
      if (!from || !to) return { requires };
      const [l, r] = item.on, fields = [...to.cols].filter(c => c !== r && !from.cols.has(c));
      return { sql: `SELECT f.*, ${fields.map(c => `d.${c}`).join(', ')} FROM ${item.from} f LEFT JOIN ${item.to} d ON f.${l} = d.${r}`,
        cols: new Set([...from.cols, ...fields]), requires };
    }
    return { sql: views.has(item.reads) && item.sql, cols: null, requires: _requires.get(item.reads) };
  }

  // Creates what the model describes over what is attached by now: the statements that are
  // new or changed since the last compile, as one query. One compile at a time.
  let _compiling = Promise.resolve();
  const compile = () => _compiling = _compiling.catch(() => {}).then(async () => {
    const tables = await catalog();
    // A literal in the views, not a subquery: a query inside `today`'s days then reads no
    // half-year at all (40 ms against 98 for three days of one region).
    _recentFrom ??= (await data.query(`SELECT CAST(MIN(date) AS VARCHAR) AS d FROM today.fct_region`)).toArray()[0].d;
    const views = new Map();
    const statements = [];
    _requires = new Map();
    for (const item of ITEMS) {
      const view = build(item, tables, views);
      _requires.set(item.name, view.requires);
      if (!view.sql) continue;
      views.set(item.name, view);
      statements.push([item.name, `CREATE OR REPLACE VIEW ${item.name} AS ${view.sql}`]);
    }
    const changed = statements.filter(([name, s]) => _sent.get(name) !== s);
    if (changed.length) await data.query(changed.map(([, s]) => s).join(';\n'));
    for (const [name, s] of changed) _sent.set(name, s);
    _views = views;
  });

  return {
    async init() {
      const res = await data.init();
      await compile();
      return res;
    },
    async attachAgg() {
      await data.attachAgg();
      await compile();
    },
    // True if more history was attached: results the caller cached are stale. A range that
    // starts inside the days `today` holds is read from it alone, so nothing is attached for
    // it: that is the default "Last 3 days" view.
    async ensureHistory(from, to, msg) {
      if (from >= _recentFrom) return false;
      const changed = await data.ensureHistory(from, to, msg);
      if (changed) await compile();
      return changed;
    },
    // Whether a view exists and, given a column, whether it has it.
    has: (view, column) => {
      const v = _views.get(view);
      return !!v && (!column || !v.cols || v.cols.has(column));
    },
    // A DAX query (it starts with EVALUATE) is translated; SQL goes as it is.
    query: async q => data.query(isDax(q) ? toSQL(q) : q),
    toSQL,
    // What a SQL query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the aggregates (attachAgg).
    needs: q => {
      const reads = kind => ITEMS.some(i => _requires.get(i.name)?.has(kind) && mentions(q, i.name));
      return { history: reads('history'), agg: reads('agg') };
    },
  };
}
