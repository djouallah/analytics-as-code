// DuckDB (1.1 and later; tested on 1.5).
import { Dialect } from './base.js';
import { unsupported } from '../errors.js';
import { formatNumber, formatDate, generalNumber, generalDate, dateSerial, serialDate } from './duckdb-format.js';

const UNIT_SQL = { day: 'DAY', week: 'WEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND' };

export class DuckDBDialect extends Dialect {
  name = 'duckdb';
  materialized = 'MATERIALIZED ';
  supportsQualify = true;

  type(t) { return t === 'double' ? 'DOUBLE' : super.type(t); }

  // / divides as DOUBLE already.
  div(a, b) { return `(${a} / ${b})`; }

  // list_sum skips blanks and is blank when all are: DAX's + in one expression, each side once.
  blankAdd(a, b, sub) { return `list_sum([${a}, ${sub ? `-(${b})` : b}])`; }

  // As DAX converts: 3.0 as "3", 0.1 + 0.2 as "0.3" (15 digits), 1E+20; a date as 1/5/2024, with
  // the time when it is not midnight; TRUE as "True".
  text(sql, t) {
    if (t === 'double' || t === 'decimal' || t === 'bool') return generalNumber(sql, t);
    if (t === 'datetime' || t === 'date') return `[${generalDate('dax_tv')} FOR dax_tv IN [${sql}]][1]`;
    return super.text(sql, t);
  }

  series(start, end, step, t) {
    if (t === 'datetime') return `(SELECT CAST(unnest(generate_series(CAST(${start} AS TIMESTAMP), CAST(${end} AS TIMESTAMP), INTERVAL (${step}) DAY)) AS DATE) AS v)`;
    if (t === 'int') return `(SELECT unnest(generate_series(${start}, ${end}, ${step})) AS v)`;
    // A step with a fraction: start + step * i.
    return `(SELECT ${start} + ${step} * i AS v FROM range(0, CAST(floor((${end} - (${start})) / (${step}) + 1e-9) AS BIGINT) + 1) r(i))`;
  }

