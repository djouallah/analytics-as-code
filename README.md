# Analytics as Code

An example of AI-driven analytics: every line here — ingestion, models, tests, pipelines,
semantic model, dashboards — was written by AI. The data is the Australian electricity
market (AEMO).

![Architecture](architecture.svg)

- **dbt + DuckDB** on GitHub Actions load the data into **Iceberg** tables, every 30 minutes.
- **One Power BI semantic model** ([`semantic_model/`](semantic_model/)) describes those
  tables: their relationships and the measures, in DAX.
- **Three clients** read it ([`dashboard/`](dashboard/)):
  - **GitHub Pages** ([live](https://nemtracker.github.io/), public) and a **Microsoft
    Fabric app** (Fabric sign-in): the same page. No server: the browser runs the queries
    itself (DuckDB-WASM) on a cached copy of the tables, and a small compiler turns the
    page's DAX into SQL.
  - a **Power BI report**, on the same model in Direct Lake.

Details: [ARCHITECTURE.md](ARCHITECTURE.md)
