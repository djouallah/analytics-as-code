// =============================================================================
// page_queries.mjs — the page's queries, as the page builds them, through the compiler, over
// the deployed files
// =============================================================================
//   cd scripts/parity && npm ci && node page_queries.mjs <data dir> <out.json>
//
// <data dir> holds the files the page attaches (mart_dim, mart_today, mart_agg and the
// half-years mart_<YYYY>_h<N>), as deployed. For a set of page states (a date range, a
// region, a fuel, units picked) every member of frontend/queries.js is called with the
// arguments index.html gives it; each query becomes DAX (toDax) and SQL (toSQL) as in the
// browser, and the SQL runs on the files in native DuckDB. The output holds, per query, the
// DAX, the SQL and the rows: scripts/parity_model.py asks the deployed model the same DAX and
// compares its rows with these. Nothing here decides what the page asks: it is the page's own
// code, run outside the browser.
//
// The states end two days before the newest day the files hold: the files are a copy taken
// at one time and the model reads the live tables, so the days still filling differ. The
// queries that read the newest interval or day are left out for the same reason.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engine, pageOf, states, lists, asked, keysOf, shiftDate } from './page_states.mjs';
import { stagePage } from '../stage_pages.mjs';

// [root]: another checkout to take the compiler, the queries and the model from (the commit a
// check is compared with: parity_model.py --since); its rows are not run, only its keys kept.
const [dataDir, out, other] = process.argv.slice(2);
if (!dataDir || !out) { console.error('usage: node page_queries.mjs <data dir> <out.json> [root]'); process.exit(2); }
const ROOT = other ? path.resolve(other) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// semantic/query.js (compiler.js before 2026-10-08) fetches model.bim from next to itself,
// where the builds copy it.
const bim = JSON.parse(readFileSync(path.join(ROOT, 'semantic_model/model.bim'), 'utf8'));
globalThis.fetch = async url => {
  if (!String(url).includes('model.bim')) throw new Error(`no fetch here: ${url}`);
  return { ok: true, json: async () => bim };
};
// The DAX page, staged (common/ with dax/ over it, scripts/stage_pages.mjs); in a checkout
// from before 2026-10-08, which `since` can compare with, the page as it was in the repo:
// dashboard/github-dax, or dashboard/github before the rename of 2026-10-07.
const PAGE = existsSync(path.join(ROOT, 'dashboard/github/dax'))
  ? await (async dir => { await stagePage('dax', dir, ROOT); return dir; })(mkdtempSync(path.join(tmpdir(), 'page-')))
  : ['dashboard/github-dax', 'dashboard/github'].map(d => path.join(ROOT, d)).find(d => existsSync(d));
const { createModel } = await import(pathToFileURL(path.join(PAGE, ['semantic/query.js', 'semantic/compiler.js'].find(p => existsSync(path.join(PAGE, p))))));
const { createQueries } = await import(pathToFileURL(path.join(PAGE, 'frontend/queries.js')));
// The tables' views are the data source's since 2026-10-08 (storage/views.js, which data.js
// wraps itself in); before, the compiler built them.
const VIEWS = path.join(PAGE, 'storage/views.js');
const withViews = existsSync(VIEWS) ? (await import(pathToFileURL(VIEWS))).withViews : s => s;

const { run, source } = await engine(dataDir);
const model = createModel(withViews(source));
await model.init();
await model.attachAgg();
const rows = q => run(model.toSQL(model.toDax(q)));

const [{ d: newest }] = await rows({ select: { d: { max: 'fct_summary.date' } } });
const to = shiftDate(newest, -2);
const page = pageOf(createQueries, newest);
// The other checkout's queries.js may not have a query this one asks, or take other
// arguments: such a query is left out there (null), so it counts as changed.
const queries = !other ? page.queries : new Proxy(page.queries, {
  get: (t, k) => typeof t[k] !== 'function' ? (k in t ? t[k] : () => null)
    : (...a) => { try { return t[k](...a); } catch { return null; } },
});
await queries.readWholeDays(rows);


// What a query's check depends on, without its dates and strings (the dates move every day;
// a number stays: a changed / 12 or >= 0.5 is a changed query): its DAX, its SQL, and the
// DAX of every measure it reaches. A query whose key was checked at the
// commit compared with need not be asked again (parity_model.py --since).
const MEASURES = new Map(bim.model.tables.flatMap(t => (t.measures ?? []).map(m =>
  [m.name, Array.isArray(m.expression) ? m.expression.join('\n') : m.expression])));
const reached = (text, out = new Set()) => {
  for (const [, n] of text.matchAll(/\[([^\]]+)\]/g))
    if (MEASURES.has(n) && !out.has(n)) { out.add(n); reached(MEASURES.get(n), out); }
  return out;
};
const shape = s => (s ?? '').replace(/dt"[^"]*"|DATE '[^']*'/g, 'D').replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, 'S');
const keyOf = e => JSON.stringify([shape(e.dax), shape(e.sql), [...reached(e.dax)].sort().map(n => [n, MEASURES.get(n)])]);

const MAX_ROWS = 20000;
const results = [], seen = new Map();
const add = async (stateName, name, q) => {
  if (!q) return;
  let dax;
  try { dax = model.toDax(q); } catch (e) { if (other) return; throw e; }
  if (seen.has(dax)) { seen.get(dax).states.push(stateName); return; }
  const entry = { name, states: [stateName], keys: keysOf(q), dax };
  try {
    entry.sql = model.toSQL(dax);
    entry.key = keyOf(entry);
    if (other) { seen.set(dax, entry); results.push(entry); return; }
    const found = await run(entry.sql);
    // A bigger result is not asked of the model: parity_model.py lists it with its row
    // count. The REST call answers at most 100,000 rows, and over XMLA a few results of 2
    // million rows throttled the capacity, fetched (deploy run 37599068734) or counted
    // (37604775104): COUNTROWS computes the rows all the same, and every query after them
    // took 20 s more. The same DAX is compared at the states where it is smaller.
    if (found.length > MAX_ROWS) entry.rowCount = found.length; else entry.rows = found;
  } catch (e) { entry.error = String(e.message ?? e); }
  seen.set(dax, entry);
  results.push(entry);
};
for (const [n, q] of Object.entries(lists(queries))) await add('lists', n, q);
for (const [name, state] of states(to)) {
  page.set(state);
  for (const [n, q] of Object.entries(asked(queries, state))) await add(name, n, q);
}
writeFileSync(out, JSON.stringify({ newest, to, queries: results }, null, 1));
console.log(`${results.length} distinct queries, ${results.filter(r => r.error).length} failed in DuckDB; newest day ${newest}, states end ${to}`);
