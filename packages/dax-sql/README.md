# dax-sql

A DAX compiler for Tabular semantic models. It reads a model (TMSL, the `model.bim` Power BI
and Analysis Services use) and turns DAX queries over it into one SQL query each, with DAX's
semantics: filter context, context transition, relationships, blanks. Tested on DuckDB, with a
dialect layer for other engines.

It is the general-purpose counterpart of `dashboard/github/semantic/compiler.js`, which knows
this repository's model and page only. That one stays as it is; the page does not use this
package. The page's queries are part of this package's tests.

```js
import { createCompiler } from './src/index.js';

const bim = JSON.parse(fs.readFileSync('semantic_model/model.bim', 'utf8'));
const dax = createCompiler(bim, { tableSource: t => `v_${t.name}` });

const { sql, columns } = dax.compile(`
  EVALUATE SUMMARIZECOLUMNS(dim_duid[FuelSourceDescriptor], "mwh", [Generation MWh], "share", [Renewable share])`);
// sql: one SELECT (with CTEs) to run on DuckDB
// columns: [{ name, dax, type, lineage }]
```

No runtime dependencies; ES modules for the browser and Node 18+.

## API

`createCompiler(bim, options)` returns:

- `compile(dax)`: one `EVALUATE` returns `{ sql, columns }`. It throws a `DaxError` when the
  query has several `EVALUATE`s.
- `compileAll(dax)`: every `EVALUATE` of the query, in order. The same text is compiled once
  and then cached.
- `isDax(text)`: whether a text starts with `DEFINE` or `EVALUATE`.
- `model`: the model as read.

| Option | |
|---|---|
| `tableSource` | `(table) => SQL` naming a model table's rows. Default: its partition's entity, `"schema"."entity"`. |
| `dialect` | `'duckdb'` (default), or an instance of a `Dialect` subclass. |
| `columnNames` | `'short'` (default): the column's or the expression's name. `'dax'`: `Table[Column]`, `[Measure]`. |
| `castOutput` | `true` (default): whole numbers as `BIGINT`, other numbers as `DOUBLE`. |
| `assumeIntegrity` | `true`: every relationship relies on referential integrity, so a dimension key is read off the fact's foreign key without a join. By default only relationships whose `relyOnReferentialIntegrity` is set are treated this way. |
| `blankRows` | `false`: skip the check for a dimension's blank row (see below). |
| `user` | The value of `USERNAME()` and `USERPRINCIPALNAME()`. |

Errors are `DaxError` with a `code`:

- `SYNTAX`: the text is not DAX. The error gives the line and column.
- `SEMANTIC`: valid DAX that is wrong for this model, such as an unknown column or a column
  with no row context.
- `UNSUPPORTED`: valid DAX this compiler does not translate.

It never guesses.

## What it does

**The filter context is DAX's.** The compiler carries the filter context while it compiles,
and gives each aggregate the filters that reach its table.

- **CALCULATE and CALCULATETABLE:**
  - Filter arguments are evaluated in the outer context, then context transition happens, then
    the modifiers, then the filters.
  - A filter replaces the filters on its columns, unless it is wrapped in `KEEPFILTERS`.
  - A filter on a date table's date removes the filters on the rest of that table.
