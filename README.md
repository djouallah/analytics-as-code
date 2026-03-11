# Analytics as Code

> None of the individual pieces here are new — dbt, DuckDB, Iceberg, GitHub Actions have all existed for years. What makes this kind of project possible now is that AI has made the cost of writing and maintaining code dramatically cheaper. Ideally, code like this can be deployed to any data platform — the platform's job becomes hosting, security, and isolation, while the logic stays portable in Git.

The entire analytics stack — ingestion, transformation, storage, and visualization — defined and deployed from a single Git repository. No servers to manage, no orchestrator to maintain. The only persistent layer is an **Iceberg REST catalog**.

## Architecture

| Source Data | → | dbt-duckdb | → | Iceberg Catalog | → | Import | → | Dashboard |
|:-----------:|---|:----------:|---|:---------------:|---|:------:|---|:---------:|
| *external*  |   | *ephemeral, in-memory* | | *persistent, only state* | | *Iceberg → native DuckDB files* | | *DuckDB-WASM queries native files in browser* |

- **dbt-duckdb** — transformation engine that runs entirely in-memory. No database server, no cluster. A Python model handles data ingestion; SQL models handle transformation.
- **Iceberg REST catalog** — the single persistent layer. All warehouse state lives here as Iceberg tables.
- **GitHub Actions** — orchestrates everything. Scheduled workflows replace traditional schedulers (Airflow, Dagster, etc.).
- **DuckDB-WASM dashboard** — a static HTML page that loads compact DuckDB files in the browser and queries them client-side. No backend API.

## Design Principles

- **Everything is code.** Models, tests, macros, pipelines, dashboard — all versioned in Git.
- **No running infrastructure.** dbt runs ephemerally in CI. The catalog is the only thing that persists.
- **File-based incremental processing.** Fact models track which source files have been processed. No watermark tables, no external state database.
- **CI validates SQL on every code change.** `dbt build --target ci` runs all models + tests in-memory — catches broken SQL before it reaches production.
- **Intraday skips tests.** The 30-min processing cadence is too frequent for expensive test runs against live tables.
- **Daily backfill runs full data quality tests.** Once every 24 hours, `dbt test --target prod` runs the complete test suite against live Iceberg tables — uniqueness, not_null, accepted_values, referential integrity, and file completeness checks. Import to the dashboard only proceeds if all tests pass.

## Grain Reduction

Source data arrives at 5-minute resolution. The Iceberg tables store everything at this uniform grain — no data is lost. Aggregation only happens downstream for the dashboard. To give a sense of scale: ~1 billion raw records, ~300 million rows in the largest Iceberg table, ~13 million rows in the dashboard DuckDB files.

- **At import time:** When importing from Iceberg to the dashboard, the script aggregates 5-minute data to hourly for the daily file (SUM for volumes, AVG for prices), while the intraday file keeps native 5-minute grain. Types are compressed too — `REAL` instead of `DECIMAL`, `SMALLINT` for time keys — to minimize file size under the 100 MB GitHub Pages limit.
- **At query time:** The dashboard adapts granularity based on the selected date range: 5-minute resolution for <=7 days (from the intraday file), hourly for 8-30 days (from the daily file), and daily aggregates for >30 days. This keeps queries fast in single-threaded DuckDB-WASM.
- **Dashboard CSV download uses one consistent grain** — when users export data from the dashboard, it always uses a single time resolution, no mixing.

## How It Works

1. **Ingest** — A dbt Python model downloads source data and stores it as gzipped CSVs locally
2. **Transform** — dbt SQL models read from CSV archives, apply transformations, and write incrementally to Iceberg tables
3. **Import to dashboard** — A script reads from the Iceberg catalog and builds compact DuckDB files optimized for the browser
4. **Visualize** — The dashboard loads DuckDB-WASM, fetches the exported files, and joins/aggregates at query time in the browser

## Project Structure

```
├── models/
│   ├── staging/          # Python ingestion model
│   ├── dimensions/       # Dimension tables (calendar, reference data)
│   └── marts/            # Incremental fact tables
├── macros/               # Iceberg compatibility overrides, helpers
├── scripts/              # Iceberg → DuckDB import
├── dashboard/            # Static HTML dashboard (DuckDB-WASM)
├── tests/                # dbt data tests
├── .github/workflows/    # CI/CD pipelines
├── dbt_project.yml
└── profiles.yml          # ci (in-memory) / dev / prod (Iceberg)
```

## Limitations

- **GitHub Pages file size limit: 100 MB.** The DuckDB files served via GitHub Pages must stay under this limit, which constrains how much historical data the dashboard can hold.
- **DuckDB-WASM is single-threaded per origin.** Browsers enforce a single-origin policy, so WASM runs on a single thread. We use the native DuckDB file format (not Parquet) because DuckDB-WASM can query its own format efficiently even under this constraint — range requests, predicate pushdown, and columnar reads all work without needing to load the entire file into memory.

## Setup

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ICEBERG_REST_ENDPOINT` | REST catalog URL |
| `ICEBERG_TOKEN` | Bearer token for catalog auth |
| `ICEBERG_WAREHOUSE` | Warehouse path in the catalog |

### Local Development

```bash
pip install dbt-duckdb

# Validate SQL in-memory (no catalog needed)
dbt build --target ci --profiles-dir .

# Write to Iceberg catalog
export ICEBERG_REST_ENDPOINT=https://your-catalog/api/catalog
export ICEBERG_TOKEN=your-token
export ICEBERG_WAREHOUSE=your-warehouse
dbt build --target dev --profiles-dir .
```
