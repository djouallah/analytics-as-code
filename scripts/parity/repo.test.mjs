// The compiler (dax-sql, a submodule at dax-sql/) on this repository's semantic model
// (semantic_model/ossie.yaml, read with dax-sql's formats/ossie.js) and page:
//   - every measure of the model, compiled and run in five filter contexts;
//   - some of them checked against SQL written by hand;
//   - every query the page sends, in six page states, through the page's compiler
//     (front_end/page/semantic/query.js: its DAX, and this package's SQL with the
//     page's options), runs;
//   - the SQL page's queries (SELECTs over the model) against the DAX page's, in the same
//     states: the same rows;
//   - the Explore tab's SQL box: a SELECT over the model (query.js's `analyze`), and its rows against
//     the page's query of the same fields; and SQL over the views, as written.
// All on made-up data in the model's shape (fixtures/nem.mjs). The page's rows are checked on
// the deployed files, against the SQL page and the compiler before (sql_page.mjs, compiler_ab.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { createCompiler } from '../../dax-sql/src/index.js';
import { tmslToOssie, ossieToTmsl, ossieToModel } from '../../dax-sql/formats/ossie.js';
import { setup } from './fixtures/nem.mjs';
import { pageQueries, STATES } from './repo_queries.mjs';
import { stagePage, readOssie } from '../stage_pages.mjs';
import { fetchFiles } from './page_states.mjs';

const root = new URL('../../', import.meta.url);
const path = p => new URL(p, root);
const present = ['semantic_model/ossie.yaml', 'front_end/page/index.html', 'front_end/page/semantic/query.js'].every(p => fs.existsSync(path(p)));
const skip = present ? false : 'the repository files are not here';

let con, dax, page, doc, bim, staged, createQueries, sqlPage;
before(async () => {
  if (skip) return;
  // The model, semantic_model/ossie.yaml, and the TMSL it stands for (dax-sql's formats/).
  doc = await readOssie(fileURLToPath(root));
  bim = ossieToTmsl(doc);
  staged = fs.mkdtempSync(join(tmpdir(), 'dax-sql-page-'));
  await stagePage('dax', staged, fileURLToPath(root));
  fs.writeFileSync(join(staged, 'package.json'), '{"type":"module"}\n');
  // query.js fetches its model (ossie.json) next to itself when it loads.
  const fetch = globalThis.fetch;
  fetchFiles(fileURLToPath(root));
  const stagedSql = join(staged, 'sql');
  await stagePage('sql', stagedSql, fileURLToPath(root));
  try {
    ({ createQueries } = await import(pathToFileURL(join(staged, 'frontend/queries.js')).href));
    page = await import(pathToFileURL(join(staged, 'semantic/query.js')).href);
    sqlPage = {
      ...await import(pathToFileURL(join(stagedSql, 'frontend/queries.js')).href),
      model: await import(pathToFileURL(join(stagedSql, 'semantic/query.js')).href),
    };
  } finally { globalThis.fetch = fetch; }
  const db = await DuckDBInstance.create(':memory:');
  con = await db.connect();
  await con.run(setup);
  dax = createCompiler(ossieToModel(doc), { tableSource: t => `v_${t.name}` });
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
const bag = rs => rs.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))).sort();