- **Modifiers:** `ALL`, `ALLNOBLANKROW`, `REMOVEFILTERS`, `ALLEXCEPT`, `ALLSELECTED` (the
  query's own filters), `USERELATIONSHIP` and `CROSSFILTER`. `ALL` on a table clears its
  expanded table, so `ALL(Sales)` also clears the filters on Sales' dimensions.
- **Relationships:**
  - A filter reaches a table through many-to-one relationships, read off the expanded table.
  - It also reaches tables through bidirectional and many-to-many relationships, as
    semi-joins.
  - Relationships can be active or inactive. One-to-one relationships filter both ways.
  - A table filter (`FILTER(Sales, …)`) filters its expanded table.
- **Row context:**
  - Iterators create row contexts.
  - A measure is its expression under CALCULATE.
  - Context transition turns every row context into filters.
  - `EARLIER`, `RELATED` and `RELATEDTABLE` work.
- **Blanks follow DAX's rules:**
  - `BLANK() + 1` is 1, `BLANK() * 2` is blank, `BLANK() = 0` is true and `BLANK() == 0` is
    false.
  - `"x" & BLANK()` is `"x"`.
  - `COUNTROWS` and `DISTINCTCOUNT` of nothing are blank, and `DISTINCTCOUNT` counts a blank
    as a value.
  - `1 / BLANK()` is infinity.
- **SUMMARIZECOLUMNS:**
  - Its groups are the key combinations that exist within each table, and every combination
    across tables.
  - A group whose expressions are all blank is left out (`IGNORE` excludes an expression from
    that test).
  - Filter tables, `ROLLUPADDISSUBTOTAL`/`ROLLUPGROUP`, and `ISINSCOPE` are supported.
- **The blank row:** fact rows whose key matches no dimension row group under a blank key.
  When the groups come from a dimension's values, its blank row is listed too, if there are
  such fact rows.
- **TOPN** keeps rows tied with the last one. **ORDER BY** puts blanks first when ascending.
- `DEFINE MEASURE`, `DEFINE VAR` and `DEFINE TABLE` are supported, as are several `EVALUATE`s
  and lazy `VAR`s. Calculated columns are evaluated per row in an empty filter context.

**Functions.**

- **Aggregates and iterators:** `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT(A/BLANK)`, `COUNTROWS`,
  `DISTINCTCOUNT(NOBLANK)`, `PRODUCT`, `MEDIAN`, `STDEV.S/P`, `VAR.S/P`, `PERCENTILE.INC`;
  their X forms; `CONCATENATEX` and `RANKX`.
- **Filter context:** `CALCULATE`, the modifiers above, `ISFILTERED`, `ISCROSSFILTERED`,
  `ISINSCOPE`, `HASONEVALUE`, `HASONEFILTER`, `SELECTEDVALUE`, `FILTERS`, `LOOKUPVALUE`,
  `CONTAINS`, `CONTAINSROW`, `ISEMPTY`, `IN`.
- **Tables:**
  - building and shaping: `FILTER`, `VALUES`, `DISTINCT`, `ALL…`, `SUMMARIZE`,
    `SUMMARIZECOLUMNS`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `GROUPBY`/`CURRENTGROUP`, `TOPN`;
  - combining: `CROSSJOIN`, `UNION`, `INTERSECT`, `EXCEPT`, `GENERATE(ALL)`, `TREATAS`;
  - constructing: `ROW`, `DATATABLE`, `{ }`, `GENERATESERIES`, `CALENDAR`;
  - `FIRSTNONBLANK`, `LASTNONBLANK`.
- **Time intelligence:**
  - `DATESYTD/QTD/MTD`, `TOTALYTD/QTD/MTD`, `DATESBETWEEN`, `DATESINPERIOD`;
  - `DATEADD` (from the last day of a month to the end of the moved month),
    `SAMEPERIODLASTYEAR`, `PARALLELPERIOD`, `PREVIOUS/NEXT DAY/MONTH/QUARTER/YEAR`;
  - `STARTOF…`, `ENDOF…`, `FIRSTDATE`, `LASTDATE`, `OPENING/CLOSINGBALANCE…`.
- **Values:** logic (`IF`, `SWITCH`, `COALESCE`, `DIVIDE`, …), math, text, dates, `CONVERT`,
  and `FORMAT` with the common date and number patterns.

## Where it differs from DAX

- **String comparisons and grouping are case-sensitive**, as the SQL engine compares. DAX
  compares text without regard to case.
- **The blank row is listed only by SUMMARIZECOLUMNS.** `VALUES` and `ALL` over a dimension do
  not include it.
- **`ALLSELECTED`** restores the filters the query set outside SUMMARIZECOLUMNS' grouping. DAX's
  shadow filter contexts are not modelled further.
- **Number to text** (`&`, `FORMAT` without a pattern) does not follow DAX's locale formats.
  `IFERROR` returns its first argument, because SQL has no error values.
- **`LOOKUPVALUE`** respects the filters on its table, its search columns replacing theirs.
- **`DATEDIFF` with `WEEK`** counts Sunday week boundaries, as SQL Server does. Microsoft does
  not document which day starts DAX's week.
- **Not supported** (`UNSUPPORTED`):
  - model features: calculated tables, calculation groups, field parameters, row-level
    security, `DEFINE COLUMN`;
  - query syntax: `START AT`, `ROLLUP` in `SUMMARIZE`;
  - functions: `INDEX`, `OFFSET`, `WINDOW`, `NATURALINNERJOIN` and its kind, `TOPNSKIP`,
    `ADDMISSINGITEMS`, `PERCENTILE.EXC`, `SUBSTITUTE` with an instance number, and anything
    not listed above.

## How it works

`src/`, in the order a query goes through it (DESIGN.md has the detail):

| File | |
|---|---|
| `lexer.js`, `parser.js` | DAX text into a syntax tree |
| `model.js` | the TMSL model: tables, columns, measures, relationships; expanded tables and filter propagation |
| `compiler.js` | the tree into an intermediate form, with the filter context as a value (`context.js`) |
| `functions/` | the function library, by kind |
| `ir.js` | the intermediate form: scalars, tables, rows, aggregates over scans |
| `emit.js` | the intermediate form into SQL |
| `dialects/` | what differs between SQL engines: `base.js` (the interface), `duckdb.js` |

The SQL it writes:

- An aggregate is a scalar subquery over its table's rows under its filters, correlated to the
  rows it reads; DuckDB decorrelates those subqueries.
- The aggregates of SUMMARIZECOLUMNS and ROW are fused where they can be. Those over the same
  table under the same filters become one `GROUP BY` in a CTE, joined to the groups.
- `VALUES` of a column the context binds to one value is that value, not a scan. That turns
  per-group subqueries like this model's "days the daily table lacks" into fused groups.

To add an engine, extend `Dialect` in `src/dialects/base.js` (it lists the functions and
aggregates to write) and pass an instance as `dialect`.

## Tests

```sh
npm install   # DuckDB for Node, for the tests only
npm test
```

- `test/semantics.test.js` has 54 tests on a small sales model (`test/fixtures/contoso.js`).
  The model has 11 sales, so every expected result was worked out by hand.
- `test/repo.test.js` uses this repository's model on made-up data (`test/fixtures/nem.js`):
  - every measure runs in five filter contexts;
  - some values are compared with SQL written by hand;
  - every query the dashboard sends, in six page states, is compared row for row with
    `compiler.js`.

  Where the two differ, this package follows DAX, and the test lists the reason.
