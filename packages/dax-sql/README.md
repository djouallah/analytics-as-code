# dax-sql

A DAX compiler for Tabular semantic models. It reads a model (TMSL, the `model.bim` Power BI
and Analysis Services use) and turns DAX queries over it into one SQL query each, with DAX's
semantics: filter context, context transition, relationships, blanks. Tested on DuckDB, with a
dialect layer for other engines.

It replaced the fixed cases of the page's former `dashboard/github/dax/semantic/compiler.js`, which knew
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
- `fieldParameters()`: the model's field parameters, each with its fields in order.
- `expandFieldParameter(table, labels)`: the fields a selection of a field parameter stands
  for (all of them without `labels`), each `{ label, ref, order, kind, name, tableName }`.
  Power BI resolves a field parameter before it writes the query, so a caller does the same:
  it puts these columns or measures in the query where the parameter goes.
- `model`: the model as read.

| Option | |
|---|---|
| `tableSource` | `(table) => SQL` naming a model table's rows. Default: its partition's entity, `"schema"."entity"`. |
| `dialect` | `'duckdb'` (default), or an instance of a `Dialect` subclass. |
| `columnNames` | `'short'` (default): the column's or the expression's name. `'dax'`: `Table[Column]`, `[Measure]`. |
| `castOutput` | `true` (default): whole numbers as `BIGINT`, other numbers as `DOUBLE`. Or an object, by the column's type (`int`, `double`, `decimal`, `datetime`, `string`, `bool`), of a function of its SQL: `{ int: s => \`CAST(${s} AS INTEGER)\` }`; a type it leaves out is not cast. |
| `assumeIntegrity` | `true`: every relationship relies on referential integrity, so a dimension key is read off the fact's foreign key without a join. By default only relationships whose `relyOnReferentialIntegrity` is set are treated this way. |
| `blankRows` | `false`: no blank row for dimensions (see below), which saves a check per dimension. |
| `user` | The value of `USERNAME()` and `USERPRINCIPALNAME()`. |
| `roles` | A role name, or several: row-level security. Each table keeps the rows that at least one of the roles keeps. |
| `params` | The values of the query's parameters (`@name`), by name: numbers, text, booleans, `Date`s or `null` (blank). |

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
- **Modifiers:** `ALL`, `ALLNOBLANKROW`, `REMOVEFILTERS`, `ALLEXCEPT`, `ALLSELECTED`,
  `USERELATIONSHIP` and `CROSSFILTER`. `ALL` on a table clears its expanded table, so
  `ALL(Sales)` also clears the filters on Sales' dimensions.
- **ALLSELECTED** works with shadow filter contexts, as SQLBI's "definitive guide" describes
  them:
  - An iterator (`SUMX`, `FILTER`, `ADDCOLUMNS`, `SUMMARIZE`, …) is a shadow on the columns it
    iterates, holding the values it iterates over. SUMMARIZECOLUMNS is one on the columns it
    groups by, holding their values under its filters (the query's and its filter tables').
  - `ALLSELECTED()` gives every column a shadow covers the filter of the last shadow covering
    it, and leaves the filters on other columns alone. `ALLSELECTED(table)` does the same for
    the table's columns. `ALLSELECTED(column)` gives the column its last shadow's filter, or
    none.
  - As a table, `ALLSELECTED(table)` is the table's rows in that filter context, and
    `ALLSELECTED(column)` is the column's values under its last shadow only (all of its values
    when there is none).
- **Relationships:**
  - A filter reaches a table through many-to-one relationships, read off the expanded table.
  - It also reaches tables through bidirectional and many-to-many relationships, as
    semi-joins.
  - Relationships can be active or inactive. One-to-one relationships filter both ways.
  - A table filter (`FILTER(Sales, …)`) filters its expanded table.