const CONTEXTS = {
  alone: m => `EVALUATE ROW("v", [${m}])`,
  days: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_calendar[date], "v", [${m}]), dim_calendar[date] >= dt"2026-09-10", dim_calendar[date] <= dt"2026-10-07")`,
  fiveMinutes: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(fct_summary[date], dim_duid[FuelSourceDescriptor], "v", [${m}]), fct_summary[date] >= dt"2026-10-05")`,
  regionMonth: m => `EVALUATE SUMMARIZECOLUMNS(dim_region[Region], dim_calendar[month], "v", [${m}])`,
  unit: m => `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_duid[DUID], "v", [${m}]), dim_calendar[date] >= dt"2026-09-20")`,
};
test('every measure, in five filter contexts', { skip }, async () => {
  const measures = bim.model.tables.flatMap(t => (t.measures ?? []).map(m => m.name));
  assert.ok(measures.length > 40);
  for (const m of measures) for (const [name, q] of Object.entries(CONTEXTS)) {
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
  // A day of the daily table (288 intervals) and a day it lacks (its 5-minute rows); prices
  // are fixed decimal, so their sum over a count is rounded to four places.
  await same(`EVALUATE CALCULATETABLE(ROW("v", [Average price]), dim_region[Region] = "NSW1", dim_calendar[date] >= dt"2026-10-05", dim_calendar[date] <= dt"2026-10-06")`,
    `SELECT ROUND((288 * (SELECT SUM(price) FROM v_fct_region_daily WHERE "REGIONID" = 'NSW1' AND date = '2026-10-05')
      + (SELECT SUM(price) FROM v_fct_region WHERE "REGIONID" = 'NSW1' AND date = '2026-10-06'))::DOUBLE
      / (288 + (SELECT COUNT(price) FROM v_fct_region WHERE "REGIONID" = 'NSW1' AND date = '2026-10-06')), 4) v`);
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

test("the SQL page's SELECTs answer what the DAX page's queries answer", { skip }, async () => {
  let ran = 0;
  for (const [state, s] of Object.entries(STATES)) {
    const daxRun = async q => rows(page.toSQL(page.toDax(q)));
    const sqlRun = async q => rows(sqlPage.model.toSQL(q));
    const daxQueries = await pageQueries(createQueries, s, daxRun);
    const sqlQueries = await pageQueries(sqlPage.createQueries, s, sqlRun);
    assert.deepEqual(sqlQueries.map(x => x.name), daxQueries.map(x => x.name));
    for (const [i, { name, query }] of sqlQueries.entries()) {
      const got = await sqlRun(query).catch(e => { throw new Error(`${state}.${name}: ${e.message}\n${query}`); });
      assert.deepEqual(bag(got), bag(await daxRun(daxQueries[i].query)), `${state}.${name}\n${query}`);
      ran++;
    }
  }
  assert.ok(ran > 250, `${ran} queries ran`);
});

test("Explore SQL box: a SELECT over the model, through the page's compiler", { skip }, async () => {
  const sent = [];
  const model = page.createModel({ query: async (sql, dax) => { sent.push(dax); return rows(sql); } });
  const ask = async text => { const a = model.analyze(text); return a.query(a.sql); };
  // The same figure as the page's query of the same fields.
  const byFuel = await ask(`SELECT dim_calendar.date, FuelSourceDescriptor, AGG("Generation MWh") AS mwh FROM model
    WHERE dim_calendar.date BETWEEN DATE '2026-10-04' AND DATE '2026-10-07' GROUP BY ALL ORDER BY 1 DESC, mwh DESC`);
  assert.ok(byFuel.length > 0);
  assert.match(sent.at(-1), /^EVALUATE /);
  const asked = await rows(page.toSQL(page.toDax({ select: { date: 'dim_calendar.date', FuelSourceDescriptor: 'dim_duid.FuelSourceDescriptor', mwh: 'Generation MWh' },
    where: [['dim_calendar.date', 'between', '2026-10-04', '2026-10-07']] })));
  assert.deepEqual(bag(byFuel), bag(asked));
  // The example the tab writes, and the other words of a SELECT.
  for (const text of [
    `-- a comment\nSELECT dim_calendar.date, FuelSourceDescriptor, AGG("Generation MWh") AS mwh\nFROM model\nWHERE dim_calendar.date >= TODAY() - 7\nGROUP BY ALL\nORDER BY 1 DESC, mwh DESC`,
    `SELECT dim_region.Region, AGG("Average price") AS price FROM model GROUP BY ALL HAVING price > 0 ORDER BY price DESC LIMIT 2`,
    `SELECT dim_calendar.date, SUM(fct_summary.mw) AS mw, COUNT(DISTINCT fct_summary.DUID) AS units FROM model GROUP BY ALL`,
    `SELECT AGG("Generation MWh") FROM model`,
  ]) await assert.doesNotReject(() => ask(text), text);
  assert.equal((await ask(`SELECT dim_region.Region, AGG("Average price") AS p FROM model GROUP BY ALL LIMIT 2`)).length, 2);
  // A name several tables have needs its table; DAX text is refused.
  assert.throws(() => model.analyze('SELECT date, AGG("Generation MWh") FROM model GROUP BY ALL'), /several tables/);
  assert.throws(() => model.analyze('EVALUATE ROW("v", [Generation MWh])'), /Explore takes SQL/);
  // Any other SQL runs as written over the views: a join, a CTE, a window function. It
  // carries no DAX.
  sent.length = 0;
  const joined = await ask(`SELECT d.FuelSourceDescriptor AS fuel, SUM(s.mw) AS mw FROM v_fct_summary s JOIN v_dim_duid d USING ("DUID") GROUP BY 1 ORDER BY 1`);
  assert.ok(joined.length > 0);
  const rolling = await ask(`WITH x AS (SELECT date, SUM(mw) AS mw FROM v_fct_summary GROUP BY date)
    SELECT date, mw, AVG(mw) OVER (ORDER BY date ROWS 2 PRECEDING) AS avg3 FROM x ORDER BY date`);
  assert.ok(rolling.length > 0 && 'avg3' in rolling[0]);
  assert.deepEqual(sent, [undefined, undefined]);
  // "FROM model" in a comment or a string is text: the SQL runs as written.
  await assert.doesNotReject(() => ask(`-- not FROM model\nSELECT 'FROM model' AS x, COUNT(*) AS n FROM v_dim_duid`));
  // A SELECT over the model is a relation of any SQL: a WITH's query joined to a view, the arms
  // of a UNION. Its rows are its own, and each one's DAX goes to the Logs tab.
  sent.length = 0;
  const gen = await ask(`WITH g AS (SELECT dim_calendar.date, AGG("Generation MWh") AS mwh FROM model
      WHERE dim_calendar.date BETWEEN DATE '2026-10-04' AND DATE '2026-10-07' GROUP BY ALL)
    SELECT g.date, g.mwh, r.price FROM g
    JOIN (SELECT date, AVG(price) AS price FROM v_fct_region_daily GROUP BY ALL) r USING (date) ORDER BY 1`);
  const alone = await ask(`SELECT dim_calendar.date, AGG("Generation MWh") AS mwh FROM model
    WHERE dim_calendar.date BETWEEN DATE '2026-10-04' AND DATE '2026-10-07' GROUP BY ALL`);
  assert.ok(gen.length > 0 && 'price' in gen[0]);
  assert.deepEqual(bag(gen.map(({ date, mwh }) => ({ date, mwh }))), bag(alone.filter(a => gen.some(g => g.date === a.date))));
  assert.match(sent[0], /^EVALUATE /);
  const arms = await ask(`(SELECT dim_region.Region AS k, AGG("Average price") AS v FROM model GROUP BY ALL)
    UNION ALL (SELECT dim_duid.FuelSourceDescriptor, AGG("Generation MWh") FROM model GROUP BY ALL)`);
  const [regions, fuels] = [await ask(`SELECT dim_region.Region, AGG("Average price") FROM model GROUP BY ALL`),
    await ask(`SELECT dim_duid.FuelSourceDescriptor, AGG("Generation MWh") FROM model GROUP BY ALL`)];
  assert.equal(arms.length, regions.length + fuels.length);
  assert.equal(sent.at(-3).split('\n\n').length, 2);
  // The model is no table, and DAX is refused however it starts.
  assert.throws(() => model.analyze('SELECT * FROM v_dim_duid JOIN model USING ("DUID")'), /not a table/);
  assert.throws(() => model.analyze('DEFINE MEASURE fct_summary[x] = 1 EVALUATE ROW("v", [x])'), /Explore takes SQL/);
  // The page's own queries are the model's words only.
  await assert.rejects(() => model.query('SELECT * FROM v_dim_duid'), /SELECTs over the model/);
});

// Explore (frontend/explore.js): the shelves as a query in the page's words, through the
// page's compiler, and its rows laid out as a pivot. Its totals are the model's.
test('Explore: shelves to a query, a query to a pivot', { skip }, async () => {
  const { modelFields, buildQuery, pivot, autoMark, modelSql } = await import(pathToFileURL(join(staged, 'frontend/explore.js')).href);
  const fields = modelFields(bim.model);
  assert.ok(fields.byId.has('dim_duid.FuelSourceDescriptor') && fields.byId.has('Generation MWh'));
  assert.ok(!fields.byId.has('Reads 5 minutes'), 'hidden measures are left out');
  // Explore runs its query as a SELECT over the model (modelSql): the same rows as the query
  // object gives, a total flagged 1 by GROUPING where the object's is TRUE.
  const sqlModel = page.createModel({ query: async sql => rows(sql) });
  const flag = v => v === true || v === 1 || v === 1n;
  // As sets: rows tied on every key of the ORDER BY may come in either order (the pivot places
  // a row by its keys, not by its position).
  const same = rs => rs.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, k.startsWith('__') ? flag(v) : v])), (k, v) => typeof v === 'bigint' ? Number(v) : v)).sort().join('\n');
  const run = async q => {
    const viaObject = await rows(page.toSQL(page.toDax(q)));
    const text = modelSql(q);
    const viaSql = await sqlModel.query(text).catch(e => { throw new Error(`${e.message}\n${text}`); });
    assert.equal(same(viaSql), same(viaObject), `a SELECT over the model gives the object's rows:\n${text}`);
    return viaObject;
  };
  const base = { rows: [], cols: [], values: [], filters: [], mark: 'auto', totals: true, sort: 'fields' };
  const states = {
    pivot: { rows: ['dim_duid.FuelSourceDescriptor'], cols: ['dim_region.Region'], values: ['Generation MWh'] },
    twoMeasures: { rows: ['dim_calendar.date'], values: ['Generation MWh', 'Average price'],
      filters: [{ field: 'dim_calendar.date', op: 'last', n: 3 }] },
    picked: { rows: ['dim_region.Region'], values: ['Average price'], sort: 'desc',
      filters: [{ field: 'dim_duid.FuelSourceDescriptor', op: 'notIn', values: ['Wind'] }, { field: 'dim_calendar.date', op: 'range', min: '2026-10-01', max: '' }] },
    columnsOnly: { rows: ['dim_duid.FuelSourceDescriptor'], cols: ['dim_duid.Storage'] },
    measuresOnly: { values: ['Generation MWh', 'Units'] },
    fiveMinutes: { rows: ['fct_summary.time'], cols: ['dim_duid.FuelSourceDescriptor'], values: ['Generation MW'],
      filters: [{ field: 'fct_summary.date', op: 'range', min: '2026-10-05', max: '2026-10-06' }] },
  };
  for (const [name, s] of Object.entries(states)) {
    const state = { ...base, ...s };
    const q = buildQuery(state, { today: '2026-10-07' });
    const got = await run(q).catch(e => { throw new Error(`${name}: ${e.message}\n${page.toDax(q)}`); });
    assert.ok(got.length > 0, `${name}: rows`);
    const p = pivot(got, state);
    assert.ok(p.rowKeys.length > 0, `${name}: row keys`);
    assert.ok(autoMark(state, fields));
    if (name === 'pivot') {
      // The grand total is the measure with no group, as the model computes it.
      const [all] = await run({ select: { v: 'Generation MWh' } });
      assert.equal(p.cell(null, null)['Generation MWh'], all.v);
      assert.ok(p.hasRowTotal && p.hasColTotal);
    }
  }
  assert.throws(() => buildQuery({ ...base, rows: ['dim_duid.Region'], cols: ['dim_region.Region'] }), /two fields are named Region/);
  assert.equal(buildQuery(base), null);
  assert.equal(buildQuery({ ...base, ...states.pivot }, { cap: 0 }).top, undefined);
});

// semantic_model/ossie.yaml is read whole: written back from the TMSL it stands for, it is
// itself, so no property of it is one dax-sql's reader passes over (Power BI's model.bim is
// written from that TMSL, scripts/ossie_to_bim.mjs).
test('ossie.yaml reads back as itself', { skip }, () => {
  assert.deepEqual(tmslToOssie(ossieToTmsl(doc), doc.name), doc);
});
