// =============================================================================
// compiler.js — compiles the semantic model (model.bim) into DuckDB views, and the page's
// DAX queries into SQL over them
// =============================================================================
// The layers of the dashboard, and what stands in each place in a real product:
//   consumer        index.html                 the BI tool
//   query language  DAX                        DAX, MDX, VizQL, Malloy, a metrics request
//   semantic model  model.bim (TMSL)           a Tabular model, LookML, MetricFlow YAML
//   compiler        this file                  Power BI's query service and formula engine,
//                                              MetricFlow, Cube
//   engine          DuckDB-WASM                the warehouse, VertiPaq, Hyper
//   storage         ../storage/data.js         the lakehouse or warehouse connection
//
// The model is the repo's semantic_model/model.bim, the file Power BI runs in Direct Lake:
// it holds DAX only, and nothing in it is written for this compiler. The builds put it next
// to this file.
//
// This compiler is a toy, on purpose: an example of where that layer sits, not a DAX
// engine. It knows the constructs the page uses and throws on anything
// else; what it cannot translate has its equivalent SQL written here, as a fixed case. A
// blank is a NULL. Its rows are DAX's: SUMMARIZECOLUMNS leaves out a group whose measures
// are all blank, and TOPN keeps the rows tied with the last one. There is no filter
// context: a filter is a boolean argument of CALCULATETABLE or CALCULATE, and becomes a
// WHERE. It is checked against the model itself: scripts/parity runs the page's queries
// through both and compares the rows (deploy_model.yml).
//
// Where its SQL is not DAX, knowingly (each is a difference the parity check would show if
// a query of the page reached it):
//   - a CALCULATE filter is ANDed with the query's filters on the same column, where DAX
//     replaces them (KEEPFILTERS is what it always does); DATESBETWEEN is the exception
//   - BLANK + x is NULL here and x in DAX; COUNT of no rows is blank in both (NULLIF)
//   - ISFILTERED counts a column the query groups by as filtered on its subtotal row too
//   - RELATED(x) is x: the view already has the column
//   - a subquery (a measure of another table, ALLSELECTED, DATESBETWEEN) that is blank for
//     a group is 0 (COALESCE), as DAX adds it
//   - ORDER BY puts NULLs last; DAX puts blanks first
//   - every relationship view is a LEFT JOIN, whatever relyOnReferentialIntegrity says
//   - a subquery is grouped only by the keys that reach its table forwards: [Hours] per
//     unit is the hours of all the regions selected (every region has every interval)
//   - a dimension's key is read off the fact's column: a fact key the dimension lacks is a
//     group of its own here, and DAX's one blank row there
//   - a blank in a comparison is NULL (<, =, IN), where DAX reads 0, FALSE or "": so
//     dim_duid[Storage] = FALSE() leaves out the units the dimension lacks, [No flow] with
//     a blank limit is 0 not 1, and NOT (x IN {..}) leaves out a blank x, which DAX keeps
//   - text compares and groups case-sensitively; DAX does neither (dim_duid keeps one
//     spelling per name for that reason)
//   - "the days the daily table lacks are none" is taken for both daily tables at once: a
//     range cut to one table's days (queries.wholeDays) can still lack the other's newest
//     day, and the 5-minute rows DAX adds for it are 0 here (demand's rooftop beyond 30
//     days, on a day fct_region_daily has and fct_summary_daily not yet)
//
// Part 1, the model. What model.bim holds and what each entry becomes:
//   tables               a view each, v_<table>: the table of the lakehouse its partition
//                        names, over the files that are attached (see "The model -> views")
//   relationships        a view each, under the relationship's name: the `from` side LEFT JOIN
//                        the `to` side, with the columns of `to`
//   measures             nothing of their own: a measure is DAX, written out where a query
//                        names it ([Capture price]), so a CALCULATE around it reaches its
//                        aggregates. A measure that picks its table (5 minutes or days)
//                        picks it here as in Power BI, from what the query filters. A
//                        measure of another table than the one the SELECT is about ([Hours]
//                        inside [Capacity factor]) is a subquery of its own, under the
//                        filters that reach its table. Fixed cases: the days the daily
//                        table lacks (none); [Units] off the daily table; and
//                        [Capacity MW], the units that have rows, in two levels
//   bothDirections       a filter on the `from` table reaches the tables of the `to` side
//                        as the keys its rows have: a unit filter on a regional table is
//                        REGIONID IN (SELECT Region FROM v_dim_duid WHERE ...)
//   a fact and two of    one more view, <fact>_star: the fact LEFT JOIN each of them
//
// Part 2, the queries. The page sends a query of the model's fields (toDax, which lists its
// words); it becomes DAX, and the DAX one SELECT over those views (toSQL):
//   SUMMARIZECOLUMNS, ROW             an aggregate; ROLLUPADDISSUBTOTAL is GROUPING SETS;
//                                     HAVING drops a group whose measures are all NULL
//   CALCULATETABLE(t, filters)        WHERE
//   SELECTCOLUMNS                     a projection
//   FILTER                            HAVING on an aggregate, WHERE on rows
//   TOPN                              QUALIFY RANK() <= n: ties at the cut are kept;
//                                     descending unless ASC
//   ORDER BY                          ORDER BY
//   [Name]                            a column of the table being built, else a measure
// and in the measures of the model:
//   CALCULATE(measure, filter)        the aggregates of the measure with FILTER (WHERE ..)
//   CALCULATE(m, ALLSELECTED(table))  m over all the query selects, not grouped by the
//                                     table's columns: a window over the groups when m is
//                                     a sum of its own table, else a subquery
//   CALCULATE(m, DATESBETWEEN(..))    m over those days instead of the query's: a subquery,
//                                     the days worked out here from the query's own range
//                                     (MIN and MAX of dim_calendar[date], DATEDIFF in days)
//   KEEPFILTERS(filter)               the filter: here filters only ever add up
//   VAR                               written out where it is used
//   ISFILTERED, ISCROSSFILTERED       true or false, from the columns the query names; an IF
//                                     on one keeps the side it picks
// Those are all the cases, and the words of a query and the cases for the measures are the
// owner's to add to, not a page's or an agent's.
// Which view a query reads is decided here, from the tables it names: `fct_summary` alone
// reads v_fct_summary, with a column of `dim_duid` the relationship's view. So a query that
// needs nothing about the unit pays for no join, with no rule for the author to remember.
// The key of a dimension is read off the fact's own column, with no join.
// What comes back is cast by the column's dataType, as the browser wants it: a date as text,
// a whole number as INTEGER, a number as DOUBLE.
//
// createModel(data) wraps a data source (../storage/data.js: init, attachAgg, ensureHistory,
// query) and has its members plus `has`, `needs`, `toDax` and `toSQL`; `query` takes the
// page's query (an object) or SQL, never DAX text. It compiles the model after every attach, reading what is attached
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
      if (eat('(')) {
        const a = args(')');
        // In DAX it stops a filter replacing the ones around it; here none ever does.
        return t.v.toUpperCase() === 'KEEPFILTERS' ? a[0] : { k: 'call', fn: t.v, args: a };
      }
      return { k: 'name', name: t.v };
    }
    i--;
    throw new Error(`DAX: unexpected ${here()}`);
  }
  const unary = () => eat('-') ? { k: 'neg', e: unary() } : primary();
  const mul = chain(unary, ['*', '/']), add = chain(mul, ['+', '-']);
  function cmp() {
    const l = add(), o = ['=', '<>', '<=', '>=', '<', '>'].find(x => op(x));
    if (o) { i++; return { k: 'bin', op: o, l, r: add() }; }
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
// The table a measure is defined on: the one whose rows it is about.
const HOME = new Map(MODEL.tables.flatMap(t => (t.measures || []).map(m => [m.name, t.name])));
const RELS = MODEL.relationships.map(r => ({ view: r.name, from: r.fromTable, fromColumn: r.fromColumn, to: r.toTable, toColumn: r.toColumn,
  both: r.crossFilteringBehavior === 'bothDirections' }));
// A measure whose DAX picks its table: IF([Reads 5 minutes], the 5-minute table, the daily
// one), where [Reads 5 minutes] asks whether a column is filtered (ISFILTERED,
// ISCROSSFILTERED). That is answered from the query, as the DAX says: the columns its keys
// and filters name around the measure (`scope`). So the page picks the side the way a
// report does: it filters the fact's own date for 5 minutes, dim_calendar's for the days.
function colsIn(e, out = []) {
  if (!e || typeof e !== 'object') return out;
  if (e.k === 'col') out.push(e);
  else for (const x of [e.e, e.l, e.r, e.body, ...(e.args ?? []), ...(e.list ?? []), ...(e.items ?? []), ...(e.defs ?? [])]) colsIn(x, out);
  return out;
}
// What a condition is, when the query alone says: true, false, or undefined.
function known(e, cx) {
  if (e.k === 'paren') return known(e.e, cx);
  if (e.k === 'ref') return MEASURE_DAX.has(e.name) && !cx.ref?.(e.name) ? known(measure(e.name), cx) : undefined;
  if (e.k === 'bin' && e.op === '||') {
    const l = known(e.l, cx), r = known(e.r, cx);
    return l === true || r === true ? true : l === false && r === false ? false : undefined;
  }
  if (isCall(e, 'ISFILTERED') || isCall(e, 'ISCROSSFILTERED')) {
    const c = e.args[0], whole = isCall(e, 'ISCROSSFILTERED');
    return cx.scope.some(cols => cols.some(x => x.table === c.table && (whole || x.name === c.name)));
  }
  return undefined;
}
// The days after the newest one the daily table holds, which a measure adds from the
// 5-minute table (`dim_calendar[date] > _last`, `_last` a measure CALCULATE(MAX(...),
// REMOVEFILTERS())): none here. The page reads the daily tables on the days they hold (its
// `wholeDays` filter), which is what makes that set empty in DAX too. A second fact in the
// same SELECT is not something this compiler writes.
const isNewest = e => e?.k === 'ref' && MEASURE_DAX.has(e.name) && (m => isCall(m, 'CALCULATE') && isCall(m.args[0], 'MAX')
  && m.args.length === 2 && isCall(m.args[1], 'REMOVEFILTERS') && !m.args[1].args.length)(measure(e.name));
const isNone = (x, cx) => x.k === 'bin' && x.op === '>' && x.l.k === 'col' && x.l.table === CALENDAR?.table
  && x.l.name === CALENDAR.name && x.r.k === 'name' && isNewest(cx.names.get(x.r.name)?.lazy);

// The keys a scope groups by: a SUMMARIZECOLUMNS's (an array, which has a keys() method of
// its own, hence hasOwn).
const keysOf = s => Object.hasOwn(s, 'keys') ? s.keys : [];
// Days as numbers, for the dates a measure of the days before works out from the query's.
const DAY = 86400000;
const toDays = d => Date.parse(`${d}T00:00:00Z`) / DAY;
const fromDays = n => new Date(n * DAY).toISOString().slice(0, 10);
// The calendar: the dimension whose key is a date. It holds every day, so the first day of a
// range on it is the range's own.
const CALENDAR = MODEL.relationships.map(r => ({ table: r.toTable, name: r.toColumn }))
  .find(c => TABLES.get(c.table)?.get(c.name)?.type === 'date');
// The query's literal bound on the calendar's day (MIN its first, MAX its last), or null:
// not the calendar, no literal range, or grouped by the day.
function bound(col, fn, cx) {
  if (col.table !== CALENDAR?.table || col.name !== CALENDAR.name) return null;
  const scope = cx.q.scope;
  if (scope.flatMap(keysOf).some(k => k.table === col.table && k.name === col.name)) return null;
  let lo = null, hi = null;
  for (const f of scope.flatMap(s => s.filters ?? [])) {
    if (f.k !== 'bin' || f.l.k !== 'col' || f.l.table !== col.table || f.l.name !== col.name || f.r.k !== 'date') continue;
    const d = toDays(f.r.v);
    if (f.op === '>=' || f.op === '=') lo = lo == null ? d : Math.max(lo, d);
    if (f.op === '<=' || f.op === '=') hi = hi == null ? d : Math.min(hi, d);
  }
  return fn === 'MIN' ? lo : hi;
}
// A date of DATESBETWEEN, worked out here: a date, a number of days, + and -, DATEDIFF in
// days, a variable, and the first and last day of the query's range.
function fold(e, cx) {
  switch (e.k) {
    case 'num': return +e.v;
    case 'date': return toDays(e.v);
    case 'paren': return fold(e.e, cx);
    case 'neg': return -fold(e.e, cx);
    case 'name': { const n = cx.names.get(e.name); if (n?.lazy) return fold(n.lazy, cx); break; }
    case 'bin': if (e.op === '+' || e.op === '-') { const l = fold(e.l, cx), r = fold(e.r, cx); return e.op === '+' ? l + r : l - r; } break;
    case 'call': {
      const fn = e.fn.toUpperCase();
      if (fn === 'DATEDIFF' && e.args[2]?.name?.toUpperCase() === 'DAY') return fold(e.args[1], cx) - fold(e.args[0], cx);
      const b = (fn === 'MIN' || fn === 'MAX') && e.args.length === 1 && e.args[0].k === 'col' ? bound(e.args[0], fn, cx) : null;
      if (b != null) return b;
    }
  }
  throw new Error("DAX: the days of DATESBETWEEN have to follow from the query's own range of dates");
}
// DATESBETWEEN(column, a, b) as filters that replace the query's on that column.
function daysBetween(calls, cx) {
  const [col] = calls[0].args;
  if (calls.some(c => c.args[0].table !== col.table || c.args[0].name !== col.name)) throw new Error('DAX: DATESBETWEEN on one column');
  const add = calls.flatMap(c => [
    { k: 'bin', op: '>=', l: col, r: { k: 'date', v: fromDays(fold(c.args[1], cx)) } },
    { k: 'bin', op: '<=', l: col, r: { k: 'date', v: fromDays(fold(c.args[2], cx)) } }]);
  return { on: c => c.table === col.table && c.name === col.name, add };
}

// The tables a filter on which reaches `table`: itself and, along the relationships, its
// dimensions and theirs (a filter on dim_region reaches the units through dim_duid). A
// filter on a fact reaches that fact alone. A relationship that filters both ways
// (crossFilteringBehavior bothDirections) also lets a filter on its `from` side through to
// the tables of its `to` side: dim_duid's to fct_region, through dim_region. `forward` is
// the first kind alone, the tables a SELECT can be joined to.
const _reach = new Map();
function reach(table, forward = false) {
  const k = `${table}|${forward}`;
  if (!_reach.has(k)) {
    const out = new Set([table]);
    const go = t => {
      for (const r of RELS) {
        if (r.from === t && !out.has(r.to)) { out.add(r.to); go(r.to); }
        if (!forward && r.both && r.to === t && !out.has(r.from)) { out.add(r.from); go(r.from); }
      }
    };
    go(table);
    _reach.set(k, out);
  }
  return _reach.get(k);
}
// A filter on a table that reaches the SELECT's only the way back along a relationship
// that filters both ways: the keys of the `to` side that rows of that table have. A unit
// filter on a regional table is its regions: REGIONID IN (SELECT Region FROM v_dim_duid
// WHERE ...), the way DAX filters dim_region from dim_duid.
// The table a filter reaches the SELECT's table only that way, or null when it reaches it
// forwards (or the SELECT reads it).
function backTable(f, r) {
  const tables = new Set(colsIn(f).map(c => c.table));
  const fwd = reach(r.home, true);
  if (!r.home || [...tables].every(t => fwd.has(t) || r.tables.has(t))) return null;
  if (tables.size !== 1) throw new Error(`DAX: a filter on ${[...tables].join(', ')} does not reach ${r.home}`);
  return [...tables][0];
}
// All the query's filters on that table in one list, as DAX filters the table with all of
// them and then carries its rows' keys over. One list per filter (until 2026-10-07) was the
// regions of the Wind units and the regions of the picked units: more regions than the
// picked Wind units are in.
function backward(x, fs, r, q) {
  const bridge = RELS.find(b => b.both && b.from === x && reach(r.home, true).has(b.to));
  if (!bridge) throw new Error(`DAX: a filter on ${x} does not reach ${r.home}`);
  const inner = rel({ tables: new Set([x]), cols: [{ name: 'k', sql: `t.${bridge.fromColumn}` }] });
  for (const f of fs) inner.where.push(condition(f, inner, q));
  return `t.KEY$${bridge.to}$${bridge.toColumn} IN (${select(inner, true)})`;
}
// A measure that lives on another table than the one this SELECT is about: [Hours] (the
// regions') inside [Capacity factor] (the units'), [Month days] inside [Average MW at hour].
// One SELECT reads one fact, so it is a subquery of its own: the measure under the filters
// around it that reach its table, grouped by the keys that do and matched on them. That is
// what the filter context does in DAX: a filter on dim_calendar reaches every fact, one on
// dim_duid or on fct_summary only the units. Blank is 0 here, as DAX adds it.
const elsewhere = (name, cx) => subquery({ k: 'ref', name }, HOME.get(name), cx);
// ALLSELECTED of a measure of this SELECT's own table that is a sum ([Generation MWh]): the
// same groups added up again, a window over them, partitioned by the keys it keeps, the
// subtotal rows left out. One scan instead of the subquery's two (the generation chart of 30
// days with each fuel's share: 2.4 s against 1.3 s without, natively). Anything else (an
// average, a ratio, a measure of another table) is the subquery. A window is worked out
// after HAVING, so the SELECT's conditions on its values become QUALIFY: the share is of
// every group the query has, as in DAX, not of the ones it keeps.
function overShown(e, tables, cx) {
  if (e.k !== 'ref' || HOME.get(e.name) !== cx.r.home || cx.filter || cx.r.unit) return null;
  const scope = cx.q.scope, keys = scope.flatMap(keysOf);
  const rolled = scope.flatMap(s => Object.hasOwn(s, 'rolled') ? s.rolled : []);
  if (rolled.some(k => !tables.has(k.table))) return null;
  const before = cx.r.aggs.length, tables0 = new Set(cx.r.tables), agg0 = cx.state.agg;
  const x = scalar(e, cx), added = cx.r.aggs.slice(before);
  if (!added.length || added.some(a => !/^SUM\(/.test(a)) || /NULLIF\(|SELECT /.test(x.s)) {
    // Not a sum: the SELECT as it was, for the subquery.
    cx.r.aggs.length = before; cx.r.tables = tables0; cx.state.agg = agg0;
    return null;
  }
  const by = keys.filter(k => !tables.has(k.table)).map(k => scalar(k, cx).s);
  const details = rolled.map(k => `GROUPING(${scalar(k, cx).s}) = 0`);
  cx.r.windowed = true;
  const value = details.length ? `CASE WHEN ${details.join(' AND ')} THEN ${x.s} END` : x.s;
  return atom(`SUM(${value}) OVER (${by.length ? `PARTITION BY ${by.join(', ')}` : ''})`, 'double');
}
// The same for a value of the table this SELECT is about, under other filters than the
// query's: `drop` says which of its keys it is not grouped by (ALLSELECTED), `swap` which
// filters are replaced, and by what (DATESBETWEEN).
function subquery(e, home, cx, { drop = () => false, swap = null } = {}) {
  const q = cx.q, to = reach(home), reaches = c => to.has(c.table), fwd = reach(home, true);
  let filters = q.scope.flatMap(s => s.filters ?? []).filter(f => colsIn(f).every(reaches));
  if (swap) filters = [...filters.filter(f => !colsIn(f).some(swap.on)), ...swap.add];
  // Grouped by the keys that reach its table along the relationships, not back along one
  // that filters both ways: [Hours] per unit is the hours of the regions the units are in,
  // which is every region's hours (each region has every interval), and one SELECT cannot
  // group a regional table by a unit. A filter does reach it back, as a list of regions.
  const kept = c => fwd.has(c.table) && !drop(c);
  const keys = q.scope.flatMap(keysOf).filter(kept);
  const name = e.name ?? 'a value';
  if (q.scope.some(s => (s.rolled ?? []).some(kept))) throw new Error(`DAX: [${name}] under a subtotal of a key that reaches it is not supported`);
  const value = [{ k: 'str', v: 'v' }, e];
  const inner = keys.length ? { k: 'call', fn: 'SUMMARIZECOLUMNS', args: [...keys, ...value] } : { k: 'call', fn: 'ROW', args: value };
  // Answered from its own filters and keys, not from the ones that do not reach it.
  const around = q.scope.splice(0);
  let r;
  try { r = table(filters.length ? { k: 'call', fn: 'CALCULATETABLE', args: [inner, ...filters] } : inner, q); }
  finally { q.scope.push(...around); }
  const sql = select(r, true), type = r.cols.at(-1).type;
  cx.state.agg = true;
  // Read once per query, as a CTE: a measure can name it more than once, and matched per
  // row of the result it is then a lookup. Inline, the renewable share per day of the whole
  // history took 1.3 s (2026-10-06), when rooftop's energy was on both sides of it.
  const cte = q.cross.get(sql) ?? q.cross.set(sql, `x${q.cross.size + 1}`).get(sql);
  if (!q.ctes.some(c => c.startsWith(`${cte} AS `))) q.ctes.push(`${cte} AS MATERIALIZED (${sql})`);
  if (!keys.length) return atom(`COALESCE((SELECT v FROM ${cte}), 0)`, type);
  const on = keys.map((k, i) => `s.${r.cols[i].name} = ${scalar(k, cx).s}`);
  return atom(`COALESCE((SELECT s.v FROM ${cte} s WHERE ${on.join(' AND ')}), 0)`, type);
}

const JOINS = RELS.filter(r => r.view).map(r => ({ view: r.view, tables: new Set([r.from, r.to]) }));
// A fact with every dimension it relates to, `<fact>_star`, for a query that reads two of
// them besides the fact: the curtailment of picked units by month reads dim_duid's fuel and
// dim_calendar's year and month. One relationship's view is read when one holds the tables.
const STARS = [...new Set(RELS.filter(r => r.view).map(r => r.from))]
  .map(fact => ({ fact, rels: RELS.filter(r => r.view && r.from === fact) })).filter(s => s.rels.length > 1)
  .map(s => ({ ...s, view: `${s.fact}_star`, tables: new Set([s.fact, ...s.rels.map(r => r.to)]) }));
function viewOf(tables) {
  const names = [...tables];
  if (names.length === 1) return `v_${names[0]}`;
  const join = JOINS.find(j => names.every(n => j.tables.has(n))) ?? STARS.find(j => names.every(n => j.tables.has(n)));
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
      // The first measure a SELECT names says which table it is about.
      cx.r.home ??= HOME.get(e.name);
      if (HOME.get(e.name) !== cx.r.home) return elsewhere(e.name, cx);
      return scalar(measure(e.name), { ...cx, model: true });
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
      // In a measure of the model, <> is DAX's: a blank is not "Grid". (The page's own
      // filters keep SQL's, where a NULL is unequal to nothing: queries.js says `blank`
      // on its own where it means it, as fuelsNotIn does.)
      if (e.op === '<>' && cx.model && (l.t === 'string' || r.t === 'string'))
        return { s: `${par(l, P.cmp + 1)} IS DISTINCT FROM ${par(r, P.cmp + 1)}`, t: 'bool', p: P.cmp };
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
  const agg = (s, t) => {
    cx.state.agg = true;
    const x = cx.filter ? `${s} FILTER (WHERE ${cx.filter})` : s;
    cx.r.aggs.push(x);
    // A count of no rows is blank in DAX and 0 in SQL: a group of nothing is then left out,
    // as SUMMARIZECOLUMNS leaves it out, and a measure over it is blank.
    return atom(/^COUNT\(/.test(s) ? `NULLIF(${x}, 0)` : x, t);
  };
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
      if (a.length === 2) {
        // MAX(column, 0) under a SUMX: the column as DOUBLE. A sum of fixed decimals adds
        // 128-bit integers, and two of them (output and charging) made the generation
        // chart's query twice as slow at 30 days; as doubles it is faster than one was
        // (2026-10-06). The result is cast to DOUBLE for the browser either way.
        const dbl = x => x.t === 'double' && /^t\.\w+$/.test(x.s) ? `CAST(${x.s} AS DOUBLE)` : x.s;
        return atom(`${fn === 'MAX' ? 'GREATEST' : 'LEAST'}(${dbl(arg(0))}, ${dbl(arg(1))})`, 'double');
      }
      // The first or last day of the calendar under the query's own range, when it has one
      // and is not grouped by the day: DAX's MIN(dim_calendar[date]), the calendar holding
      // every day. What a measure of the days before ([... change]) counts from.
      const day = a[0].k === 'col' ? bound(a[0], fn, cx) : null;
      if (day != null) return atom(`DATE ${lit(fromDays(day))}`, 'date');
      const x = arg(0);
      return agg(`${fn}(${x.s})`, x.t);
    }
    case 'ABS': { const x = arg(0); return atom(`ABS(${x.s})`, x.t); }
    case 'DATEDIFF': {
      if (a[2]?.name?.toUpperCase() !== 'DAY') throw new Error('DAX: DATEDIFF is supported in days');
      return atom(`DATE_DIFF('day', ${arg(0).s}, ${arg(1).s})`, 'int');
    }
    case 'SUMX': over(a[0]); return agg(`SUM(${arg(1).s})`, 'double');
    case 'AVERAGEX': over(a[0]); return agg(`AVG(${arg(1).s})`, 'double');
    case 'COUNTROWS': {
      // [Units] off the daily table: its units, and those of the days it lacks (none).
      if (isCall(a[0], 'DISTINCT') && isCall(a[0].args[0], 'UNION')) {
        const [first, ...rest] = a[0].args[0].args;
        if (isCall(first, 'VALUES') && rest.every(x => isCall(x, 'CALCULATETABLE') && x.args.slice(1).some(f => isNone(f, cx))))
          return agg(`COUNT(DISTINCT ${scalar(first.args[0], cx).s})`, 'int');
      }
      if (isCall(a[0], 'SUMMARIZE')) {
        over(a[0].args[0]);
        const cols = a[0].args.slice(1).map(c => scalar(c, cx).s);
        return agg(`COUNT(DISTINCT ${cols.length > 1 ? `(${cols.join(', ')})` : cols[0]})`, 'int');
      }
      over(a[0]);
      return agg('COUNT(*)', 'int');
    }
    case 'DIVIDE': return { s: `${par(arg(0), P.mul)} / NULLIF(${arg(1).s}, 0)`, t: 'double', p: P.mul };
    case 'ISFILTERED': case 'ISCROSSFILTERED': return atom(known(e, cx) ? 'TRUE' : 'FALSE', 'bool');
    case 'IF': {
      // A condition the query settles keeps one side; the other is never translated.
      const is = known(a[0], cx);
      if (is != null) return is ? arg(1) : a[2] ? arg(2) : atom('NULL', null);
      const v = arg(1);
      return atom(`${when([[arg(0).s, v.s]])}${a[2] ? ` ELSE ${arg(2).s}` : ''} END`, v.t);
    }
    case 'COALESCE': { const xs = a.map(x => scalar(x, cx)); return atom(`COALESCE(${xs.map(x => x.s).join(', ')})`, xs[0].t); }
    case 'ISBLANK': return { s: `${par(arg(0), P.cat)} IS NULL`, t: 'bool', p: P.cmp };
    case 'RELATED': return arg(0);
    case 'CONVERT': {
      const to = a[1].name?.toUpperCase();
      if (to !== 'INTEGER' && to !== 'DOUBLE') throw new Error('DAX: CONVERT is supported to INTEGER and DOUBLE');
      return atom(`CAST(${arg(0).s} AS ${to})`, to === 'INTEGER' ? 'int' : 'double');
    }
    case 'CALCULATE': {
      if (a.slice(1).some(f => isNone(f, cx))) return atom('0', 'double');
      // ALLSELECTED(table): the value over all the query selects, not grouped by that
      // table's columns (a share of what is shown). DATESBETWEEN(dim_calendar[date], a, b):
      // the value over those days instead of the query's (the days before its range). Both
      // are the value as a subquery of its own, as a measure of another table is.
      const all = a.slice(1).filter(f => isCall(f, 'ALLSELECTED')), between = a.slice(1).filter(f => isCall(f, 'DATESBETWEEN'));
      if (all.length || between.length) {
        if (all.length + between.length !== a.length - 1) throw new Error('DAX: ALLSELECTED and DATESBETWEEN go alone in a CALCULATE');
        const tables = new Set(all.map(f => f.args[0].name));
        const swap = between.length ? daysBetween(between, cx) : null;
        return (swap ? null : overShown(a[0], tables, cx))
          ?? subquery(a[0], a[0].k === 'ref' ? HOME.get(a[0].name) : cx.r.home, cx, { drop: c => tables.has(c.table), swap });
      }
      // [Capacity MW], CALCULATE(SUM(dim[column]), SUMMARIZE(fact, dim[key])): the column of
      // the keys that have rows, each key once. Off the daily table the keys of the days it
      // lacks are added (none). The SELECT is then written in two levels (see `perUnit`).
      const keysOf = x => isCall(x, 'SUMMARIZE') ? x
        : isCall(x, 'DISTINCT') && isCall(x.args[0], 'UNION') && isCall(x.args[0].args[0], 'SUMMARIZE')
          && x.args[0].args.slice(1).every(y => isCall(y, 'CALCULATETABLE') && y.args.slice(1).some(f => isNone(f, cx))) ? x.args[0].args[0] : null;
      if (a.length === 2 && isCall(a[0], 'SUM') && keysOf(a[1])) {
        const [fact, key] = keysOf(a[1]).args;
        over(fact);
        cx.state.agg = true;
        const unit = { key: scalar(key, cx).s, value: `ANY_VALUE(${scalar(a[0].args[0], cx).s})${cx.filter ? ` FILTER (WHERE ${cx.filter})` : ''}` };
        if (cx.r.unit && JSON.stringify(cx.r.unit) !== JSON.stringify(unit)) throw new Error('DAX: one [Capacity MW] per table');
        cx.r.unit = unit;
        return atom(UNIT_VALUE, 'double');
      }
      // A measure of another table under filters of its own: its subquery takes them, the
      // SELECT this is in does not ([Demand with rooftop MW]: rooftop's units, under the
      // regions').
      if (a[0].k === 'ref' && cx.r.home && HOME.has(a[0].name) && HOME.get(a[0].name) !== cx.r.home) {
        cx.scope.push(Object.assign(a.slice(1).flatMap(f => colsIn(f)), { filters: a.slice(1) }));
        try { return elsewhere(a[0].name, cx); } finally { cx.scope.pop(); }
      }
      const filters = a.slice(1).map(x => par(scalar(x, { ...cx, filter: null }), P.and));
      cx.scope.push(Object.assign(a.slice(1).flatMap(f => colsIn(f)), { filters: a.slice(1) }));
      try { return scalar(a[0], { ...cx, filter: [cx.filter, ...filters].filter(Boolean).join(' AND ') }); }
      finally { cx.scope.pop(); }
    }
  }
  throw new Error(`DAX: ${e.fn} is not supported`);
}

// A table expression, as the parts of one SELECT read as `t`. `cols` are its columns in
// order (`sql` over the rows read, `agg` if aggregated); `tables` are the model tables it
// names, which pick the view, unless `from` says what it reads (a subquery).
// `group` is null until it aggregates.
const rel = o => ({ cols: [], tables: new Set(), from: null, where: [], group: null, sets: null, having: [],
  order: [], qualify: null, aggs: [], unit: null, ...o });
const derived = c => ({ name: c.name, sql: `t.${c.name}`, type: c.type, p: P.atom });
const named = (name, x) => ({ name, sql: x.s, type: x.t, p: x.p, agg: x.agg });
const wrap = r => rel({ from: `(${select(r, true)})`, cols: r.cols.map(derived) });

function emit(e, r, q, names = q.names) {
  const state = { agg: false };
  const x = scalar(e, { state, names, filter: null, scope: q.scope, r, q,
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

// A filter argument of CALCULATETABLE, as a condition on the rows read.
const condition = (f, r, q) => par(emit(f, r, q), P.and);

const sortKey = (e, r) => {
  const c = e.k === 'ref' ? r.cols.find(c => c.name === e.name)
    : r.cols.find(c => c.sql === `t.${e.name}`) ?? r.cols.find(c => c.name === e.name);
  if (!c) throw new Error(`DAX: cannot order by ${e.name}: it is not a column of the result`);
  return c.name;
};

function table(e, q) {
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
      q.scope.push(Object.assign([...plain, ...rolled], { keys: plain, rolled }));
      const measures = pairs(i).map(([n, x]) => named(n, emit(x, r, q)));
      q.scope.pop();
      r.cols = [...keys, ...rollup, ...flags, ...measures];
      // As DAX: a group whose measures are all blank is not a row.
      if (measures.length) r.having.push(`(${measures.map(m => `(${m.sql}) IS NOT NULL`).join(' OR ')})`);
      return r;
    }
    case 'ROW': {
      const r = rel({ group: [] });
      r.cols = pairs(0).map(([n, x]) => named(n, emit(x, r, q)));
      return r;
    }
    case 'CALCULATETABLE': {
      q.scope.push(Object.assign(a.slice(1).flatMap(f => colsIn(f)), { filters: a.slice(1) }));
      const r = table(a[0], q);
      q.scope.pop();
      // A filter on another fact than the one the table is about says nothing here: it is
      // for a measure of that fact (see `elsewhere`).
      const here = c => !r.home || r.tables.has(c.table) || reach(r.home).has(c.table);
      const back = new Map();
      for (const f of a.slice(1)) {
        if (!colsIn(f).every(here)) continue;
        const x = backTable(f, r);
        if (x) (back.get(x) ?? back.set(x, []).get(x)).push(f); else r.where.push(condition(f, r, q));
      }
      for (const [x, fs] of back) r.where.push(backward(x, fs, r, q));
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
    case 'TOPN': {
      // As DAX: descending unless ASC (or 1), and the rows tied with the n-th are kept.
      const r = wrap(table(a[1], q)), name = sortKey(a[2], r);
      const desc = !(a[3]?.name?.toUpperCase() === 'ASC' || (a[3]?.k === 'num' && +a[3].v === 1));
      r.order = [{ name, desc }];
      r.qualify = `RANK() OVER (ORDER BY t.${name}${desc ? ' DESC' : ''}) <= ${+a[0].v}`;
      return r;
    }
  }
  throw new Error(`DAX: ${e.fn} is not a table function this compiler knows`);
}

// The SELECT of a table expression. `raw` leaves the values as they are (a subquery, a
// CTE); the result of a query is cast for the browser instead.
// A SELECT with [Capacity MW] in it, in two levels: the rows per unit first (its sums, and
// its capacity once), then the groups asked for, adding the units up. One scan, and no
// DISTINCT over the rows: as `list(DISTINCT {unit, capacity})` in one level, the capacity
// factor of 30 days took 2.7 s in the browser, against 0.8 s (2026-10-06). The aggregates
// next to it have to add up per unit: a sum, a count, a value of the unit.
const UNIT_VALUE = 'UNIT$VALUE';
function perUnit(r, raw) {
  const keys = [...new Set(r.group)], aggs = [...new Set(r.aggs)].sort((a, b) => b.length - a.length);
  const adds = a => {
    const fn = /^(SUM|ANY_VALUE|MIN|MAX|COUNT)\((?!DISTINCT)/.exec(a)?.[1];
    if (!fn) throw new Error(`DAX: ${a} next to [Capacity MW] does not add up per unit`);
    return fn === 'COUNT' ? 'SUM' : fn;
  };
  const swap = sql => {
    aggs.forEach((a, i) => { sql = sql.split(a).join(`${adds(a)}(t.a${i})`); });
    keys.forEach((k, i) => { sql = sql.split(k).join(`t.g${i}`); });
    return sql.split(UNIT_VALUE).join('SUM(t.capacity)');
  };
  const units = rel({ tables: r.tables, where: r.where, group: [...new Set([...keys, r.unit.key])], cols: [
    ...keys.map((k, i) => ({ name: `g${i}`, sql: k })), ...aggs.map((a, i) => ({ name: `a${i}`, sql: a })),
    { name: 'capacity', sql: r.unit.value }] });
  return select(rel({ from: `(${select(units, true)})`, cols: r.cols.map(c => ({ ...c, sql: swap(c.sql) })),
    group: r.group.map(swap), sets: r.sets && swap(r.sets), having: r.having.map(swap), order: r.order, qualify: r.qualify }), raw);
}

function select(r, raw) {
  if (r.unit) return perUnit(r, raw);
  const out = c => {
    const s = raw ? c.sql
      : c.type === 'date' ? `CAST(${c.sql} AS VARCHAR)` : c.type === 'int' ? `CAST(${c.sql} AS INTEGER)`
      : c.type === 'double' ? `${/^t\.\w+$/.test(c.sql) ? c.sql : `(${c.sql})`}::DOUBLE` : c.sql;
    return !c.name || s === `t.${c.name}` ? s : `${s} AS ${c.name}`;
  };
  const where = r.where;
  // A window (overShown) is worked out after HAVING: the conditions on values wait for it.
  const having = r.windowed ? [] : r.having, qualify = [...(r.windowed ? r.having : []), ...(r.qualify ? [r.qualify] : [])];
  const parts = [
    `SELECT ${r.cols.map(out).join(', ')}`,
    where.length && `WHERE ${where.join(' AND ')}`,
    r.group?.length && (r.sets ? `GROUP BY GROUPING SETS (${r.sets})` : `GROUP BY ${r.group.join(', ')}`),
    having.length && `HAVING ${having.join(' AND ')}`,
    qualify.length && `QUALIFY ${qualify.join(' AND ')}`,
    r.order.length && `ORDER BY ${r.order.map(o => o.name + (o.desc ? ' DESC' : '')).join(', ')}`,
  ].filter(Boolean);
  // The keys of dimensions first: one of them can add a table, and the tables pick the view.
  const settled = new Map();
  for (const k of new Set(parts.join(' ').match(/KEY\$\w+\$\w+/g) || [])) settled.set(k, keyColumn(r, ...k.split('$').slice(1)));
  const settle = s => s.replace(/KEY\$\w+\$\w+/g, k => settled.get(k));
  // The same condition once: a date range put on a fact and on dim_calendar is one.
  if (where.length) parts[1] = `WHERE ${[...new Set(where.map(settle))].join(' AND ')}`;
  parts.splice(1, 0, `FROM ${r.from ?? viewOf(r.tables)} t`);
  return settle(parts.join(' '));
}

// =============================================================================
// The page's query -> DAX
// =============================================================================

// The page writes no DAX: it does not know the query language at all. It asks as a report
// visual does: columns to group by, measures, filters on columns, and no expression of its
// own, so a figure is always a measure of the model. What a query can say, and nothing else:
//   select   { name: field }: a column 'table.column' (grouped by), a measure by its name
//            ('Generation MW'), or { min: column } / { max: column }, a key's first or last
//            value (not a figure)
//   where    conditions on columns: [column, op, ...values] with op = <> < <= > >= between
//            in notIn blank notBlank, or { any: [condition, ...] }, true if one of them is
//   having   [name, op, value] or [name, 'notBlank'] on a value of the select: rows left out
//   totals   { name: [column, ...] }: those columns of the select also added up over, in one
//            more set of rows on which `name` is true
//   orderBy  [name, [name, 'desc'], ...]
//   top      n: the first n rows by the first orderBy, the rows tied with the n-th kept
// A value is a literal: a string, a number, true or false, or a date on a date column
// ('2026-10-07'). A column has a dot and a measure has none (no measure of the model has one).
// What the DAX needs that the page does not say is written here: a query of a dimension's
// columns alone leaves out the blank row DAX adds to a dimension when a fact names a key it
// lacks (dim_duid, dim_interconnector: the page lists rows, and that row is none of them).
// A new word here is the owner's to add, never a page's or an agent's.
const COLUMN = /^(\w+)\.([^.[\]]+)$/;
function field(f) {
  const m = typeof f === 'string' && COLUMN.exec(f);
  if (!m) throw new Error(`query: ${JSON.stringify(f)} is not a column`);
  column(m[1], m[2]);
  return { table: m[1], name: m[2], dax: `${m[1]}[${m[2]}]` };
}
function daxValue(v, col) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
  if (typeof v !== 'string') throw new Error(`query: ${JSON.stringify(v)} is not a value`);
  if (column(col.table, col.name).type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `dt"${v}"`;
  return `"${v.replace(/"/g, '""')}"`;
}
// A condition as the filter arguments of a CALCULATETABLE (a range is two of them).
function daxFilters(c) {
  if (!Array.isArray(c)) {
    if (!Array.isArray(c?.any) || !c.any.length) throw new Error(`query: ${JSON.stringify(c)} is not a condition`);
    return [`(${c.any.map(x => daxFilters(x).join(' && ')).join(' || ')})`];
  }
  const [f, op, ...v] = c, col = field(f), val = x => daxValue(x, col), d = col.dax;
  switch (op) {
    case '=': case '<>': case '<': case '<=': case '>': case '>=': return [`${d} ${op} ${val(v[0])}`];
    case 'between': return [`${d} >= ${val(v[0])}`, `${d} <= ${val(v[1])}`];
    case 'in':
      if (!Array.isArray(v[0]) || !v[0].length) throw new Error(`query: ${f} in needs a list of values`);
      return [`${d} IN {${v[0].map(val).join(', ')}}`];
    case 'notIn':
      if (!Array.isArray(v[0]) || !v[0].length) throw new Error(`query: ${f} notIn needs a list of values`);
      return [`NOT (${d} IN {${v[0].map(val).join(', ')}})`];
    case 'blank': return [`ISBLANK(${d})`];
    case 'notBlank': return [`NOT ISBLANK(${d})`];
  }
  throw new Error(`query: ${op} is not a condition`);
}

export function toDax(q) {
  const entries = Object.entries(q.select ?? {});
  if (!entries.length) throw new Error('query: select names nothing');
  const known = new Set(['select', 'where', 'having', 'totals', 'orderBy', 'top']);
  for (const k of Object.keys(q)) if (!known.has(k)) throw new Error(`query: ${k} is not a word of a query`);
  const isCol = f => typeof f === 'string' && COLUMN.test(f);
  const value = f => {
    if (typeof f === 'string') {
      if (!MEASURE_DAX.has(f)) throw new Error(`query: the model has no measure ${f}`);
      return `[${f}]`;
    }
    const [fn, c] = Object.entries(f ?? {})[0] ?? [];
    if ((fn !== 'min' && fn !== 'max') || Object.keys(f).length !== 1) throw new Error(`query: ${JSON.stringify(f)} is not a field`);
    return `${fn.toUpperCase()}(${field(c).dax})`;
  };
  const cols = entries.filter(([, f]) => isCol(f)).map(([n, f]) => [n, field(f)]);
  const values = entries.filter(([, f]) => !isCol(f));
  const totals = Object.entries(q.totals ?? {}).map(([n, cs]) => [n, cs.map(field)]);
  const rolled = new Set(totals.flatMap(([, cs]) => cs.map(c => c.dax)));
  for (const c of rolled) if (!cols.some(([, f]) => f.dax === c)) throw new Error(`query: a total over ${c}, which is not selected`);
  const pairs = values.map(([n, f]) => `"${n}", ${value(f)}`);
  let t;
  if (cols.length) {
    const keys = [...cols.map(([, f]) => f.dax).filter(d => !rolled.has(d)),
      ...totals.map(([n, cs]) => `ROLLUPADDISSUBTOTAL(${cs.length > 1 ? `ROLLUPGROUP(${cs.map(c => c.dax).join(', ')})` : cs[0].dax}, "${n}")`)];
    t = `SUMMARIZECOLUMNS(${[...keys, ...pairs].join(', ')})`;
  } else {
    if (totals.length) throw new Error('query: totals need a column to group by');
    t = `ROW(${pairs.join(', ')})`;
  }
  // A dimension's columns alone: not its blank row.
  const blankRows = values.length ? [] : [...new Set(cols.map(([, f]) => f.table))]
    .map(table => RELS.find(r => r.to === table)).filter(Boolean).map(r => `NOT ISBLANK(${r.to}[${r.toColumn}])`);
  const where = [...new Set([...(q.where ?? []).flatMap(daxFilters), ...blankRows])];
  if (where.length) t = `CALCULATETABLE(${t}, ${where.join(', ')})`;
  // A column comes out under its own name: SELECTCOLUMNS gives it the select's.
  if (new Set(cols.map(([, f]) => f.name)).size < cols.length) throw new Error('query: two columns of the same name');
  if (cols.some(([n, f]) => n !== f.name))
    t = `SELECTCOLUMNS(${t}, ${[...entries.map(([n, f]) => `"${n}", [${isCol(f) ? field(f).name : n}]`),
      ...totals.map(([n]) => `"${n}", [${n}]`)].join(', ')})`;
  const names = new Set([...entries.map(([n]) => n), ...totals.map(([n]) => n)]);
  const name = n => { if (!names.has(n)) throw new Error(`query: ${n} is not a name of the select`); return `[${n}]`; };
  const having = (q.having ?? []).map(([n, op, v]) => {
    if (op === 'notBlank') return `NOT ISBLANK(${name(n)})`;
    if (!['=', '<>', '<', '<=', '>', '>='].includes(op) || typeof v !== 'number') throw new Error(`query: having ${n} ${op} ${v}`);
    return `${name(n)} ${op} ${v}`;
  });
  if (having.length) t = `FILTER(${t}, ${having.join(' && ')})`;
  const order = (q.orderBy ?? []).map(o => Array.isArray(o) ? o : [o]).map(([n, dir]) => {
    if (dir != null && dir !== 'desc') throw new Error(`query: order ${dir}`);
    return `${name(n)}${dir ? ' DESC' : ''}`;
  });
  if (q.top != null) {
    if (!Number.isInteger(q.top) || !order.length) throw new Error('query: top needs a whole number and an orderBy');
    t = `TOPN(${q.top}, ${t}, ${order[0].replace(/ DESC$/, '')}, ${order[0].endsWith(' DESC') ? 'DESC' : 'ASC'})`;
  }
  return `EVALUATE ${t}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}`;
}

// A DAX query as SQL. The same text is translated once.
const _translated = new Map();
export function toSQL(dax) {
  let sql = _translated.get(dax);
  if (sql) return sql;
  const { e, order } = parse(dax).query();
  const q = { names: new Map(), ctes: [], scope: [], cross: new Map() };
  const r = table(e, q);
  if (order.length) r.order = order.map(o => ({ name: sortKey(o.e, r), desc: o.desc }));
  // The SELECT first: writing it can still add a CTE.
  const body = select(r, false);
  sql = (q.ctes.length ? `WITH ${q.ctes.join(', ')} ` : '') + body;
  if (_translated.size >= 500) _translated.clear();
  _translated.set(dax, sql);
  return sql;
}
const isDax = q => /^\s*EVALUATE\b/i.test(q);

// =============================================================================
// The model -> views
// =============================================================================

// A table of the model is a table of the lakehouse, copied into the files as it is
// (scripts/cache_catalog.py): whole in `dim` or `agg`, or split by date over `today` (the
// newest days, refreshed every hour) and the half-year files. v_<table> is that table
// over what is attached; where two files hold a day, `today` has it. A split table that is
// also whole in `agg` has its older days read from there.
const ENTITIES = MODEL.tables.map(t => ({ name: `v_${t.name}`, table: t.partitions[0].source.entityName }));
const RELATIONSHIPS = RELS.filter(r => r.view).map(r => ({ name: r.view, from: `v_${r.from}`, to: `v_${r.to}`, on: [r.fromColumn, r.toColumn] }));
const STAR_VIEWS = STARS.map(s => ({ name: s.view, from: `v_${s.fact}`, joins: s.rels.map(r => ({ to: `v_${r.to}`, on: [r.fromColumn, r.toColumn] })) }));
// In the order they are created: every view after the ones it reads.
const ITEMS = [...ENTITIES, ...RELATIONSHIPS, ...STAR_VIEWS];
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
      // BY NAME: a file built before the table got a column reads as NULL in it, instead of
      // the view failing on files that differ. The view has the columns of all of them.
      const sql = recent && older.length
        ? `SELECT * FROM (${older.map(read).join(' UNION ALL BY NAME ')}) WHERE date < DATE '${_recentFrom}' UNION ALL BY NAME ${read('today')}`
        : dbs.sort().map(read).join(' UNION ALL BY NAME ');
      const cols = new Set(dbs.flatMap(db => [...tables.get(`${db}.${item.table}`)]));
      return { sql, cols, requires };
    }
    // A fact and all its dimensions: each joined as its relationship's view joins it, a
    // column a table before it already has left out.
    if (item.joins) {
      const from = views.get(item.from), tos = item.joins.map(j => views.get(j.to));
      const requires = new Set([item.from, ...item.joins.map(j => j.to)].flatMap(v => [..._requires.get(v)]));
      if (!from || tos.some(t => !t)) return { requires };
      const cols = new Set(from.cols), fields = [], joins = [];
      item.joins.forEach(({ to, on: [l, r] }, i) => {
        for (const c of tos[i].cols) if (c !== r && !cols.has(c)) { cols.add(c); fields.push(`d${i}.${c}`); }
        joins.push(`LEFT JOIN ${to} d${i} ON f.${l} = d${i}.${r}`);
      });
      return { sql: `SELECT f.*${fields.map(c => `, ${c}`).join('')} FROM ${item.from} f ${joins.join(' ')}`, cols, requires };
    }
    // A relationship.
    const from = views.get(item.from), to = views.get(item.to);
    const requires = new Set([..._requires.get(item.from), ..._requires.get(item.to)]);
    if (!from || !to) return { requires };
    const [l, r] = item.on, fields = [...to.cols].filter(c => c !== r && !from.cols.has(c));
    return { sql: `SELECT f.*, ${fields.map(c => `d.${c}`).join(', ')} FROM ${item.from} f LEFT JOIN ${item.to} d ON f.${l} = d.${r}`,
      cols: new Set([...from.cols, ...fields]), requires };
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
    // The views that exist, with their columns: what the Analyze tab's SQL can read.
    views: () => [..._views].map(([name, v]) => ({ name, columns: [...v.cols] })),
    // Whether a view exists and, given a column, whether it has it.
    has: (view, column) => {
      const v = _views.get(view);
      return !!v && (!column || !v.cols || v.cols.has(column));
    },
    // The page's query (an object) becomes DAX, and the DAX SQL; both go to the Logs tab.
    // SQL (Analyze) goes as it is. DAX text is refused: the page asks in the query's words.
    query: async q => {
      if (typeof q !== 'string') { const dax = toDax(q); return data.query(toSQL(dax), dax); }
      if (isDax(q)) throw new Error('DAX is written by the compiler: send the query as an object');
      return data.query(q);
    },
    toDax,
    toSQL,
    // What a SQL query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the aggregates (attachAgg).
    needs: q => {
      const reads = kind => ITEMS.some(i => _requires.get(i.name)?.has(kind) && mentions(q, i.name));
      return { history: reads('history'), agg: reads('agg') };
    },
  };
}
