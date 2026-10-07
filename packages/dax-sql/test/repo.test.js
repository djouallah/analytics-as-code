// This repository's semantic model and dashboard page (the package sits at packages/dax-sql):
//   - every measure of model.bim, compiled and run in five filter contexts;
//   - some of them checked against SQL written by hand;
//   - every query the page sends, in six page states, compared row for row with what the
//     page's own compiler (dashboard/github-dax/semantic/compiler.js) returns for it.
// All on made-up data in the model's shape (fixtures/nem.js). Where the two compilers differ,
// this one follows DAX, and the differences are listed below with the reason. Skipped when
// the repository's files are not there (DAX_SQL_REPO can point at a checkout).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { createCompiler } from '../src/index.js';
import { setup } from './fixtures/nem.js';
import { pageQueries, STATES } from './page-queries.js';

const root = process.env.DAX_SQL_REPO ? new URL(`file://${process.env.DAX_SQL_REPO.replace(/\/?$/, '/')}`) : new URL('../../../', import.meta.url);
const path = p => new URL(p, root);
const present = ['semantic_model/model.bim', 'dashboard/github-dax/index.html', 'dashboard/github-dax/semantic/compiler.js'].every(p => fs.existsSync(path(p)));
const skip = present ? false : 'the repository files are not here';

// Where the page's compiler is not DAX: the query, and why the rows differ.
const DIFFERENT = {
  capacityFactor: 'subtotal rows: SELECTEDVALUE over two stations is blank in DAX; compiler.js takes ANY_VALUE',
  batteryFleet: 'no unit left by the filters: COUNTROWS of nothing is blank in DAX; compiler.js returns 0',
};

let con, dax, toy, bim;
before(async () => {
  if (skip) return;
  const bimText = fs.readFileSync(path('semantic_model/model.bim'), 'utf8');
  bim = JSON.parse(bimText);
  // compiler.js fetches model.bim next to itself when it loads.
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => JSON.parse(bimText) });
  try { toy = await import(path('dashboard/github-dax/semantic/compiler.js').href); } finally { globalThis.fetch = fetch; }
  const db = await DuckDBInstance.create(':memory:');
  con = await db.connect();
  await con.run(setup);
  // The views compiler.js reads for a relationship: the fact LEFT JOIN the dimension.
  for (const r of bim.model.relationships) {
    const from = bim.model.tables.find(t => t.name === r.fromTable), to = bim.model.tables.find(t => t.name === r.toTable);
    const have = new Set(from.columns.map(c => c.name));
    const extra = to.columns.map(c => c.name).filter(c => c !== r.toColumn && !have.has(c));
    await con.run(`CREATE VIEW ${r.name} AS SELECT f.*${extra.map(c => `, d."${c}"`).join('')} FROM v_${r.fromTable} f LEFT JOIN v_${r.toTable} d ON f."${r.fromColumn}" = d."${r.toColumn}"`);
  }
  dax = createCompiler(bim, { tableSource: t => `v_${t.name}` });
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

test("the page's queries give the rows compiler.js gives", { skip }, async () => {
  let compared = 0;
  for (const [state, s] of Object.entries(STATES)) {
    const asked = await pageQueries(s, async q => rows(dax.compile(toy.toDax(q)).sql));
    for (const { name, query } of asked) {
      const text = toy.toDax(query);
      const mine = await run(text).catch(e => { throw new Error(`${state}.${name}: ${e.message}`); });
      let theirs;
      try { theirs = await rows(toy.toSQL(text)); } catch (e) {
        if (!compared) throw new Error(`${state}.${name}: ${e.message}\n${text}`);
        continue;
      }
      if (DIFFERENT[name]) continue;
      assert.deepEqual(bag(mine), bag(theirs), `${state}.${name}`);
      compared++;
    }
  }
  assert.ok(compared > 250, `${compared} queries compared`);
});
