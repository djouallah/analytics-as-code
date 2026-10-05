// =============================================================================
// compiler.js — compiles the semantic model (model.json) into DuckDB views and macros
// =============================================================================
// The layers of the dashboard, and what stands in each place in a real product:
//   consumer        index.html                 the BI tool
//   query language  SQL, written by hand       DAX, MDX, VizQL, Malloy, a metrics request
//   semantic model  model.json                 LookML, TMDL, MetricFlow YAML, OSI
//   compiler        this file                  MetricFlow, Cube, Malloy, Power BI's formula engine
//   engine          DuckDB-WASM                the warehouse, VertiPaq, Hyper
//   storage         ../storage/data.js         the lakehouse or warehouse connection
//
// It is a naive compiler, on purpose: it compiles the model only. A real one also compiles
// the queries; here the page writes them by hand, in SQL, against what this file creates.
// So the rules a query compiler would apply on its own (which grain to read, when a join is
// needed, MW to MWh) are the author's, in index.html.
//
// What model.json holds and what each entry becomes:
//   functions, metrics   a macro each
//   datasets             a view each, of one of four kinds:
//     table              one attached table, as it is; no view if a deployed file lacks it
//     partitions         a history table and a recent one, stitched (model.json `stitching`).
//                        `p*.<table>` is that table in every attached half-year database.
//                        An `optional` field reads NULL from a file that lacks its column;
//                        `rollup` is a field's expression on the recent side, which is then
//                        grouped
//     from               fields picked from another dataset, plus `calculated` ones over them
//     sql                derived from other datasets; `when` names columns that must exist
//   relationships        a view each: `from` LEFT JOIN `to`, with the fields of `to` (all of
//                        them, or the ones listed). The `calculated` fields of `to` are worked
//                        out again on the joined row, so a row with no match gets a value too
// In an expression, {name} is a constant of the model.
//
// createModel(data) wraps a data source (../storage/data.js: init, attachAgg, ensureHistory,
// query) and has its members plus `has` and `needs`. It compiles after every attach, reading
// what is attached from the engine's own catalog: one query for the catalog, one for the
// statements that changed. A view is created once and bound again every time it is read
// (DuckDB), so the ones over a rebuilt view follow it.
//
// Host-independent: it only knows the attached databases by name (dim, today, agg,
// p<YYYY>_h<N>), so a host that ships its own data.js keeps this file and model.json.
// =============================================================================

// The model, fetched next to this file, with this file's ?v= (the Fabric build's cache-buster).
const MODEL = await (await fetch(new URL('./model.json' + new URL(import.meta.url).search, import.meta.url))).json();

const text = s => Array.isArray(s) ? s.join(' ') : s;
const C = Object.fromEntries(Object.entries(MODEL.constants).map(([k, c]) => [k, c.value]));
const sql = s => text(s).replace(/\{(\w+)\}/g, (m, k) => C[k] ?? m);

export const UNREGISTERED = C.unregistered;
export const ROOFTOP = C.rooftop;

// SQL date: rows from this day on are read from `today`, older ones from history / agg.
const CUT = `CURRENT_DATE - INTERVAL ${C.recent_days} DAY`;
const OLD = `date < ${CUT}`, RECENT = `date >= ${CUT}`;

const MACROS = [...MODEL.functions, ...MODEL.metrics];
const DATASETS = MODEL.datasets.map(d => ({
  ...d, fields: (d.fields || []).map(f => typeof f === 'string' ? { name: f } : f),
}));
const dataset = name => DATASETS.find(d => d.name === name);
// In the order they are created: every view after the ones it reads.
const ITEMS = [...DATASETS.filter(d => !d.sql), ...MODEL.relationships, ...DATASETS.filter(d => d.sql)];
const mentions = (s, name) => new RegExp(`\\b${name}\\b`, 'i').test(s);

// The views a view reads, and what has to be attached for it to hold all its rows: the
// half-year files of a date range (`history`) and/or the daily aggregate (`agg`).
const READS = new Map(), REQUIRES = new Map();
for (const i of ITEMS) {
  const source = i.table || i.partitions?.history || '';
  READS.set(i.name, i.sql ? ITEMS.filter(o => o !== i && mentions(sql(i.sql), o.name)).map(o => o.name)
    : [i.from, i.to].filter(Boolean));
  REQUIRES.set(i.name, new Set([
    ...(source.startsWith('p*.') ? ['history'] : source.startsWith('agg.') ? ['agg'] : []),
    ...READS.get(i.name).flatMap(r => [...(REQUIRES.get(r) || [])]),
  ]));
}

