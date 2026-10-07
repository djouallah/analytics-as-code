# github-sql: the page without the semantic layer

Not built yet. This folder is to hold the same page as [`../github-dax/`](../github-dax/),
asking DuckDB in plain SQL instead of asking a semantic model that a compiler turns into DAX
and then into SQL. It is how a team would build this page in practice: the logic in dbt and in
SQL, and Power BI on its own model, with a few headline figures compared between the two.

Open items only: a finished item is removed, not ticked.

## What carries over unchanged

- The data: the same `.duckdb` files the site already serves (`data/`), no new import.
- `index.html`, `frontend/draw.js`, `frontend/logs.js`, `frontend/perflog.js`,
  `storage/data.js`, `storage/history.js`: copied from `../github-dax/`.
- The grain rule: up to 30 days the 5-minute tables, beyond the daily and hourly ones
  (`grain()` in `queries.js`).

## To do

- [ ] **The tables as views.** A table is split over files (`today`, the half-years, `agg`),
  and the compiler's `build()` (`../github-dax/semantic/compiler.js`) puts them back together
  as views after every attach. That part is not DAX and stays, as a small `storage/views.js`:
  one view per table, by name (`fct_summary`, `dim_duid`, ...), and nothing from `model.bim`.
- [ ] **`frontend/queries.js` in SQL.** Each of the 74 members becomes a SQL string over those
  views, built from the page's state. A measure is written in SQL where a chart uses it
  (capture price is `SUM(mw * price) / SUM(mw)`); a figure that grows complicated becomes a
  column or a table in dbt, not page code. The joins are written out.
- [ ] **The page talks to `data.query(sql)`**: no `createModel`, no `semantic/`, no `model.bim`
  in the deploy. The Logs tab shows the SQL alone. Analyze is unchanged.
- [ ] **Headline check against Power BI.** In `deploy_model.yml`, a dozen figures compared to a
  cent between this page's SQL and the deployed model, for the newest settled days: generation
  by fuel per day, average price by region, renewable share, emissions intensity, curtailment.
  It replaces the 487-query parity for this page; a drift is read by a person.
- [ ] **Old against new in headless Chrome**: every chart's series and text the same as
  `../github-dax/` over one copy of the deployed files, and the timings.

## What it drops

`compiler.js`, the query words (`select`, `where`, `totals`, ...), the page's copy of
`model.bim`, and for this page the full parity harness and the no-arithmetic lint
(`scripts/parity/page_lint.mjs` reads `index.html` and `queries.js` of `../github-dax/` only).