  fn(name, a, nodes = []) {
    // A text function given a number reads it as text, as DAX converts it.
    const TEXT = { left: [0], right: [0], mid: [0], len: [0], upper: [0], lower: [0], trim: [0], substitute: [0, 1, 2], replace: [0, 3],
      search: [0, 1], find: [0, 1], rept: [0], exact: [0, 1], unicode: [0], containsstring: [0, 1], containsstringexact: [0, 1] };
    if (TEXT[name]) a = a.map((v, i) => (TEXT[name].includes(i) && nodes[i] && nodes[i].t !== 'string' && nodes[i].t !== 'blank' ? this.text(v, nodes[i].t) : v));
    const [x, y, z, w] = a;
    switch (name) {
      case 'isblank': return `(${x} IS NULL)`;
      case 'coalesce': return `COALESCE(${a.join(', ')})`;
      case 'greatest': return `greatest(${a.join(', ')})`;
      case 'least': return `least(${a.join(', ')})`;
      case 'divide': return a.length === 2 ? `(${x} / NULLIF(${y}, 0))`
        : `CASE WHEN COALESCE(${y}, 0) = 0 THEN ${z} ELSE ${x} / ${y} END`;
      case 'iseven': return `(CAST(trunc(${x}) AS BIGINT) % 2 = 0)`;
      case 'isodd': return `(CAST(trunc(${x}) AS BIGINT) % 2 <> 0)`;
      case 'error': return `error(${x})`;
      case 'row': return `row(${a.join(', ')})`;
      // math
      case 'abs': case 'sign': case 'sqrt': case 'exp': case 'ln': case 'log10': case 'gcd': case 'lcm':
        return `${name}(${a.join(', ')})`;
      case 'log': return `(ln(${x}) / ln(${y}))`;
      case 'power': return `power(${x}, ${y})`;
      case 'mod': return `(${x} - ${y} * floor(${x} / ${y}))`;
      case 'quotient': return `CAST(trunc(${x} / ${y}) AS BIGINT)`;
      case 'round': return `round(${x}, CAST(${y} AS INTEGER))`;
      case 'roundup': return `(sign(${x}) * ceil(abs(${x}) * power(10, ${y})) / power(10, ${y}))`;
      case 'rounddown': case 'trunc': return `(trunc(${x} * power(10, ${y})) / power(10, ${y}))`;
      case 'int': return `CAST(floor(${x}) AS BIGINT)`;
      case 'ceiling': return y ? `(ceil(${x} / ${y}) * ${y})` : `ceil(${x})`;
      case 'floor': return y ? `(floor(${x} / ${y}) * ${y})` : `floor(${x})`;
      case 'mround': return `(round(${x} / ${y}) * ${y})`;
      case 'rand': return 'random()';
      case 'randbetween': return `CAST(floor(random() * (${y} - ${x} + 1)) + ${x} AS BIGINT)`;
      case 'fact': return `factorial(CAST(${x} AS INTEGER))`;
      case 'even': return `CAST(sign(${x}) * ceil(abs(${x}) / 2) * 2 AS BIGINT)`;
      case 'odd': return `CAST(sign(${x}) * (ceil((abs(${x}) + 1) / 2) * 2 - 1) AS BIGINT)`;
      case 'value': return `CAST(${x} AS DOUBLE)`;
      case 'cast': return this.cast(x, JSON.parse(y.replace(/^'|'$/g, '"')));
      // text
      case 'left': return `left(${x}, ${y ?? 1})`;
      case 'right': return `right(${x}, ${y ?? 1})`;
      case 'mid': return `substring(${x}, ${y}, ${z})`;
      case 'len': return `length(COALESCE(${x}, ''))`;
      case 'upper': return `upper(${x})`;
      case 'lower': return `lower(${x})`;
      case 'trim': return `regexp_replace(trim(${x}), ' {2,}', ' ', 'g')`;
      case 'substitute': return `replace(${x}, ${y}, ${z})`;
      case 'replace': return `(left(${x}, ${y} - 1) || ${w} || substring(${x}, ${y} + ${z}))`;
      case 'search': case 'find': {
        const low = s => (name === 'search' ? `lower(${s})` : s);
        const pos = `instr(${low(`substring(${y}, ${z})`)}, ${low(x)})`;
        return `CASE WHEN ${pos} = 0 THEN ${w} ELSE ${pos} + ${z} - 1 END`;
      }
      case 'rept': return `repeat(${x}, CAST(${y} AS INTEGER))`;
      case 'exact': return `(COALESCE(${x}, '') = COALESCE(${y}, ''))`;
      case 'unichar': return `chr(CAST(${x} AS INTEGER))`;
      case 'unicode': return `unicode(${x})`;
      case 'containsstring': return `contains(lower(COALESCE(${x}, '')), lower(COALESCE(${y}, '')))`;
      case 'containsstringexact': return `contains(COALESCE(${x}, ''), COALESCE(${y}, ''))`;
      case 'combinevalues': return `concat_ws(${x}, ${a.slice(1).map((v, i) => `COALESCE(${nodes[i + 1] ? this.text(v, nodes[i + 1].t) : `CAST(${v} AS VARCHAR)`}, '')`).join(', ')})`;
      case 'format_date': return formatDate(x, JSON.parse(nodes[1].v));
      case 'format_number': return formatNumber(x, JSON.parse(nodes[1].v), nodes[0].t);
      case 'date_serial': return dateSerial(x);
      case 'serial_date': return serialDate(x);
      // dates
      case 'date': return `CAST(make_date(CAST(${x} AS BIGINT), 1, 1) + to_months(CAST(${y} AS INTEGER) - 1) + to_days(CAST(${z} AS INTEGER) - 1) AS DATE)`;
      // A time is a date and time on day zero (1899-12-30), as in DAX.
      case 'time': return `(DATE '1899-12-30' + make_time(CAST(${x} AS BIGINT), CAST(${y} AS BIGINT), CAST(${z} AS DOUBLE)))`;
      // A date and time plus another: the second's time since day zero added to the first.
      case 'add_datetimes': {
        const z0 = "TIMESTAMP '1899-12-30'", T = v => `COALESCE(CAST(${v} AS TIMESTAMP), ${z0})`;
        return `CASE WHEN ${x} IS NULL AND ${y} IS NULL THEN NULL ELSE ${T(x)} + (${T(y)} - ${z0}) END`;
      }
      case 'year': case 'month': case 'day': case 'hour': case 'minute': case 'second': case 'quarter':
        return `${name}(${x})`;
      case 'weekday': return `CASE CAST(${y} AS INTEGER) WHEN 2 THEN isodow(${x}) WHEN 3 THEN isodow(${x}) - 1 ELSE dayofweek(${x}) + 1 END`;
      case 'weeknum': return `CASE WHEN CAST(${y} AS INTEGER) = 21 THEN weekofyear(${x})
        WHEN CAST(${y} AS INTEGER) = 2 THEN CAST(floor((dayofyear(${x}) - 1 + isodow(make_date(year(${x}), 1, 1)) - 1) / 7) + 1 AS BIGINT)
        ELSE CAST(floor((dayofyear(${x}) - 1 + dayofweek(make_date(year(${x}), 1, 1))) / 7) + 1 AS BIGINT) END`;
      case 'eomonth': return `last_day(${x} + to_months(CAST(${y} AS INTEGER)))`;
      case 'add_interval': {
        const u = unit(z);
        if (u === 'DAY') return `(${x} + to_days(CAST(${y} AS INTEGER)))`;
        if (u === 'WEEK') return `(${x} + to_days(7 * CAST(${y} AS INTEGER)))`;
        if (u === 'MONTH' || u === 'QUARTER' || u === 'YEAR') return `(${x} + to_months(${u === 'YEAR' ? 12 : u === 'QUARTER' ? 3 : 1} * CAST(${y} AS INTEGER)))`;
        return `(${x} + INTERVAL (${y}) ${u})`;
      }
      case 'datediff': {
        const u = unit(z).toLowerCase();
        // Weeks that start on Sunday (as SQL Server's DATEDIFF counts them).
        if (u === 'week') return `(date_diff('day', CAST(${x} AS DATE) - CAST(dayofweek(${x}) AS INTEGER), CAST(${y} AS DATE) - CAST(dayofweek(${y}) AS INTEGER)) // 7)`;
        return `date_diff('${u}', ${x}, ${y})`;
      }
      case 'start_of': return `CAST(date_trunc('${unit(y).toLowerCase()}', ${x}) AS DATE)`;
      case 'end_of': {
        const u = unit(y);
        if (u === 'MONTH') return `last_day(${x})`;
        if (u === 'DAY') return `CAST(${x} AS DATE)`;
        return `CAST(date_trunc('${u.toLowerCase()}', ${x}) + to_months(${u === 'YEAR' ? 12 : 3}) - to_days(1) AS DATE)`;
      }
      case 'today': return 'current_date';
      case 'now': return 'CAST(now() AS TIMESTAMP)';
      case 'utctoday': return "CAST(timezone('UTC', now()) AS DATE)";
      case 'utcnow': return "timezone('UTC', now())";
    }
    return super.fn(name, a);
  }