export function createModel(data) {
  // The views that exist by now: name -> { cols, missing }. `cols` is null where the model
  // does not say (an sql dataset); `missing` are the optional fields the deployed files
  // lack: such a field is still there, reading NULL, and has() says it is not.
  let _views = new Map();
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
    const none = new Set();
    if (item.table) {
      return tables.has(item.table) && { sql: `SELECT * FROM ${item.table}`, cols: tables.get(item.table), missing: none };
    }

    if (item.partitions) {
      const { history, recent, stitch = 'cut' } = item.partitions;
      const typed = f => `NULL::${f.datatype ?? 'REAL'} AS ${f.name}`;
      const select = (table, rolled) => `SELECT ${item.fields.map(f => {
        const expr = (rolled && f.rollup) || f.expression || f.name;
        if (f.optional && !tables.get(table).has(f.column ?? f.name)) return typed(f);
        return f.optional || expr !== f.name ? `${expr} AS ${f.name}` : f.name;
      }).join(', ')} FROM ${table}`;
      const periods = [...new Set([...tables.keys()].map(t => t.split('.')[0]))].filter(db => /^p\d{4}_h[12]$/.test(db)).sort();
      const old = (history.startsWith('p*.') ? periods.map(db => db + history.slice(2)) : [history])
        .filter(t => tables.has(t)).map(t => `${select(t)} WHERE ${OLD}`).join(' UNION ALL ');
      const grouped = item.fields.some(f => f.rollup) ? ' GROUP BY ALL' : '';
      // A recent table a deployed file lacks: no rows, the same columns.
      const fresh = where => tables.has(recent) ? `${select(recent, true)}${where}${grouped}`
        : `SELECT ${item.fields.map(typed).join(', ')} WHERE false`;
      const view = !old ? fresh(stitch === 'cut' ? ` WHERE ${RECENT}` : '')
        : stitch === 'after_history'
          ? `${old} UNION ALL SELECT * FROM (${fresh('')})
              WHERE date > (SELECT COALESCE(MAX(date), DATE '1900-01-01') FROM (${old}))`
          : `${old} UNION ALL ${fresh(` WHERE ${RECENT}`)}`;
      return { sql: view, cols: new Set(item.fields.map(f => f.name)), missing: none };
    }

    if (item.from && !item.to) {
      const source = views.get(item.from);
      if (!source) return null;
      const missing = new Set(), a = item.alias;
      const fields = item.fields.map(f => {
        const expr = f.expression || f.name;
        if (f.optional && !source.cols.has(f.column ?? expr)) { missing.add(f.name); return `NULL::${f.datatype} AS ${f.name}`; }
        return expr === f.name ? f.name : `${expr} AS ${f.name}`;
      });
      const calculated = (item.calculated || []).map(c => `${sql(c.expression)} AS ${c.name}`);
      return {
        sql: `SELECT ${[`${a}.*`, ...calculated].join(', ')} FROM (SELECT ${fields.join(', ')} FROM ${item.from}) ${a}`,
        cols: new Set([...item.fields, ...(item.calculated || [])].map(f => f.name)), missing,
      };
    }

    if (item.to) {
      const from = views.get(item.from), to = views.get(item.to), d = dataset(item.to);
      if (!from || !to) return null;
      const a = d.alias || 't', keys = Object.values(item.on);
      const fields = item.fields || d.fields.map(f => f.name).filter(n => !keys.includes(n));
      // Worked out again on the joined row: a row with no match gets a value too.
      const calculated = item.fields ? [] : (d.calculated || []);
      return {
        sql: `SELECT f.*, ${[...fields.map(n => `${a}.${n}`), ...calculated.map(c => `${sql(c.expression)} AS ${c.name}`)].join(', ')}
          FROM ${item.from} f LEFT JOIN ${item.to} ${a} ON ${Object.entries(item.on).map(([l, r]) => `f.${l} = ${a}.${r}`).join(' AND ')}`,
        cols: from.cols && new Set([...from.cols, ...fields, ...calculated.map(c => c.name)]),
        missing: new Set([...from.missing, ...fields.filter(n => to.missing.has(n))]),
      };
    }

    const reads = READS.get(item.name).map(r => views.get(r));
    const met = (item.when || []).every(w => { const [v, c] = w.split('.'); return views.get(v)?.cols?.has(c); });
    return reads.every(Boolean) && met
      && { sql: sql(item.sql), cols: null, missing: new Set(reads.flatMap(r => [...r.missing])) };
  }

  // Creates what the model describes over what is attached by now: the statements that are
  // new or changed since the last compile, as one query. One compile at a time.
  let _compiling = Promise.resolve();
  const compile = () => _compiling = _compiling.catch(() => {}).then(async () => {
    const tables = await catalog();
    const views = new Map();
    const statements = MACROS.map(m => [`macro ${m.name}`, `CREATE OR REPLACE MACRO ${m.name}(${m.args.join(', ')}) AS ${sql(m.expression)}`]);
    for (const item of ITEMS) {
      const view = build(item, tables, views);
      if (!view) continue;
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
    // starts on or after the cut is read from `today` alone, so nothing is attached for it:
    // that is the default "Last 3 days" view.
    async ensureHistory(from, to, msg) {
      const cut = (await data.query(`SELECT CAST(CAST(${CUT} AS DATE) AS VARCHAR) AS d`)).toArray()[0].d;
      if (from >= cut) return false;
      const changed = await data.ensureHistory(from, to, msg);
      if (changed) await compile();
      return changed;
    },
    // Whether a view exists and, given a column, whether the deployed files carry it.
    has: (view, column) => {
      const v = _views.get(view);
      return !!v && (!column || (!v.missing.has(column) && (!v.cols || v.cols.has(column))));
    },
    query: q => data.query(q),
    // What a query reads, by the views it names: the 5-minute history of a date range
    // (ensureHistory) and/or the daily and hourly rollups (attachAgg).
    needs: q => {
      const reads = kind => ITEMS.some(i => REQUIRES.get(i.name).has(kind) && mentions(q, i.name));
      return { history: reads('history'), agg: reads('agg') };
    },
  };
}
