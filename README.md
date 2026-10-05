# Analytics as Code

An example of AI-driven analytics: every line here — ingestion, models, tests, pipelines,
semantic model, dashboards — was written by AI. The data is the Australian electricity
market (AEMO).

![Architecture](architecture.svg)

One Power BI semantic model ([`semantic_model/`](semantic_model/)), three clients
([`dashboard/`](dashboard/)):

- **GitHub Pages** ([live](https://nemtracker.github.io/), public) and a **Microsoft Fabric
  app** (Fabric sign-in): the same page, and no server, the browser runs the queries itself
  (DuckDB-WASM).
- a **Power BI report**, on the same model in Direct Lake.

Details: [ARCHITECTURE.md](ARCHITECTURE.md)
