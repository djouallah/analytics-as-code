// =============================================================================
// query.js — the page's queries as DAX over the semantic model (model.bim), and the DAX
// as SQL over the data source's views (packages/dax-sql, the compiler)
// =============================================================================
// The layers of the dashboard, and what stands in each place in a real product:
//   consumer        index.html                 the BI tool
//   query language  DAX                        DAX, MDX, VizQL, Malloy, a metrics request
//   semantic model  model.bim (TMSL)           a Tabular model, LookML, MetricFlow YAML
//   query           this file                  a report visual writing its query
//   compiler        packages/dax-sql           Power BI's query service and formula engine,
//                                              MetricFlow, Cube
//   engine          DuckDB-WASM                the warehouse, VertiPaq, Hyper
//   storage         ../storage/data.js         the lakehouse or warehouse connection
//
// The model is the repo's semantic_model/model.bim, the file Power BI runs in Direct Lake:
// it holds DAX only, and nothing in it is written for this compiler. The builds put it next
// to this file.
//
// Two steps, as in Power BI:
//   toDax(query)   the page's query (an object of the model's fields: select, where, having,
//                  totals, orderBy, top) as DAX, each column and measure checked against the
//                  model. The words of a query are the owner's to add to, not a page's.
//   toSQL(dax)     the DAX as one SELECT over the data source's views (v_<table>, which
//                  ../storage/views.js builds), by packages/dax-sql (staged next to this file
//                  as ./dax-sql/): DAX's filter context, context transition, relationships and
//                  blanks. The relationships rely on referential integrity (the dbt tests keep
//                  the data so), so a dimension's key is read off the fact, with no join.
//                  What comes back is cast as the browser wants it: a date as text, a whole
//                  number as INTEGER, a number as DOUBLE.
// It is checked against the model itself: scripts/parity runs the page's queries through
// both and compares the rows (deploy_model.yml).
//
// createModel(data) wraps a data source (../storage/data.js, wrapped by ../storage/views.js)
// with `toDax` and `toSQL`; `query` takes the page's query (an object) or SQL, never DAX
// text. ../frontend/queries.js hands it to the page (`connect`).
// A data source whose engine speaks DAX (`engine: 'dax'`: the deployed semantic model, in
// dashboard/fabric_app/vertipaq) gets the query's DAX as it is: no views, no SQL.
// =============================================================================

import { createCompiler } from './dax-sql/index.js';

// The model, fetched next to this file, with this file's ?v= (the Fabric build's cache-buster).
const BIM = await (await fetch(new URL('./model.bim' + new URL(import.meta.url).search, import.meta.url))).json();
const MODEL = BIM.model;

const TYPES = { string: 'string', int64: 'int', double: 'double', decimal: 'double', dateTime: 'date', boolean: 'bool' };
const TABLES = new Map(MODEL.tables.map(t => [t.name, new Map(t.columns.map(c => [c.name,
  { name: c.name, type: TYPES[c.dataType] }]))]));
const MEASURE_DAX = new Set(MODEL.tables.flatMap(t => (t.measures || []).map(m => m.name)));
const RELS = MODEL.relationships.map(r => ({ to: r.toTable, toColumn: r.toColumn }));
function column(table, name) {
  const c = TABLES.get(table)?.get(name);
  if (!c) throw new Error(`DAX: the model has no ${table}[${name}]`);
  return c;
}

// =============================================================================
// The page's query -> DAX
// =============================================================================

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

// =============================================================================
// DAX -> SQL
// =============================================================================

const DAX = createCompiler(BIM, {
  tableSource: t => `v_${t.name}`,
  assumeIntegrity: true,
  castOutput: {
    int: s => `CAST(${s} AS INTEGER)`,
    double: s => `CAST(${s} AS DOUBLE)`,
    decimal: s => `CAST(${s} AS DOUBLE)`,
    datetime: s => `CAST(CAST(${s} AS DATE) AS VARCHAR)`,
  },
});

// A DAX query as SQL. The same text is translated once.
const _translated = new Map();
export function toSQL(dax) {
  let sql = _translated.get(dax);
  if (sql) return sql;
  sql = DAX.compile(dax).sql;
  if (_translated.size >= 500) _translated.clear();
  _translated.set(dax, sql);
  return sql;
}
const isDax = q => /^\s*EVALUATE\b/i.test(q);

export function createModel(data) {
  if (data.engine === 'dax') return {
    ...data,
    query: async q => {
      if (typeof q === 'string') throw new Error("this engine runs the page's queries only");
      return data.query(toDax(q));
    },
    toDax,
  };
  return {
    ...data,
    // The page's query (an object) becomes DAX, and the DAX SQL; both go to the Logs tab.
    // SQL (Analyze) goes as it is. DAX text is refused: the page asks in the query's words.
    query: async q => {
      if (typeof q !== 'string') { const dax = toDax(q); return data.query(toSQL(dax), dax); }
      if (isDax(q)) throw new Error('DAX is written by the compiler: send the query as an object');
      return data.query(q);
    },
    toDax,
    toSQL,
  };
}
