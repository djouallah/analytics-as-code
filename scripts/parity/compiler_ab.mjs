// =============================================================================
// compiler_ab.mjs — the DAX page's compiler of another commit against this one: the same
// queries, the same rows, and the time each takes
// =============================================================================
//   cd scripts/parity && npm ci && node compiler_ab.mjs <data dir> <other checkout> [out dir]
//
// <data dir> holds the files the page attaches, as deployed (page_queries.mjs says which).
// Every query of page_states.mjs's states is built once, by this commit's queries.js; each
// compiler turns it into DAX and SQL (its own toDax and toSQL), and both run on the files,
// on one thread each as in the browser, in turn (which goes first alternates). Rows are
// compared as sql_page.mjs compares them; a query that differs fails the run. Time is
// reported, not judged: the totals, and the queries clearly slower here (twice the time and
// 100 ms more), for a review to read. [out dir]: for each of those, in the first state it is
// slower in, its DAX, both SQLs and both EXPLAIN ANALYZE plans. Nothing here asks the
// deployed model: no capacity.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engine, pageOf, states, lists, asked, shiftDate, compare, order } from './page_states.mjs';
import { stagePage } from '../stage_pages.mjs';

const [dataDir, other, outDir] = process.argv.slice(2);
if (!dataDir || !other) { console.error('usage: node compiler_ab.mjs <data dir> <other checkout>'); process.exit(2); }
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A side: its page staged from its checkout, its compiler over its own engine. The page's
// semantic/query.js (compiler.js before 2026-10-08) fetches model.bim next to itself: each
// side gets its own checkout's.
async function side(root) {
  const bim = JSON.parse(readFileSync(path.join(root, 'semantic_model/model.bim'), 'utf8'));
  globalThis.fetch = async url => {
    if (!String(url).includes('model.bim')) throw new Error(`no fetch here: ${url}`);
    return { ok: true, json: async () => bim };
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-'));
  await stagePage('dax', dir, root);
  const load = p => import(pathToFileURL(path.join(dir, p)));
  const [{ withViews }, { createModel }, { createQueries }] = await Promise.all(
    [load('storage/views.js'), load(['semantic/query.js', 'semantic/compiler.js'].find(p => existsSync(path.join(dir, p)))), load('frontend/queries.js')]);
  const { run, source } = await engine(dataDir);
  await run('SET threads = 1');
  const model = createModel(withViews(source));
  await model.init();
  await model.attachAgg();
  return { model, createQueries, run, rows: q => run(model.toSQL(model.toDax(q))) };
}
const old = await side(path.resolve(other)), now = await side(HERE);

const [{ d: newest }] = await now.rows({ select: { d: { max: 'fct_summary.date' } } });
const to = shiftDate(newest, -2);
const page = pageOf(now.createQueries, newest);
await page.queries.readWholeDays(now.rows);

const differs = [], slower = [], byName = new Map();
let compared = 0, msOld = 0, msNew = 0;
async function timed(s, q) {
  const t = performance.now();
  try { return { rows: await s.rows(q), ms: performance.now() - t }; } catch (e) { return { error: e.message, ms: 0 }; }
}
// The first slower state of a query: its DAX, each side's SQL and its plan.
const dumped = new Set();
async function dump(stateName, name, q) {
  dumped.add(name);
  const dir = path.join(outDir, name.replace(/\W+/g, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.txt'), `${stateName}\n${JSON.stringify(q, null, 1)}\n`);
  for (const [label, s] of [['before', old], ['now', now]]) {
    const dax = s.model.toDax(q), sql = s.model.toSQL(dax);
    writeFileSync(path.join(dir, `${label}.dax`), `${dax}\n`);
    writeFileSync(path.join(dir, `${label}.sql`), `${sql}\n`);
    const plan = await s.run(`EXPLAIN ANALYZE ${sql}`);
    writeFileSync(path.join(dir, `${label}.plan.txt`), plan.map(r => r.explain_value).join('\n'));
  }
}
async function check(stateName, name, q) {
  const first = compared++ % 2 ? [now, old] : [old, now];
  const r = new Map();
  for (const s of first) r.set(s, await timed(s, q));
  const a = r.get(old), b = r.get(now);
  if (a.error || b.error) {
    if (!a.error) differs.push(`${stateName} / ${name}: fails here: ${b.error}`);
    else if (!b.error) console.log(`${stateName} / ${name}: failed before, runs now (${a.error})`);
    else differs.push(`${stateName} / ${name}: fails on both: ${b.error}`);
    return;
  }
  msOld += a.ms; msNew += b.ms;
  const t = byName.get(name) ?? { before: 0, now: 0 };
  byName.set(name, { before: t.before + a.ms, now: t.now + b.ms });
  const why = compare(a.rows, b.rows) ?? order(b.rows, a.rows, q.orderBy);
  if (why) differs.push(`${stateName} / ${name}: ${why}`);
  if (b.ms > 2 * a.ms && b.ms - a.ms > 100) {
    slower.push(`${stateName} / ${name}: ${Math.round(a.ms)} ms before, ${Math.round(b.ms)} ms now`);
    if (outDir && !dumped.has(name)) await dump(stateName, name, q);
  }
}
for (const [n, q] of Object.entries(lists(page.queries))) await check('lists', n, q);
for (const [name, state] of states(to)) {
  page.set(state);
  for (const [n, q] of Object.entries(asked(page.queries, state))) await check(name, n, q);
}
for (const d of differs) console.log(d);
if (slower.length) console.log(`clearly slower here:\n  ${slower.join('\n  ')}`);
const most = [...byName].sort(([, x], [, y]) => (y.now - y.before) - (x.now - x.before)).slice(0, 10);
console.log(`the most time added, over every state:\n  ${most.map(([n, t]) => `${n}: ${Math.round(t.before)} ms before, ${Math.round(t.now)} ms now`).join('\n  ')}`);
console.log(`${compared} queries in ${states(to).length} states, ${differs.length} differ; `
  + `${(msOld / 1000).toFixed(1)} s before, ${(msNew / 1000).toFixed(1)} s now (one thread); newest day ${newest}`);
process.exit(differs.length ? 1 : 0);
