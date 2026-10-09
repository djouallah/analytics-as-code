# Design

## The problem

DAX has no direct SQL equivalent. A measure is evaluated in a filter context that the query
sets: the groups of SUMMARIZECOLUMNS, CALCULATE's filters, and context transition from the
rows of an iterator. That context reaches a table only along its relationships. SQL has none
of this.

`compiler.js` (the page's) writes the SQL for the constructs the page uses, case by case.
This package translates DAX's rules instead, so that a query it has not seen comes out right.

## The approach

The approach chosen is the filter context as a value at compile time, with SQL that is
correlated and then fused. Two alternatives were set aside:

- **A cost-based planner**, which splits work into formula-engine and storage-engine queries
  as VertiPaq does. It would write faster SQL, but at several times the work.
- **An interpreter in JavaScript** over rows fetched from the engine. That is not a compiler,
  and it moves the data to the browser.

The compiler walks the DAX with an environment holding:

- the filter context;
- the row contexts;
- the variables in scope;
- the columns SUMMARIZECOLUMNS groups by;
- the shadow filter context, which ALLSELECTED restores;
- the measures being expanded, and the calculation items applied to them.

Wherever DAX would change the filter context at run time, the compiler builds a new one at
compile time. Every aggregate ends up as "the rows of model table T that this filter context
keeps, aggregated".

### The filter context

A filter constrains some model columns (`context.js`) in one of three ways:

- **`bind`**: a column equals a value. Context transition and group keys produce these. The
  value can be an outer row's column, so the SQL is correlated.
- **`pred`**: a predicate on the columns, for a boolean CALCULATE filter like `T[c] > 5`. It
  is `FILTER(ALL(T[c]), …)` read on each row.
- **`rel`**: the rows of a table, matched on its columns' lineage, for a table filter
  (`TREATAS`, `VALUES`, `FILTER(…)`). Rows of a model table (`FILTER(Sales, …)`) filter its
  expanded table.

Removing filters from columns (`ALL`, or a new filter on the same column) keeps what a filter
says about its other columns (`narrow`).

Context transition on a row of a model table binds each of its columns. With a key, the
other columns' binds are `implied` by the key's: they are not written while the key's bind
is in the context, and are once something removes it (ALLEXCEPT, REMOVEFILTERS of the key).

CALCULATE (`compiler.js`, `calculateCtx`) works in four steps:

1. It evaluates the filter arguments in the outer context.
2. It turns the row contexts into binds.
3. It applies the relationship modifiers, then the removals.
4. It removes what the context said about the filters' columns (unless `KEEPFILTERS`) and
   adds the filters.

A filter on a date table's date column also clears the rest of that table.

**ALLSELECTED.** The environment holds the shadow filter contexts, innermost last. Each one
covers some columns and says what values they had:

- An iterator's (`iter`) covers the columns of the table it iterates that have a lineage. Its
  values are that table's rows.
- SUMMARIZECOLUMNS' covers the columns it groups by. Its values are theirs under its filters.

`ALLSELECTED` (`allSelected`) removes the filters on each column it acts on that a shadow
covers, and adds the filter of the last shadow that covers it (`shadowFilter`):

- When the shadow's values are some columns' values under a filter context (VALUES, ALL, a
  table's rows, SUMMARIZECOLUMNS), and every filter of that context the current one lacks is
  on those columns only, the filter is those filters put back. Any row they allow has values
  in the shadow, so this is exact, and it is the SQL the query had before.
- When the shadow's values are other rows (a FILTER, say), the filter is those rows.
- Otherwise it is `VALUES` of the columns under the shadow's filter context.

Columns no shadow covers keep their filters, or lose them for `ALLSELECTED(column)`. As a
table, `ALLSELECTED(column)` starts from no filter at all.

### The model's features

- **Calculated tables** are compiled once each (`index.js`, `calcTable`) in an empty
  environment. The SQL writes each as a `MATERIALIZED` CTE whose columns are renamed to the
  model's, so that a scan reads it as it reads any table's rows. It is written without the
  query's filters and without row-level security.
- **Calculation groups** are applied where a measure is referenced (`applyGroups`), from the
  highest precedence. What a group's filters select is read off the filter context:
  - Filters known at compile time (a constant, a predicate on the group's column, a table of
    constants) keep the items they allow. One item replaces the measure. Several, or none,
    take the group's selection expressions, or else leave the measure alone.
  - A filter known only at run time (SUMMARIZECOLUMNS grouping by the group's column) makes
    the measure a `CASE` on the group's selected value, with a branch per item. Inside a
    branch the selection is known (`withKnown`), so the measures under it do not branch again.
  - The branches are only for the items the filter can select (`filterItems`). A bind to a
    row of a table, a predicate comparing the column with another row's column, and a table
    filter are read back to the table their values come from (`itemsOfTable`): the group's
    rows under some filters, a FILTER of them, constants. An item returning text then does not
    make the other items' numbers text where it cannot be selected.
  - The items applied are carried along (`cgApplied`), into the measures under the item and
    the measures it names. An item already applied is skipped, as DAX ignores a second
    application of the same item.
- **Row-level security.** Each role's table filters are compiled as predicates on a row of
  their table, and make up a filter context of their own. Its relationships are those
  security moves along (`securityState`): each active one from its one side to its many side,
  both ways, or not at all, as its security filtering behavior says. `securityConds` writes
  that context's conditions on every scan with the code that writes any filter context's
  (`conds`). The filters then reach the scan from its expanded table, and as semi-joins across
  relationships that filter both ways and many-to-many ones, from table to table. The
  conditions of several roles are joined with `OR`. They are not part of the query's filter
  context, so no modifier removes them. Calculated tables and columns, and the security
  filters themselves, are written without them (`unsecured`).
- **Field parameters** are calculated tables with `NAMEOF` cells, which are constants.
  `expandFieldParameter` reads the table's expression to list the fields a selection stands
  for.

### The blank row

`VALUES`, `ALL` and `ALLSELECTED` over a table that can have a blank row (the one side of a
relationship that does not rely on referential integrity, `blankRowRels`) are `withblank`: the
rows, in a `UNION` with a row of blanks (`blankRow`).

- The row is there when some row of a many side has a key the table lacks, or a many-side
  table has a blank row itself (`orphans`, recursively: a snowflake's dimensions).
- The filter context applies to it as to any row. Its calculated columns are blank, as are
  those read through a join that found no row.
- Under a bind, `VALUES` is `onerow`, whose condition gains "or the value is blank and the
  row is there" (`blankexists`).
- `DISTINCT`, `ALLNOBLANKROW`, the table's name and `COUNTROWS` of the table do not add it.

A blank in a table filter must match the blank row and the fact rows that have none, so
membership (`member`) is null-safe where both sides can be blank (`blankSide`, `mayBeBlank`):
a blank row, a column read through a join that may find no row, a constant blank. It stays a
plain `IN` elsewhere, a NULL stored in a column aside. When the table reads no outer row, the
null-safe form is `x IN (…) OR x IS NULL AND EXISTS (… IS NULL)`, as fast as `IN`; otherwise
it is `EXISTS` with `IS NOT DISTINCT FROM`.

### Relationships

`model.js` answers two questions under the relationship changes of the current context
(`USERELATIONSHIP`, `CROSSFILTER`):

- **`expand(T)`**: the tables reached from T through many-to-one relationships, each with its
  join path. This is DAX's expanded table.
- **`inbound(T)`**: the relationships through which a filter enters T from outside its
  expanded table. These are the one side of a bidirectional relationship and either side of a
  many-to-many relationship.

When a scan of T is written, a filter applies on the columns it shares with T's expanded
table, through joins. A filter arriving through an inbound relationship applies as a
semi-join, recursively, without returning to where it came from.

### The intermediate form

`ir.js` defines two kinds of node:

- **Scalars:** `lit`, `col`, `op`, `fn`, `case`, `agg`, `exists`, `insub`.
- **Tables:** `scan`, `filter`, `project`, `distinct`, `group`, `topn`, `cross`, the set
  operations, `rows`, `series`, `generate`, `sc` (SUMMARIZECOLUMNS), `shared` (a table VAR),
  `onerow`, `prefix`, `withblank` (a table and its blank row) and `window` (INDEX, OFFSET,
  WINDOW).
- **Scalars added for those:** `blankexists`, and `wrank` (RANK, ROWNUMBER).

A row is a `RowRef`; an expression names a row's column through it. `freeRows(x)` says which
rows from outside an expression or table it reads, which is the correlation of its SQL.

## SQL

`emit.js` builds each table as a `Block`: one SELECT under construction and a resolver for the
columns of its input row. A FILTER over a scan becomes a WHERE on it; anything that cannot
extend a block wraps it in a subquery.

**A scan** is the table joined to the related tables it needs, with the filter context as its
WHERE.

- A dimension key is read off the fact's foreign key when the relationship relies on
  referential integrity.
- A `rel` filter is `IN` for one column and `EXISTS` for more.

**An aggregate** is a scalar subquery over its table's block, correlated to the rows it reads.
DuckDB decorrelates these.

**Fusion.** In a SUMMARIZECOLUMNS level, or a ROW, an aggregate over a scan joins a fused
group when the scan reads no row except the group's keys. Each fused group is one CTE:

```sql
SELECT <keys>, <aggregates> FROM <table + joins> WHERE <other filters> GROUP BY <keys>
```

The CTE is `LEFT JOIN`ed to the groups. Aggregates are grouped together when they share the
same table, relationship state, keys, and other filters (the filters compared as SQL).

Inside a fused scan, a filter that reads a key the scan is itself filtered to reads the scan's
own column instead. Its correlation moves from the group to the row, which joins well.

**The groups of SUMMARIZECOLUMNS.** Every expression can be blank only when its fused groups
have no row (`support`). When that holds, the groups are the union of those groups' keys.
Otherwise they are the combinations of the keys' values (each table's existing combinations,
cross-joined, plus a dimension's blank row) and the expressions are evaluated on each.
`ROLLUPADDISSUBTOTAL` is a `UNION ALL` of the levels.

**One value as a table.** `VALUES(c)` under a bind on `c` is `onerow(v, exists)`, not a scan.

- `EXCEPT` and `INTERSECT` of it are conditions.
- `CROSSJOIN` with another table is a `prefix`.
- As a filter, it is a bind guarded by its condition.

This keeps measures like this model's "days the daily table lacks"
(`EXCEPT(VALUES(dim_calendar[date]), …)` under a group's date) in fused groups. As correlated
subqueries, they took 30 s on 1.6 million rows; as fused groups they take 0.2 s.

**Window functions.** The relation is numbered within its partitions (`numbered`): its
columns, the ORDERBY and PARTITIONBY values, and `ROW_NUMBER`, `COUNT`, `RANK` and
`DENSE_RANK` over them, ties broken by all the relation's columns. The current rows are those
whose columns equal the outer values (`currentRows`); a column with no outer value matches
any of its values in the filter context, through `EXISTS`. INDEX, OFFSET and WINDOW join the
numbered rows to the current rows on position (`windowRows`); RANK and ROWNUMBER read the
current row's number.

**START AT** is a `WHERE` on the ordered columns: the rows after the values, compared one
column after the other in each column's direction, or equal to them.

**FORMAT.** `format.js` reads a pattern into a description that does not depend on the
engine (sections, digit placeholders, literals; date tokens). `dialects/duckdb-format.js`
writes it:

- The value is bound once with a list comprehension (`[body FOR v IN [value]][1]`), so the
  body can use it many times without computing it again.
- A number is rounded the way Excel and VB do it: to 15 significant digits (`printf('%.14e')`),
  then half away from zero at the shown decimals, in `DECIMAL`. DuckDB's `round` on a `DOUBLE`
  gives 1.00 for 1.005.
- The integer digits are padded and grouped as text, and the fraction's optional digits are
  trimmed with a regular expression.

## Verification

- 81 tests: hand-worked expectations on a small model (78, of which 24 for calculated tables,
  calculation groups, field parameters, row-level security, ALLSELECTED, `START AT`, the
  window functions, the blank row, context transition and FORMAT), this model's measures
  checked against SQL written by hand, and every page query compared with `compiler.js`. The
  differences are listed with their DAX reason.
- An adversarial review by a second agent ran about 620 more queries. Its findings were fixed
  and added as tests.
- A second review of the six features, by two agents, ran about 500 queries. Its findings were
  fixed and added as tests too: among them RLS across bidirectional and many-to-many
  relationships, ALLSELECTED's per-column shadows, blank matching in table filters, and
  context transition on every column.

**Speed.** On made-up data of this model's shape (1.6 million 5-minute rows across 400 units,
plus a year of daily rows):

- The page's 104 queries take about 6.3 s here against about 2.7 s for `compiler.js`, on the
  same machine. No query takes over 0.85 s, and the slowest one takes 0.55 s in `compiler.js`.
- The difference is mostly the "days the daily table lacks" terms. This package evaluates
  them; `compiler.js` assumes they are empty. The blank row's checks add a little.
