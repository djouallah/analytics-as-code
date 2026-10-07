// Runs DAX through the compiler on DuckDB and returns plain rows.
import { DuckDBInstance } from '@duckdb/node-api';
import { createCompiler } from '../src/index.js';

export async function harness(bim, setup, options = {}) {
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  if (setup) await con.run(setup);
  const dax = createCompiler(bim, options);
  async function sql(text) {
    const r = await con.runAndReadAll(text);
    return r.getRowObjectsJS().map(plain);
  }
  return {
    dax,
    con,
    sql,
    async run(query) {
      const { sql: text, columns } = dax.compile(query);
      try {
        return await sql(text);
      } catch (e) {
        e.message += `\n--- SQL ---\n${text}`;
        e.columns = columns;
        throw e;
      }
    },
    close: () => con.closeSync?.(),
  };
}

function plain(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = value(v);
  return out;
}
function value(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (typeof v === 'number') return Math.round(v * 1e9) / 1e9;
  return v;
}

// Rows in a fixed order, for comparing without ORDER BY.
export function sorted(rows) {
  const key = r => JSON.stringify(Object.values(r).map(v => (v === null ? '' : v)));
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
