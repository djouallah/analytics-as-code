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
- the measures being expanded.

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

CALCULATE (`compiler.js`, `calculateCtx`) works in four steps:

1. It evaluates the filter arguments in the outer context.
2. It turns the row contexts into binds.
3. It applies the relationship modifiers, then the removals.
4. It removes what the context said about the filters' columns (unless `KEEPFILTERS`) and
   adds the filters.

A filter on a date table's date column also clears the rest of that table.

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
  `onerow` and `prefix`.

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

## Verification

- 57 tests: hand-worked expectations on a small model, this model's measures checked against
  SQL written by hand, and every page query compared with `compiler.js`. The differences are
  listed with their DAX reason.
- An adversarial review by a second agent ran about 620 more queries. Its findings were fixed
  and added as tests.

**Speed.** On made-up data of this model's shape (1.6 million 5-minute rows across 400 units,
plus a year of daily rows):

- The page's 104 queries take 5.3 s here against 2.4 s for `compiler.js`. No query takes over
  0.7 s.
- The difference is mostly the "days the daily table lacks" terms. This package evaluates
  them; `compiler.js` assumes they are empty.