  // extra.filter: the aggregate over the rows that condition keeps (FILTER on each call).
  get aggFilter() { return true; }
  agg(fn, x, extra = {}) {
    const f = extra.filter ? ` FILTER (WHERE ${extra.filter})` : '';
    switch (fn) {
      case 'sum': return `SUM(${x})${f}`;
      case 'avg': return `AVG(${x})${f}`;
      case 'min': return `MIN(${x})${f}`;
      case 'max': return `MAX(${x})${f}`;
      case 'count': return `NULLIF(COUNT(${x})${f}, 0)`;
      case 'count0': return `COUNT(${x})${f}`;
      case 'countrows': return `NULLIF(COUNT(*)${f}, 0)`;
      // DAX counts a blank as a value.
      case 'dcount': return `(COUNT(DISTINCT ${x})${f} + MAX(CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END)${f})`;
      case 'dcount0': return `COUNT(DISTINCT ${x})${f}`;
      case 'dcountnb': return `NULLIF(COUNT(DISTINCT ${x})${f}, 0)`;
      case 'countblank': return `NULLIF(COUNT(*) FILTER (WHERE ${x} IS NULL${extra.filter ? ` AND ${extra.filter}` : ''}), 0)`;
      case 'hasone': return `COALESCE(COUNT(DISTINCT ${x})${f} + MAX(CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END)${f} = 1, FALSE)`;
      case 'product': return `product(${x})${f}`;
      case 'median': return `median(${x})${f}`;
      case 'pct_inc': return `quantile_cont(${x}, ${extra.k})${f}`;
      case 'stdev_s': return `stddev_samp(${x})${f}`;
      case 'stdev_p': return `stddev_pop(${x})${f}`;
      case 'var_s': return `var_samp(${x})${f}`;
      case 'var_p': return `var_pop(${x})${f}`;
      case 'concat': return `string_agg(COALESCE(${x}, ''), ${extra.delim}${extra.order?.length ? ` ORDER BY ${extra.order.join(', ')}` : ''})${f}`;
      case 'pct_exc': throw unsupported('PERCENTILE.EXC on DuckDB');
    }
    return super.agg(fn, x);
  }
}

function unit(sqlStr) {
  const u = UNIT_SQL[String(sqlStr).replace(/'/g, '').toLowerCase()];
  if (!u) throw new Error(`unknown unit ${sqlStr}`);
  return u;
}
