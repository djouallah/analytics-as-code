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
//   castOutput     true (the default): whole numbers as BIGINT, numbers as DOUBLE; or, by
//                  the column's type, a function of its SQL ({ int: s => `CAST(${s} AS INTEGER)` })
//   assumeIntegrity  true: every relationship relies on referential integrity, so a
//                  dimension's key is read off the fact's foreign key with no join (by
//                  default only those whose relyOnReferentialIntegrity says so)
//   blankRows      false: no blank row for a dimension whose keys some fact rows miss (VALUES,
//                  ALL and SUMMARIZECOLUMNS list it otherwise; this saves a check per table)
//   user           the value of USERNAME() and USERPRINCIPALNAME()
//   roles          the names of the model's roles to query as (row-level security): every
//                  table's rows are those some role keeps
//   params         the values of query parameters (@name), by name
import { Model } from './model.js';
import { Compiler } from './compiler.js';
import { Emitter } from './emit.js';
import { parseExpression } from './parser.js';
import { DuckDBDialect } from './dialects/duckdb.js';
import { Dialect } from './dialects/base.js';
import { newRow } from './ir.js';
import { DaxError, semantic } from './errors.js';
import { Ctx } from './context.js';

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

  // A calculated table: its expression in an empty filter context.
  const tables = new Map();
  const calcTable = table => {
    let t = tables.get(table);
    if (t === 'busy') throw new DaxError(`calculated table '${table.name}' refers to itself`);
    if (!t) {
      tables.set(table, 'busy');
      try { t = base.table(parseExpression(table.calc), base.env()); } catch (e) {
        tables.delete(table);
        if (e instanceof DaxError) e.message = `calculated table '${table.name}': ${e.message}`;
        throw e;
      }
      tables.set(table, t);
    }
    return t;
  };

  // Row-level security: each role's table filters, as predicates on a row of their table.
  const roleNames = options.roles == null ? [] : [options.roles].flat();
  const security = roleNames.map(name => {
    const role = model.roles.find(r => r.name.toLowerCase() === String(name).toLowerCase());
    if (!role) throw semantic(`the model has no role ${name}`);
    return {
      name: role.name,
      filters: role.filters.map(f => {
        const row = newRow(f.table.columns.map(x => ({ name: x.name, lineage: x, t: x.type })), 'scan', { base: f.table });
        let ast;
        try { ast = parseExpression(f.text); } catch (e) {
          if (e instanceof DaxError) e.message = `role ${role.name}, '${f.table.name}': ${e.message}`;
          throw e;
        }
        return { table: f.table, row, pred: base.scalar(ast, base.env({ rows: [row] })) };
      }),
    };
  }).map(role => ({
    ...role,
    // As a filter context: each table filter a predicate on its table's columns, moving along
    // the relationships as security does.
    ctx: new Ctx(role.filters.map(f => ({ kind: 'pred', cols: f.table.columns, row: f.row, pred: f.pred })),
      { security: true, active: new Map(), cross: new Map() }),
  }));

  const cache = new Map();
  function compileAll(dax) {
    let out = cache.get(dax);
    if (out) return out;
    const statements = base.query(dax);
    out = statements.map(s => new Emitter(model, dialect, { ...options, calcColumn, calcTable, security }).query(s));
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
    fieldParameters: () => fieldParameters(model),
    // The fields a field parameter's selection stands for (all of them without `labels`), in
    // its order: what Power BI puts in a visual's query in the parameter's place.
    expandFieldParameter(table, labels = null) {
      const p = fieldParameters(model).find(x => x.table.toLowerCase() === String(table).toLowerCase());
      if (!p) throw semantic(`'${table}' is not a field parameter`);
      const keep = labels && new Set([labels].flat().map(l => String(l).toLowerCase()));
      return p.fields.filter(f => !keep || keep.has(String(f.label).toLowerCase()));
    },
  };
}

// The field parameters of the model: calculated tables like
//   { ("Sales", NAMEOF('Sales'[Sales Amount]), 0), ... }
// whose fields column Power BI marks (ParameterMetadata). Each field: its label, its DAX
// reference, its order, and whether it names a column or a measure.
function fieldParameters(model) {
  const out = [];
  for (const t of model.tables.values()) {
    const fieldsCol = t.columns.find(c => c.fieldParameter);
    if (!t.calc || !fieldsCol) continue;
    const ast = parseExpression(t.calc);
    if (ast.k !== 'table') continue;
    const at = c => Number(/Value(\d+)\]?$/i.exec(c.source)?.[1] ?? 0) - 1;
    const iField = at(fieldsCol);
    const labelCol = t.columns.find(c => at(c) === (iField === 0 ? 1 : 0));
    const orderCol = t.columns.find(c => c !== fieldsCol && c !== labelCol && at(c) >= 0);
    const cell = x => {
      if (x.k === 'str' || x.k === 'num') return x.k === 'num' ? Number(x.v) : x.v;
      if (x.k === 'call' && x.fn === 'NAMEOF' && x.args[0]?.k === 'col') return model.nameOf(x.args[0]);
      return null;
    };
    const fields = ast.rows.map(r => {
      const ref = cell(r[iField]);
      const m = /^'(.*)'\[(.*)\]$/.exec(ref ?? '');
      const isMeasure = m && model.measure(m[2]) && !model.findColumn(m[1], m[2]);
      return { label: labelCol ? cell(r[at(labelCol)]) : ref, ref, order: orderCol ? cell(r[at(orderCol)]) : null,
        kind: isMeasure ? 'measure' : 'column', name: m?.[2] ?? null, tableName: m?.[1] ?? null };
    }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    out.push({ table: t.name, label: labelCol?.name ?? null, fields: fieldsCol.name, order: orderCol?.name ?? null, fields_: fields });
  }
  return out.map(p => ({ table: p.table, labelColumn: p.label, fieldsColumn: p.fields, orderColumn: p.order, fields: p.fields_ }));
}
