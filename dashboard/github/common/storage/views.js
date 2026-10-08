// =============================================================================
// views.js — the tables of the attached files as views
// =============================================================================
// A table is a table of the lakehouse, copied into the files as it is
// (scripts/cache_catalog.py): whole in `dim` or `agg`, or split by date over `today` (the
// newest days, refreshed every hour) and the half-year files. v_<table> is that table
// over what is attached; where two files hold a day, `today` has it. A split table that is
// also whole in `agg` has its older days read from there.
//
// withViews(data) wraps a data source (data.js: init, attachAgg, ensureHistory, query) and
// has its members plus `views`, `has` and `needs`: a view v_<table> per table attached.
// Every data.js returns itself wrapped this way. They are created after every attach, from
// what is attached, read in the engine's own catalog: one query for the catalog, one for the
// statements that changed. A view is created once and bound again every time it is read
// (DuckDB), so a query over a rebuilt view follows it.
//
// Host-independent: it only knows the attached databases by name (dim, today, agg,
// p<YYYY>_h<N>).
// =============================================================================

const PERIOD = /^p\d{4}_h[12]$/;
const mentions = (s, name) => new RegExp(`\\b${name}\\b`, 'i').test(s);

export function withViews(data) {
  // The views created by now, name -> { cols }, and what each needs attached to hold all its
  // rows: the half-year files of a date range (`history`) or the aggregates (`agg`).
  let _views = new Map(), _requires = new Map();
  let _recentFrom = null;    // the first day `today` holds
  const _sent = new Map();   // statement name -> the SQL last run for it
  const requires = name => _requires.get(name) ?? new Set();

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

  // The SELECT of a table's view over what is attached, or none if it cannot exist yet.
  function build(table, tables) {
    const dbs = [...tables.keys()].filter(t => t.endsWith(`.${table}`)).map(t => t.split('.')[0]);
    const read = db => `SELECT * FROM ${db}.${table}`;
    const periods = dbs.filter(db => PERIOD.test(db)).sort(), recent = dbs.includes('today');
    const needs = new Set(recent ? ['history'] : dbs.includes('dim') ? [] : ['agg']);
    if (!dbs.length) return { requires: needs };
    const older = recent && dbs.includes('agg') ? ['agg'] : periods;
    // BY NAME: a file built before the table got a column reads as NULL in it, instead of
    // the view failing on files that differ. The view has the columns of all of them.
    const sql = recent && older.length
      ? `SELECT * FROM (${older.map(read).join(' UNION ALL BY NAME ')}) WHERE date < DATE '${_recentFrom}' UNION ALL BY NAME ${read('today')}`
      : dbs.sort().map(read).join(' UNION ALL BY NAME ');
    const cols = new Set(dbs.flatMap(db => [...tables.get(`${db}.${table}`)]));
    return { sql, cols, requires: needs };
  }

  // Creates the views over what is attached by now: the statements that are new or changed
  // since the last compile, as one query. One compile at a time.
  let _compiling = Promise.resolve();
  const compile = () => _compiling = _compiling.catch(() => {}).then(async () => {
    const tables = await catalog();
    // A literal in the views, not a subquery: a query inside `today`'s days then reads no
    // half-year at all (40 ms against 98 for three days of one region).
    _recentFrom ??= (await data.query(`SELECT CAST(MIN(date) AS VARCHAR) AS d FROM today.fct_region`)).toArray()[0].d;
    const views = new Map();
    const statements = [];
    _requires = new Map();
    for (const table of [...new Set([...tables.keys()].map(t => t.split('.')[1]))].sort()) {
      const name = `v_${table}`, view = build(table, tables);
      _requires.set(name, view.requires);
      if (!view.sql) continue;
      views.set(name, view);
      statements.push([name, `CREATE OR REPLACE VIEW ${name} AS ${view.sql}`]);
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
    views: () => [..._views].map(([name, v]) => ({ name, columns: [...v.cols] })),
    // Whether a view exists and, given a column, whether it has it.
    has: (name, column) => {
      const v = _views.get(name);
      return !!v && (!column || v.cols.has(column));
    },
    // What a SQL query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the aggregates (attachAgg).
    needs: q => {
      const reads = kind => [..._requires].some(([name, r]) => r.has(kind) && mentions(q, name));
      return { history: reads('history'), agg: reads('agg') };
    },
  };
}
