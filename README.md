# Analytics as Code

An example of AI-driven analytics: every line here — ingestion, models, tests, pipelines,
semantic model, dashboards — was written by AI. The data is the Australian electricity
market (AEMO).

![Architecture](architecture.svg)

- **dbt + DuckDB** on GitHub Actions load the data into **Iceberg** tables, every hour.
- **One Power BI semantic model** ([`semantic_model/`](semantic_model/)) describes those
  tables: their relationships and the measures, in DAX.
- **Four clients** read it ([`dashboard/`](dashboard/)):
  - **GitHub Pages** ([live](https://nemtracker.github.io/), public) and a **Microsoft
    Fabric app** (Fabric sign-in): the same page. No server: the browser runs the queries
    itself (DuckDB-WASM) on a cached copy of the tables.
  - a second **Fabric app**, the same page with no DuckDB and no copy of the data:
    **VertiPaq, Power BI's engine, is its server.** The page sends its DAX queries to the
    deployed model as they are written, VertiPaq runs them on the tables (Direct Lake), and
    the browser only draws the rows that come back. **Not tested yet:** it
    could not be deployed, because Fabric apps (preview) are not available yet in
    Australia Southeast, the region of the model's capacity. The code is in
    [`dashboard/fabric_app_vertipaq/`](dashboard/fabric_app_vertipaq/); it has never run
    in a browser.
  - a **Power BI report**, on the same model and the same server.
- **The same page without the semantic model**, in plain SQL
  ([live](https://nemtracker.github.io/sql/), [`dashboard/github/sql/`](dashboard/github/sql/)):
  how a team would build it in practice. Its figures are checked against the DAX page's.
- **[`compiler.js`](dashboard/github/dax/semantic/compiler.js)** is what lets the page read a
  Power BI model without Power BI: it turns the model's relationships into DuckDB views and
  the page's DAX queries into SQL. **It is not a general-purpose DAX compiler.** It was written for this
  repository only: it knows this model and the constructs this page uses, and fails on
  anything else. It is here to show where that layer sits.

Details: [ARCHITECTURE.md](ARCHITECTURE.md)
