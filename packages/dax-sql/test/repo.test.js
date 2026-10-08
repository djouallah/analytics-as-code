// This repository's semantic model and dashboard page (the package sits at packages/dax-sql):
//   - every measure of model.bim, compiled and run in five filter contexts;
//   - some of them checked against SQL written by hand;
//   - every query the page sends, in six page states, through the page's compiler
//     (dashboard/github/dax/semantic/query.js: its DAX, and this package's SQL with the
//     page's options), runs.
// All on made-up data in the model's shape (fixtures/nem.js). The page's rows are checked on
// the deployed files, against the SQL page and the compiler before (scripts/parity, build.yml).
// Skipped when the repository's files are not there (DAX_SQL_REPO can point at a checkout).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { createCompiler } from '../src/index.js';
import { setup } from './fixtures/nem.js';
import { pageQueries, STATES } from './page-queries.js';
import { stagePage } from '../../../scripts/stage_pages.mjs';

const root = process.env.DAX_SQL_REPO ? new URL(`file://${process.env.DAX_SQL_REPO.replace(/\/?$/, '/')}`) : new URL('../../../', import.meta.url);
const path = p => new URL(p, root);
const present = ['semantic_model/model.bim', 'dashboard/github/common/index.html', 'dashboard/github/dax/semantic/query.js'].every(p => fs.existsSync(path(p)));
const skip = present ? false : 'the repository files are not here';

let con, dax, page, bim, staged, createQueries;
before(async () => {
  if (skip) return;
  const bimText = fs.readFileSync(path('semantic_model/model.bim'), 'utf8');
  bim = JSON.parse(bimText);
  staged = fs.mkdtempSync(join(tmpdir(), 'dax-sql-page-'));
  await stagePage('dax', staged, fileURLToPath(root));
  fs.writeFileSync(join(staged, 'package.json'), '{"type":"module"}\n');
  // query.js fetches model.bim next to itself when it loads.
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => JSON.parse(bimText) });
  try {
    ({ createQueries } = await import(pathToFileURL(join(staged, 'frontend/queries.js')).href));
    page = await import(pathToFileURL(join(staged, 'semantic/query.js')).href);
  } finally { globalThis.fetch = fetch; }
  const db = await DuckDBInstance.create(':memory:');
  con = await db.connect();
  await con.run(setup);
  dax = createCompiler(bim, { tableSource: t => `v_${t.name}` });
});
after(() => {
  if (staged) fs.rmSync(staged, { recursive: true, force: true });
});

const value = v => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString().slice(0, 10)
  : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
async function rows(sql) {
  const r = await con.runAndReadAll(sql);
  return r.getRowObjectsJS().map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, value(v)])));
}
const run = async q => rows(dax.compile(q).sql);
const bag = rs => rs.map(r => JSON.stringify(r)).sort();

