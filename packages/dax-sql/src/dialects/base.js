// What the emitter asks of a SQL dialect. The base class writes ANSI SQL where there is one;
// a dialect overrides what its engine spells differently (see duckdb.js). To add an engine,
// extend this class and implement what throws here.
//
// fn(name, args) receives the names below (the `fn` nodes of ir.js), with args as SQL text:
//   logic     isblank coalesce greatest least divide iseven isodd error row
//   math      abs sign sqrt exp ln log log10 power mod quotient round roundup rounddown int trunc
//             ceiling floor mround rand randbetween gcd lcm fact even odd value cast
//   text      left right mid len upper lower trim substitute replace search find rept exact
//             unichar unicode containsstring containsstringexact combinevalues format_date
//             format_number
//   dates     date time year month day hour minute second quarter weekday weeknum eomonth
//             add_interval datediff start_of end_of today now utctoday utcnow
// agg(fn, arg, extra) the aggregates of ir.js: sum avg min max count countrows dcount dcountnb
//   countblank product median pct_inc stdev_s stdev_p var_s var_p concat hasone count0 dcount0
export class Dialect {
  name = 'ansi';

  ident(name) { return `"${String(name).replace(/"/g, '""')}"`; }
  str(v) { return `'${String(v).replace(/'/g, "''")}'`; }
  num(v) {
    if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
    return String(v);
  }
  bool(v) { return v ? 'TRUE' : 'FALSE'; }
  datetime(v) { return /\d:\d/.test(v) ? `TIMESTAMP ${this.str(v)}` : `DATE ${this.str(v)}`; }
  literal(v, t) {
    if (v === null) return 'NULL';
    if (t === 'datetime' || t === 'date') return this.datetime(v);
    if (typeof v === 'boolean') return this.bool(v);
    if (typeof v === 'number') return this.num(v);
    return this.str(v);
  }

  // The SQL type of a DAX type, for CAST.
  type(t) {
    return { int: 'BIGINT', double: 'DOUBLE PRECISION', decimal: 'DECIMAL(19,4)', string: 'VARCHAR', bool: 'BOOLEAN', datetime: 'TIMESTAMP' }[t];
  }
  cast(sql, t) { return `CAST(${sql} AS ${this.type(t)})`; }
  bigint(v) { return `CAST(${this.num(v)} AS BIGINT)`; }

  // a / b as a number with a fraction.
  div(a, b) { return `(CAST(${a} AS DOUBLE PRECISION) / ${b})`; }

  isNotDistinct(a, b) { return `${a} IS NOT DISTINCT FROM ${b}`; }
  isDistinct(a, b) { return `${a} IS DISTINCT FROM ${b}`; }

  // a + b where either can be blank: blank only when both are.
  blankAdd(a, b, sub) {
    return `CASE WHEN ${a} IS NULL AND ${b} IS NULL THEN NULL ELSE COALESCE(${a}, 0) ${sub ? '-' : '+'} COALESCE(${b}, 0) END`;
  }

  // A value as text, the way & joins it.
  text(sql, t) {
    if (t === 'string') return sql;
    if (t === 'bool') return `CASE WHEN ${sql} THEN 'TRUE' ELSE 'FALSE' END`;
    return `CAST(${sql} AS VARCHAR)`;
  }

  // Rows from start to end (inclusive) by step, as a FROM item with one column `name`.
  series() { throw new Error(`${this.name}: series is not implemented`); }

  // The default of a type, which a blank compares as.
  blankOf(t) {
    if (t === 'string') return "''";
    if (t === 'bool') return 'FALSE';
    if (t === 'datetime' || t === 'date') return "DATE '1899-12-30'";
    return '0';
  }

  materialized = '';   // what follows AS in a CTE written once (DuckDB: MATERIALIZED)
  supportsQualify = false;

  fn(name) { throw new Error(`${this.name}: function ${name} is not implemented`); }
  agg(name) { throw new Error(`${this.name}: aggregate ${name} is not implemented`); }
  // Whether agg() takes extra.filter: the aggregate over the rows a condition keeps.
  get aggFilter() { return false; }
}
