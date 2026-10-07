// =============================================================================
// sql_page.mjs — the page in SQL (dashboard/github/sql) against the page through the model
// (dashboard/github/dax): the same questions, the same rows
// =============================================================================
//   cd scripts/parity && npm ci && node sql_page.mjs <data dir> [out.json]
//
// <data dir> holds the files the pages attach, as deployed (page_queries.mjs says which).
// For every state of page_states.mjs, each member of the SQL page's frontend/queries.js is
// called as index.html calls it and its SQL run on the files; the DAX page's same member goes
// through the compiler and runs on the same files. The rows are matched on their columns
// that are not figures, and the figures compared to a part in a million (or 1e-9 near 0).
// Exits 1 and lists what differs. [out.json]: per query, the DAX page's DAX and the SQL page's
// SQL and rows, the shape parity_model.py reads: what the deployed model answers to the DAX
// against what the SQL page draws.
// =============================================================================

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engine, pageOf, states, lists, asked, keysOf, shiftDate } from './page_states.mjs';
import { stagePage } from '../stage_pages.mjs';

const [dataDir, out] = process.argv.slice(2);
if (!dataDir) { console.error('usage: node sql_page.mjs <data dir> [out.json]'); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bim = JSON.parse(readFileSync(path.join(ROOT, 'semantic_model/model.bim'), 'utf8'));
globalThis.fetch = async url => {
  if (!String(url).includes('model.bim')) throw new Error(`no fetch here: ${url}`);
  return { ok: true, json: async () => bim };
};
// Each page staged as the site has it (scripts/stage_pages.mjs).
const staged = async variant => { const dir = mkdtempSync(path.join(tmpdir(), `${variant}-`)); await stagePage(variant, dir); return dir; };
const [daxDir, sqlDir] = [await staged('dax'), await staged('sql')];
const load = (dir, p) => import(pathToFileURL(path.join(dir, p)));
const { withViews } = await load(daxDir, 'storage/views.js');
const dax = await load(daxDir, 'frontend/queries.js');
const sql = await load(sqlDir, 'frontend/queries.js');

// Two engines over the same files, each wrapped as its page wraps its data source.
const daxEngine = await engine(dataDir), sqlEngine = await engine(dataDir);
const model = dax.connect(withViews(daxEngine.source));
const data = withViews(sqlEngine.source);
for (const d of [model, data]) { await d.init(); await d.attachAgg(); }
const daxRows = q => daxEngine.run(model.toSQL(model.toDax(q)));
const sqlRows = q => sqlEngine.run(q);

const [{ d: newest }] = await daxRows({ select: { d: { max: 'fct_summary.date' } } });
const to = shiftDate(newest, -2);
const pages = { dax: pageOf(dax.createQueries, newest), sql: pageOf(sql.createQueries, newest) };
await pages.dax.queries.readWholeDays(daxRows);
await pages.sql.queries.readWholeDays(sqlRows);

// Rows as a set: matched on what is not a figure (text, a flag, a whole number in every
// row of both), the figures compared. The columns are matched by name: the page reads them so.
const isFigure = v => typeof v === 'number' && !Number.isInteger(v);
const close = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number'
  && Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b))));
function compare(a, b) {
  const ca = Object.keys(a[0] ?? b[0] ?? {}).sort(), cb = Object.keys(b[0] ?? a[0] ?? {}).sort();
  if (ca.join() !== cb.join()) return `columns ${ca.join(',')} against ${cb.join(',')}`;
  if (a.length !== b.length) return `${a.length} rows against ${b.length}`;
  const keys = ca.filter(c => [...a, ...b].every(r => !isFigure(r[c])));
  const keyOf = r => JSON.stringify(keys.map(c => r[c]));
  const byKey = new Map();
  for (const r of b) (byKey.get(keyOf(r)) ?? byKey.set(keyOf(r), []).get(keyOf(r))).push(r);
  for (const r of a) {
    const same = byKey.get(keyOf(r)) ?? [];
    const i = same.findIndex(s => ca.every(c => close(r[c], s[c])));
    if (i < 0) return `no row like ${JSON.stringify(r)} (${same.length ? `nearest ${JSON.stringify(same[0])}` : 'none with its keys'})`;
    same.splice(i, 1);
  }
  return null;
}
// The order the DAX page's query asks for, on the columns it orders by (rows tied on them
// may come in either order).
function order(a, b, by) {
  const cols = (by ?? []).map(o => Array.isArray(o) ? o[0] : o);
  const i = a.findIndex((r, i) => !cols.every(c => close(r[c], b[i][c])));
  return i < 0 ? null : `row ${i} out of order on ${cols.join(', ')}: ${JSON.stringify(a[i])} where ${JSON.stringify(b[i])}`;
}

const differs = [], entries = new Map();
let compared = 0;
async function check(stateName, name, q) {
  const s = q(pages.sql.queries), d = q(pages.dax.queries);
  compared++;
  let a, b;
  try { a = await sqlRows(s); } catch (e) { differs.push(`${stateName} / ${name}: SQL page fails: ${e.message}`); return; }
  b = await daxRows(d);
  const why = compare(a, b) ?? order(a, b, d.orderBy);
  if (why) differs.push(`${stateName} / ${name}: ${why}`);
  const daxText = model.toDax(d);
  const entry = entries.get(daxText);
  if (entry) entry.states.push(stateName);
  else entries.set(daxText, { name, states: [stateName], keys: keysOf(d),
    dax: daxText, sql: s, ...(a.length > 20000 ? { rowCount: a.length } : { rows: a }) });
}
for (const n of Object.keys(lists(pages.sql.queries))) await check('lists', n, qs => lists(qs)[n]);
for (const [name, state] of states(to)) {
  pages.dax.set(state); pages.sql.set(state);
  for (const n of Object.keys(asked(pages.sql.queries, state))) await check(name, n, qs => asked(qs, state)[n]);
}
if (out) writeFileSync(out, JSON.stringify({ newest, to, queries: [...entries.values()] }, null, 1));
for (const d of differs) console.log(d);
console.log(`${compared} questions in ${states(to).length} states, ${differs.length} differ; newest day ${newest}, states end ${to}`);
process.exit(differs.length ? 1 : 0);
