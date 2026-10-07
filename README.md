# Analytics as Code

An example of AI-driven analytics: every line here — ingestion, models, tests, pipelines,
semantic model, dashboards — was written by AI. The data is the Australian electricity
market (AEMO).

![Architecture](architecture.svg)

- **dbt + DuckDB** on GitHub Actions load the data into **Iceberg** tables, every hour.
- **One Power BI semantic model** ([`semantic_model/`](semantic_model/)) describes those
  tables: their relationships and the measures, in DAX.
- **Four clients** read it ([`dashboard/`](dashboard/)):
  - **GitHub Pages** ([live](https://nemtracker.github.io/), public,
    [`dashboard/github/`](dashboard/github/)) and a **Microsoft Fabric app** (Fabric
    sign-in, [`dashboard/fabric_app_wasm/`](dashboard/fabric_app_wasm/)): the same page. No
    server: the browser runs the queries itself (DuckDB-WASM) on a cached copy of the tables.
  - a second **Fabric app**, the same page with no DuckDB and no copy of the data:
    **VertiPaq, Power BI's engine, is its server.** The page sends its DAX queries to the
    deployed model as they are written, VertiPaq runs them on the tables (Direct Lake), and
    the browser only draws the rows that come back. **Not tested yet:** it
    could not be deployed, because Fabric apps (preview) are not available yet in
    Australia Southeast, the region of the model's capacity. The code is in
    [`dashboard/fabric_app_vertipaq/`](dashboard/fabric_app_vertipaq/); it has never run
    in a browser.
  - a **Power BI report** ([`dashboard/powerbi_report/`](dashboard/powerbi_report/)), on
    the same model and the same server.
- **One page, two ways of asking** ([`dashboard/github/`](dashboard/github/)): `common/` is
  the page (the charts, the data files, the Logs tab), and only what it asks with differs.
  - [`dax/`](dashboard/github/dax/) asks the semantic model: a chart names the model's
    columns and measures, and [`compiler.js`](dashboard/github/dax/semantic/compiler.js)
    turns that into DAX, and the DAX into SQL. Served at
    [nemtracker.github.io](https://nemtracker.github.io/).
  - [`sql/`](dashboard/github/sql/) asks DuckDB in plain SQL, with no semantic model: each
    figure is written out where a chart uses it, as a team would build the page in
    practice. Served at [nemtracker.github.io/sql](https://nemtracker.github.io/sql/). Its
    rows are checked against the DAX page's, question by question.
- **The compiler** is what lets the page read a Power BI model without Power BI: it turns
  the model's relationships into DuckDB views and the page's DAX queries into SQL. **It is
  not a general-purpose DAX compiler.** It was written for this
  repository only: it knows this model and the constructs this page uses, and fails on
  anything else. It is here to show where that layer sits.

Details: [ARCHITECTURE.md](ARCHITECTURE.md)
