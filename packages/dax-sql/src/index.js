// dax-sql: DAX queries over a Tabular semantic model (TMSL, model.bim) -> SQL.
//
//   import { createCompiler } from 'dax-sql';
//   const dax = createCompiler(bim, { tableSource: t => `v_${t.name}` });
//   const { sql, columns } = dax.compile('EVALUATE SUMMARIZECOLUMNS(...)');
//
// Options:
//   dialect        'duckdb' (the default) or a Dialect instance (see dialects/base.js)
//   tableSource    (table) => SQL that names a model table's rows; by default its partition's
//                  entity ("schema"."entity"), else its name
//   columnNames    'short' (the default: the column or the expression's name) or 'dax'
//                  ('Table'[Column], [Measure]) for the result's columns
//   castOutput     true (the default): whole numbers as BIGINT, numbers as DOUBLE
//   assumeIntegrity  true: every relationship relies on referential integrity, so a
//                  dimension's key is read off the fact's foreign key with no join (by
//                  default only those whose relyOnReferentialIntegrity says so)
//   blankRows      false: no blank row for a dimension whose keys some fact rows miss, when
//                  SUMMARIZECOLUMNS lists a dimension's values (saves a check per table)
//   user           the value of USERNAME() and USERPRINCIPALNAME()
import { Model } from './model.js';
import { Compiler } from './compiler.js';
import { Emitter } from './emit.js';
import { parseExpression } from './parser.js';
import { DuckDBDialect } from './dialects/duckdb.js';
import { Dialect } from './dialects/base.js';
import { newRow } from './ir.js';
import { DaxError } from './errors.js';

export { DaxError } from './errors.js';
export { Dialect } from './dialects/base.js';
export { DuckDBDialect } from './dialects/duckdb.js';
export { parseQuery, parseExpression } from './parser.js';
export { Model } from './model.js';

const DIALECTS = { duckdb: () => new DuckDBDialect() };

export function createCompiler(bim, options = {}) {
  const model = bim instanceof Model ? bim : new Model(bim);
  const dialect = options.dialect instanceof Dialect ? options.dialect : DIALECTS[options.dialect ?? 'duckdb']?.();
  if (!dialect) throw new DaxError(`unknown dialect ${options.dialect}`);
  const base = new Compiler(model, options);

  // A calculated column: its expression on a row of its table, in an empty filter context.
  const calc = new Map();
  const calcColumn = col => {
    let c = calc.get(col);
    if (!c) {
      const row = newRow(col.table.columns.map(x => ({ name: x.name, lineage: x, t: x.type })), 'scan', { base: col.table });
      calc.set(col, { busy: true });
      let ast;
      try { ast = parseExpression(col.expr); } catch (e) {
        calc.delete(col);
        if (e instanceof DaxError) e.message = `calculated column '${col.table.name}'[${col.name}]: ${e.message}`;
        throw e;
      }
      c = { row, expr: base.scalar(ast, base.env({ rows: [row] })) };
      calc.set(col, c);
    }
    if (c.busy) throw new DaxError(`calculated column '${col.table.name}'[${col.name}] refers to itself`);
    return c;
  };

  const cache = new Map();
  function compileAll(dax) {
    let out = cache.get(dax);
    if (out) return out;
    const statements = base.query(dax);
    out = statements.map(s => new Emitter(model, dialect, { ...options, calcColumn }).query(s));
    if (cache.size >= 500) cache.clear();
    cache.set(dax, out);
    return out;
  }

  return {
    model,
    dialect,
    // One EVALUATE -> { sql, columns: [{ name, dax, type, lineage }] }.
    compile(dax) {
      const out = compileAll(dax);
      if (out.length !== 1) throw new DaxError(`the query has ${out.length} EVALUATE statements; use compileAll`);
      return out[0];
    },
    compileAll,
    // Whether a text is a DAX query (it starts with DEFINE or EVALUATE).
    isDax: text => /^\s*(DEFINE|EVALUATE)\b/i.test(text),
  };
}