- **Row context:**
  - Iterators create row contexts.
  - A measure is its expression under CALCULATE.
  - Context transition turns every row context into filters, one on each column of the row.
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
- **The blank row:** when some rows of a fact table have a key that matches no row of a
  dimension, DAX adds a blank row to the dimension, and those fact rows belong to it.
  - `VALUES`, `ALL` and `ALLSELECTED` over the dimension list it, and SUMMARIZECOLUMNS groups
    by it. `DISTINCT`, `ALLNOBLANKROW` and the table itself do not. `HASONEVALUE` and
    `SELECTEDVALUE` count it.
  - A filter on the dimension's columns leaves it out, unless the filter keeps blanks: a blank
    in a table filter (`TREATAS({BLANK()}, …)`, or a filter on the fact table that keeps the
    fact rows without a dimension row) keeps it.
  - Its calculated columns are blank too.
  - A table on the one side of a relationship to such a dimension has a blank row as well,
    since the dimension's blank row matches none of its rows. A sale of an unknown product
    belongs to the blank category.
  - The compiler adds a check for such fact rows wherever a dimension's values are listed. A
    relationship that relies on referential integrity, the `assumeIntegrity` option, or
    `blankRows: false` means there are none, and the check is left out.
- **TOPN** keeps rows tied with the last one. **ORDER BY** puts blanks first when ascending.
- `DEFINE MEASURE`, `DEFINE VAR` and `DEFINE TABLE` are supported, as are several `EVALUATE`s
  and lazy `VAR`s. Calculated columns are evaluated per row in an empty filter context.
- **`START AT`** after `ORDER BY` starts the rows at the given values, compared in the order's
  columns and directions as a whole (the first value first, then the next among ties). The
  values are constants or query parameters (`@name`, from `options.params`).

**The model's features.**

- **Calculated tables** are their expression, evaluated once in an empty filter context and
  without row-level security, as Power BI evaluates them when it refreshes the model. Their
  columns are their own: relationships to and from them work like any table's.
  `CALENDARAUTO` takes the years of the model's dates.
- **Calculation groups:**
  - The item the filter context selects replaces a measure, with `SELECTEDMEASURE()` standing
    for the measure. Several groups apply from the highest precedence, outermost.
  - When the selection is only known at run time, the measure has a branch for each item that
    can be selected there. For example, iterating `VALUES` of the group's column under a
    filter of some items has branches for those items only.
  - An item is applied once: under it, measures (those the measure refers to, and those the
    item names) do not get it again. Another item of the group selected inside it does apply
    (sideways recursion), as in a "YOY" item that computes
    `CALCULATE(SELECTEDMEASURE(), 'Time Calc'[Time Calc] = "PY")`.
  - Grouping by the group's column evaluates each item on its row.
  - `multipleOrEmptySelectionExpression` and `noSelectionExpression` are used when set. A
    selection of several items without them leaves the measure as it is.
  - `SELECTEDMEASURENAME`, `SELECTEDMEASUREFORMATSTRING` and `ISSELECTEDMEASURE` work.
  - A column aggregated directly (`SUM(Sales[Amount])` in a query) is not a measure, so no
    item applies to it, as in DAX.
- **Field parameters** are calculated tables of `NAMEOF`s; the table works as a table. What a
  selection of one stands for is resolved by `expandFieldParameter`, as Power BI does it
  before the query.
- **Row-level security** (`options.roles`):
  - Each role's table filters keep that table's rows, and reach other tables along
    relationships as other filters do, onward from table to table.
  - A relationship carries them as its security filtering says: from the one side to the
    many side, both ways, or not at all. A many-to-many relationship carries them too.
  - With several roles, a table keeps the rows that some role keeps.
  - `ALL` and the other modifiers do not bring back rows that security removes.
  - Calculated tables and calculated columns are computed without security, as at refresh.

**Functions.**

- **Aggregates and iterators:** `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT(A/BLANK)`, `COUNTROWS`,
  `DISTINCTCOUNT(NOBLANK)`, `PRODUCT`, `MEDIAN`, `STDEV.S/P`, `VAR.S/P`, `PERCENTILE.INC`;
  their X forms; `CONCATENATEX` and `RANKX`.