test('every measure, in five filter contexts', { skip }, async () => {
  const contexts = {
    alone: m => `EVALUATE ROW("v", [${m}])`,
    days: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_calendar[date], "v", [${m}]), dim_calendar[date] >= dt"2026-09-10", dim_calendar[date] <= dt"2026-10-07")`,
    fiveMinutes: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(fct_summary[date], dim_duid[FuelSourceDescriptor], "v", [${m}]), fct_summary[date] >= dt"2026-10-05")`,
    regionMonth: m => `EVALUATE SUMMARIZECOLUMNS(dim_region[Region], dim_calendar[month], "v", [${m}])`,
    unit: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_duid[DUID], "v", [${m}]), dim_calendar[date] >= dt"2026-09-20")`,
  };
  const measures = bim.model.tables.flatMap(t => (t.measures ?? []).map(m => m.name));
  assert.ok(measures.length > 40);
  for (const m of measures) for (const [name, q] of Object.entries(contexts)) {
    await assert.doesNotReject(() => run(q(m)), `[${m}] ${name}`);
  }
});

test('measures against SQL written by hand', { skip }, async () => {
  const same = async (q, sql) => assert.deepEqual(bag(await run(q)), bag(await rows(sql)), q);
  // By calendar day: the daily table's days from it, the days it lacks (the 6th, the 7th) from the 5-minute rows.
  await same(`EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_calendar[date], "v", [Generation MWh]), dim_calendar[date] >= dt"2026-10-04", dim_calendar[date] <= dt"2026-10-07")`,
    `SELECT date, CAST(v AS DOUBLE) AS v FROM (SELECT date, SUM(output_mwh) v FROM v_fct_summary_daily WHERE date BETWEEN '2026-10-04' AND '2026-10-05' GROUP BY 1
      UNION ALL SELECT date, SUM(greatest(mw, 0))::DOUBLE / 12 FROM v_fct_summary WHERE date BETWEEN '2026-10-06' AND '2026-10-07' GROUP BY 1)`);
  await same(`EVALUATE CALCULATETABLE(ROW("v", [Renewable share]), fct_summary[date] = dt"2026-10-06")`,
    `SELECT 100 * SUM(CASE WHEN d."Renewable" THEN greatest(f.mw, 0) END)::DOUBLE / SUM(CASE WHEN d."FuelSourceDescriptor" IS DISTINCT FROM 'Grid' THEN greatest(f.mw, 0) END) v
      FROM v_fct_summary f LEFT JOIN v_dim_duid d USING ("DUID") WHERE f.date = '2026-10-06'`);
  await same(`EVALUATE CALCULATETABLE(ROW("v", [Capacity factor]), dim_duid[DUID] = "WIND1", dim_calendar[date] >= dt"2026-09-20", dim_calendar[date] <= dt"2026-10-05")`,
    `SELECT 100 * (SELECT SUM(output_mwh) FROM v_fct_summary_daily WHERE "DUID" = 'WIND1' AND date BETWEEN '2026-09-20' AND '2026-10-05')
      / (100.0 * 24 * (SELECT COUNT(DISTINCT date) FROM v_fct_region_daily WHERE date BETWEEN '2026-09-20' AND '2026-10-05')) v`);
  // A day of the daily table (288 intervals) and a day it lacks (its 5-minute rows).
  await same(`EVALUATE CALCULATETABLE(ROW("v", [Average price]), dim_region[Region] = "NSW1", dim_calendar[date] >= dt"2026-10-05", dim_calendar[date] <= dt"2026-10-06")`,
    `SELECT (288 * (SELECT SUM(price) FROM v_fct_region_daily WHERE "REGIONID" = 'NSW1' AND date = '2026-10-05')
      + (SELECT SUM(price) FROM v_fct_region WHERE "REGIONID" = 'NSW1' AND date = '2026-10-06'))::DOUBLE
      / (288 + (SELECT COUNT(price) FROM v_fct_region WHERE "REGIONID" = 'NSW1' AND date = '2026-10-06')) v`);
  await same(`EVALUATE CALCULATETABLE(ROW("v", [Units]), fct_summary[date] = dt"2026-10-06")`,
    `SELECT COUNT(DISTINCT "DUID")::BIGINT v FROM v_fct_summary JOIN v_dim_duid d USING ("DUID") WHERE date = '2026-10-06' AND d."FuelSourceDescriptor" IS DISTINCT FROM 'Rooftop solar'`);
});

test("the page's queries run through the page's compiler", { skip }, async () => {
  let ran = 0;
  for (const [state, s] of Object.entries(STATES)) {
    const run = async q => rows(page.toSQL(page.toDax(q)));
    for (const { name, query } of await pageQueries(createQueries, s, run)) {
      await run(query).catch(e => { throw new Error(`${state}.${name}: ${e.message}\n${page.toDax(query)}`); });
      ran++;
    }
  }
  assert.ok(ran > 250, `${ran} queries ran`);
});
