// =============================================================================
// views.js — the tables of the attached files as views
// =============================================================================
// A table is a table of the lakehouse, copied into the files as it is
// (scripts/cache_catalog.py): whole in `dim` or `agg`, or split by date over `today` (the
// newest days, refreshed every hour) and the half-year files. v_<table> is that table
// over what is attached; where two files hold a day, `today` has it. A split table that is
// also whole in `agg` has its older days read from there.
//
// withViews(data, items) wraps a data source (data.js: init, attachAgg, ensureHistory,
// query) and has its members plus `views`, `has`, `needs` and `requires`. Every data.js
// returns itself wrapped this way, with the default items: a view per table attached. A
// layer above (../semantic/compiler.js) wraps that again with views of its own over them.
// `items` are the views to create, in the order they are created (every view after the
// ones it reads), or a function of the names of the tables attached that returns them:
//   { name, table }               a table of the files
//   { name, from, to, on }        a relationship: `from` LEFT JOIN `to`, with the columns of `to`
//   { name, from, joins }         a fact and its dimensions, each joined as above
// They are created after every attach, from what is attached, read in the engine's own
// catalog: one query for the catalog, one for the statements that changed. A view is
// created once and bound again every time it is read (DuckDB), so the ones over a rebuilt
// view follow it.
//
// Host-independent: it only knows the attached databases by name (dim, today, agg,
// p<YYYY>_h<N>).
// =============================================================================

const PERIOD = /^p\d{4}_h[12]$/;
const mentions = (s, name) => new RegExp(`\\b${name}\\b`, 'i').test(s);
const EVERY_TABLE = tables => tables.map(t => ({ name: `v_${t}`, table: t }));

export function withViews(data, items = EVERY_TABLE) {
  // The views this layer created by now, name -> { cols }, and what each needs attached to
  // hold all its rows: the half-year files of a date range (`history`) or the aggregates
  // (`agg`). A view of the layer below is looked up there.
  let _views = new Map(), _requires = new Map(), _items = [];
  let _recentFrom = null;    // the first day `today` holds
  const _sent = new Map();   // statement name -> the SQL last run for it
  const below = name => { const v = data.views?.().find(v => v.name === name); return v && { cols: new Set(v.columns) }; };
  const requires = name => _requires.get(name) ?? data.requires?.(name) ?? new Set();

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
    const view = name => views.get(name) ?? below(name);
    if (item.table) {
      const dbs = [...tables.keys()].filter(t => t.endsWith(`.${item.table}`)).map(t => t.split('.')[0]);
      const read = db => `SELECT * FROM ${db}.${item.table}`;
      const periods = dbs.filter(db => PERIOD.test(db)).sort(), recent = dbs.includes('today');
      const needs = new Set(recent ? ['history'] : dbs.includes('dim') ? [] : ['agg']);
      if (!dbs.length) return { requires: needs };
      const older = recent && dbs.includes('agg') ? ['agg'] : periods;
      // BY NAME: a file built before the table got a column reads as NULL in it, instead of
      // the view failing on files that differ. The view has the columns of all of them.
      const sql = recent && older.length
        ? `SELECT * FROM (${older.map(read).join(' UNION ALL BY NAME ')}) WHERE date < DATE '${_recentFrom}' UNION ALL BY NAME ${read('today')}`
        : dbs.sort().map(read).join(' UNION ALL BY NAME ');
      const cols = new Set(dbs.flatMap(db => [...tables.get(`${db}.${item.table}`)]));
      return { sql, cols, requires: needs };
    }
    // A fact and all its dimensions: each joined as its relationship's view joins it, a
    // column a table before it already has left out.
    if (item.joins) {
      const from = view(item.from), tos = item.joins.map(j => view(j.to));
      const needs = new Set([item.from, ...item.joins.map(j => j.to)].flatMap(v => [...requires(v)]));
      if (!from || tos.some(t => !t)) return { requires: needs };
      const cols = new Set(from.cols), fields = [], joins = [];
      item.joins.forEach(({ to, on: [l, r] }, i) => {
        for (const c of tos[i].cols) if (c !== r && !cols.has(c)) { cols.add(c); fields.push(`d${i}.${c}`); }
        joins.push(`LEFT JOIN ${to} d${i} ON f.${l} = d${i}.${r}`);
      });
      return { sql: `SELECT f.*${fields.map(c => `, ${c}`).join('')} FROM ${item.from} f ${joins.join(' ')}`, cols, requires: needs };
    }
    // A relationship.
    const from = view(item.from), to = view(item.to);
    const needs = new Set([...requires(item.from), ...requires(item.to)]);
    if (!from || !to) return { requires: needs };
    const [l, r] = item.on, fields = [...to.cols].filter(c => c !== r && !from.cols.has(c));
    return { sql: `SELECT f.*, ${fields.map(c => `d.${c}`).join(', ')} FROM ${item.from} f LEFT JOIN ${item.to} d ON f.${l} = d.${r}`,
      cols: new Set([...from.cols, ...fields]), requires: needs };
  }

  // Creates the views over what is attached by now: the statements that are new or changed
  // since the last compile, as one query. One compile at a time.
  let _compiling = Promise.resolve();
  const compile = () => _compiling = _compiling.catch(() => {}).then(async () => {
    const reads = typeof items === 'function' || items.some(i => i.table);
    const tables = reads ? await catalog() : new Map();
    // A literal in the views, not a subquery: a query inside `today`'s days then reads no
    // half-year at all (40 ms against 98 for three days of one region).
    if (reads) _recentFrom ??= (await data.query(`SELECT CAST(MIN(date) AS VARCHAR) AS d FROM today.fct_region`)).toArray()[0].d;
    _items = typeof items === 'function' ? items([...new Set([...tables.keys()].map(t => t.split('.')[1]))].sort()) : items;
    const views = new Map();
    const statements = [];
    _requires = new Map();
    for (const item of _items) {
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
    ...data,
    // `options` go to the data source's init (where its files are).
    async init(options) {
      const res = await data.init(options);
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
      if (_recentFrom && from >= _recentFrom) return false;
      const changed = await data.ensureHistory(from, to, msg);
      if (changed) await compile();
      return changed;
    },
    // The views that exist, with their columns: what the Analyze tab's SQL can read.
    views: () => [...(data.views?.() ?? []), ...[..._views].map(([name, v]) => ({ name, columns: [...v.cols] }))],
    // Whether a view exists and, given a column, whether it has it.
    has: (name, column) => {
      const v = _views.get(name);
      if (!v) return !!data.has?.(name, column);
      return !column || !v.cols || v.cols.has(column);
    },
    // What a SQL query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the aggregates (attachAgg).
    needs: q => {
      const reads = kind => _items.some(i => requires(i.name).has(kind) && mentions(q, i.name));
      const under = data.needs?.(q) ?? {};
      return { history: reads('history') || !!under.history, agg: reads('agg') || !!under.agg };
    },
    requires,
  };
}