- **Filter context:** `CALCULATE`, the modifiers above, `ISFILTERED`, `ISCROSSFILTERED`,
  `ISINSCOPE`, `HASONEVALUE`, `HASONEFILTER`, `SELECTEDVALUE`, `FILTERS`, `LOOKUPVALUE`,
  `CONTAINS`, `CONTAINSROW`, `ISEMPTY`, `IN`.
- **Window functions:** `INDEX`, `OFFSET`, `WINDOW` (`ABS` and `REL`), `RANK` (`DENSE` and
  `SKIP`) and `ROWNUMBER`, with `ORDERBY` (and its `ASC BLANKS LAST` kind of order),
  `PARTITIONBY` (also a related table's column), `MATCHBY`, and the blanks argument.
  - The current row is the row of the relation whose columns hold the outer values: those of
    a row context, or the value the filter context fixes a column to (a group, or a context
    transition). For RANK, only the `ORDERBY` and `PARTITIONBY` columns need one, and the
    rows tied on them share the rank.
  - A column with no outer value takes each of its values in the filter context, and the
    result is the union over them, as DAX does it.
  - Without a relation, the relation is `ALLSELECTED` of the `ORDERBY` and `PARTITIONBY`
    columns.
  - For the other functions, ties in `ORDERBY` are broken by the relation's other columns,
    as DAX does. `ROWNUMBER` over rows that are entirely equal numbers them in an arbitrary
    order, where DAX raises an error.
- **Tables:**
  - building and shaping: `FILTER`, `VALUES`, `DISTINCT`, `ALL…`, `SUMMARIZE`,
    `SUMMARIZECOLUMNS`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `GROUPBY`/`CURRENTGROUP`, `TOPN`;
  - combining: `CROSSJOIN`, `UNION`, `INTERSECT`, `EXCEPT`, `GENERATE(ALL)`, `TREATAS`;
  - constructing: `ROW`, `DATATABLE`, `{ }`, `GENERATESERIES`, `CALENDAR`, `CALENDARAUTO`;
  - `FIRSTNONBLANK`, `LASTNONBLANK`.
- **Time intelligence:**
  - `DATESYTD/QTD/MTD`, `TOTALYTD/QTD/MTD`, `DATESBETWEEN`, `DATESINPERIOD`;
  - `DATEADD` (from the last day of a month to the end of the moved month),
    `SAMEPERIODLASTYEAR`, `PARALLELPERIOD`, `PREVIOUS/NEXT DAY/MONTH/QUARTER/YEAR`;
  - `STARTOF…`, `ENDOF…`, `FIRSTDATE`, `LASTDATE`, `OPENING/CLOSINGBALANCE…`.
- **Values:** logic (`IF`, `SWITCH`, `COALESCE`, `DIVIDE`, …), math, text, dates, `CONVERT`,
  `NAMEOF`.
- **FORMAT** writes numbers and dates as DAX does in en-US:
  - the named formats: `General Number`, `Currency`, `Fixed`, `Standard`, `Percent`,
    `Scientific`, `Yes/No`, `True/False`, `On/Off`, `General Date`, `Long Date`, `Medium
    Date`, `Short Date`, `Long Time`, `Medium Time`, `Short Time`;
  - custom number patterns: `0` and `#`, the point, thousands separators, a comma before the
    point or at the end dividing by 1000, `%`, `E+ E- e+ e-`, literals (`"text"`, `\c`, also
    between the digits as in `(###) ###-####`), and up to three sections (positive; negative;
    zero), a negative value that rounds to zero showing the zero section;
  - rounding at 15 significant digits, then half away from zero (`FORMAT(1.005, "0.00")` is
    `1.01`);
  - custom date patterns: `d` to `dddddd`, `w`, `ww`, `m` to `mmmm`, `q`, `y`, `yy`, `yyyy`,
    `h`, `hh`, `n`, `nn`, `s`, `ss`, `ttttt`, `c`, `AM/PM`, `am/pm`, `A/P`, `a/p`, `AMPM`; `m`
    right after an hour is minutes;
  - a blank is `""` (so a measure that is FORMAT is never blank, and SUMMARIZECOLUMNS keeps
    every group, as in DAX); a date with a number pattern is its serial number.
- **Values as text** (`&`, the text functions) follow DAX too: `0.1 + 0.2` is `0.3` (15
  digits), `1E+20`, `TRUE` is `True`, and a date is `1/5/2024`, with its time when it has one.

## Where it differs from DAX

- **String comparisons and grouping are case-sensitive**, as the SQL engine compares. DAX
  compares text without regard to case.
- **`FORMAT`** handles en-US only (its third argument can be `"en-US"`), and the pattern must
  be a constant. A model's format strings are not applied to the results: numbers come back
  as numbers.
- **A blank stored in the data** (a NULL) doesn't match a blank in a filter given as a table
  (`TREATAS`, or `VALUES` used as a filter). Blank-row and `BLANK()` matches do work: the
  blank row, the blank a fact row with no dimension row reads through the relationship, and
  `BLANK()`. A boolean filter (`T[c] = BLANK()`, `ISBLANK`) does match a stored NULL. It is
  kept this way because matching those NULLs made the page's queries about 25% slower.
- **When one column mixes numbers and text**, the whole column comes back as text. This
  happens with a calculation group that has a text item (a FORMAT item) when grouped by its
  column, and with `IF(c, 1, "x")`.
- **`IFERROR`** returns its first argument, because SQL has no error values.
- **`LOOKUPVALUE`** respects the filters on its table, its search columns replacing theirs.
- **`DATEDIFF` with `WEEK`** counts Sunday week boundaries, as SQL Server does. Microsoft does
  not document which day starts DAX's week.
- **Not supported** (`UNSUPPORTED`):
  - model features: object-level security, dynamic format strings, `DEFINE COLUMN`;
  - query syntax: `ROLLUP` in `SUMMARIZE`;
  - functions: the window functions' reset argument (visual calculations only),
    `NATURALINNERJOIN` and its kind, `TOPNSKIP`, `ADDMISSINGITEMS`, `PERCENTILE.EXC`,
    `SUBSTITUTE` with an instance number, and anything not listed above.

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
| `format.js` | FORMAT's patterns, read into what a dialect writes |
| `dialects/` | what differs between SQL engines: `base.js` (the interface), `duckdb.js`, `duckdb-format.js` |

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
- `test/features.test.js` has 24 more on the same model: calculated tables, calculation
  groups, field parameters, row-level security, ALLSELECTED, `START AT`, the window
  functions, the blank row, context transition and FORMAT.
- `test/repo.test.js` uses this repository's model on made-up data (`test/fixtures/nem.js`):
  - every measure runs in five filter contexts;
  - some values are compared with SQL written by hand;
  - every query the dashboard sends, in six page states, is compared row for row with
    `compiler.js`.

  Where the two differ, this package follows DAX, and the test lists the reason.

## Review

Two separate review agents tried about 500 queries against the six new features (calculated
tables, calculation groups, field parameters and row-level security; ALLSELECTED; `START AT`;
the window functions; the blank row; FORMAT). These are the fixes that matter most:

- **Security leaks:** row-level security didn't pass through relationships set to filter both
  ways for security, or through many-to-many ones. Users could see rows their role should
  hide.
- **A crash** whenever a calculation group's "no selection" or "several selected" expression
  used `SELECTEDMEASURE()`.
- **Iterating a table row:** `ALLEXCEPT` and `REMOVEFILTERS` on the key gave wrong numbers,
  because only the key column was filtered rather than the whole row.
- **An older bug:** `PREVIOUSMONTH` and similar functions ignored the current row of the date
  table.

Each fix has a test. What still differs from DAX is listed under
[Where it differs from DAX](#where-it-differs-from-dax).
