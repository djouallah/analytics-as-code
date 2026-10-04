# Analytics as Code

> None of the individual pieces here are new — dbt, DuckDB, Iceberg, GitHub Actions have all existed for years. What makes this kind of project possible now is that AI has made the cost of writing and maintaining code dramatically cheaper. Ideally, code like this can be deployed to any data platform — the platform's job becomes hosting, security, and isolation, while the logic stays portable in Git.

The entire analytics stack — ingestion, transformation, storage, and visualization — defined and deployed from a single Git repository. No servers to manage, no orchestrator to maintain. The only persistent layer is an **Iceberg REST catalog** (currently OneLake, a Microsoft Fabric lakehouse), which also holds the raw CSV archive.

## Architecture

| Source Data | → | dbt-duckdb | → | Iceberg Catalog | → | Import | → | Dashboard |
|:-----------:|---|:----------:|---|:---------------:|---|:------:|---|:---------:|
| *external*  |   | *ephemeral, in-memory* | | *persistent, only state* | | *Iceberg → native DuckDB files* | | *DuckDB-WASM queries native files in browser* |

- **dbt-duckdb** — transformation engine that runs entirely in-memory. No database server, no cluster. A Python model handles data ingestion; SQL models handle transformation.
- **Iceberg REST catalog** — the single persistent layer. All warehouse state lives here as Iceberg tables, and the gzipped source CSVs are archived next to them in object storage, so nothing depends on the ephemeral CI runner's disk.
- **GitHub Actions** — orchestrates everything. Scheduled workflows replace traditional schedulers (Airflow, Dagster, etc.).
- **DuckDB-WASM dashboard** — a static HTML page that loads compact DuckDB files in the browser and queries them client-side. No backend API.

## Design Principles

- **Everything is code.** Models, tests, macros, pipelines, dashboard — all versioned in Git.
- **No running infrastructure.** dbt runs ephemerally in CI. The catalog is the only thing that persists.
- **File-based incremental processing.** Fact models track which source files have been processed, reading the work list from the ingestion log table. No watermark tables, no external state database.
- **Durable archive, no reconciliation code.** The CSV archive and its log live in object storage, not on the runner, so an interrupted run leaves nothing to repair — the next pass simply sees what is already there.
- **CI validates SQL on every code change.** `dbt build --target ci` runs all models + tests in-memory — catches broken SQL before it reaches production.
- **Loading skips tests.** The 30-min processing cadence is too frequent for expensive test runs against live tables, so `process_data` only runs `dbt run`.
- **Tests run daily.** Once every 24 hours, `dbt test --target prod` runs the complete suite against live Iceberg tables — uniqueness, not_null, accepted_values, and file completeness checks.
- **Tables are maintained daily.** The same workflow compacts each table's small data files and then expires snapshots older than a day, so a 30-minute commit cadence doesn't leave the tables fragmented and their metadata unbounded.

## Grain Reduction

Source data arrives at 5-minute resolution (rooftop solar every half hour). The Iceberg tables store everything at the grain it arrives in — no data is lost. Aggregation only happens downstream for the dashboard. To give a sense of scale: ~1 billion raw records, ~300 million rows in the largest Iceberg table, ~13 million 5-minute rows in one half-year dashboard file.

- **At import time:** The script writes the 5-minute history as one DuckDB file per half-year (each under GitHub's 100 MB per-file limit), the last 14 days as a small file refreshed every 30 minutes, and one aggregate file: per unit and day, plus hour-of-day × month (SUM for energy, AVG for prices). Rows at 0 MW are left out, and types are compressed — `REAL` instead of `DOUBLE`, `SMALLINT` for time keys.
- **At query time:** The dashboard adapts granularity to the selected date range: 5-minute resolution up to 30 days (downloading only the half-years the range touches, and none for the default last 3 days), daily and hour-of-day aggregates beyond. This keeps queries fast in single-threaded DuckDB-WASM.
- **Dashboard CSV download uses one consistent grain** — when users export data from the dashboard, it always uses a single time resolution, no mixing.

## How It Works

1. **Ingest** — A dbt Python model downloads source data and archives it as gzipped CSVs in the lakehouse's `Files/`, alongside a durable log of what has been fetched
2. **Transform** — dbt SQL models read those archived CSVs, apply transformations, and write incrementally to Iceberg tables as insert-only merges (one append snapshot per commit)
3. **Import to dashboard** — A script reads from the Iceberg catalog and builds compact DuckDB files optimized for the browser
4. **Visualize** — The dashboard loads DuckDB-WASM, fetches the exported files, and joins/aggregates at query time in the browser

## Project Structure

```
├── models/
│   ├── staging/          # Python ingestion model
│   ├── dimensions/       # Dimension tables (calendar, reference data)
│   └── marts/            # Incremental fact tables
├── macros/               # Iceberg compatibility overrides, helpers
├── scripts/              # Iceberg → DuckDB import, table maintenance, deploy
├── dashboard/            # Static HTML dashboard (DuckDB-WASM)
├── tests/                # dbt data tests
├── .github/workflows/    # CI/CD pipelines
├── dbt_project.yml
└── profiles.yml          # ci (in-memory) / dev / prod (Iceberg)
```

## Limitations

- **GitHub Pages limits: 100 MB per file, about 1 GB per site.** The first is why the history is split into half-year files; the second is the one that binds now (the data files are close to it) and constrains how much more history the dashboard can hold.
- **The deployed files are state too.** A daily import rebuilds only the latest two half-years; older half-year files, and the aggregate's rows before the cutoff, are kept as deployed. A change to older data needs an import of every period (`all_periods=true`).
- **DuckDB-WASM runs single-threaded.** Its multi-threaded build can't load extensions such as ICU yet and can't share OPFS file handles with its threads, and it only gained ~1.4x on 4 threads when tried (2026-09-30). We use the native DuckDB file format (not Parquet) because DuckDB-WASM can query its own format efficiently even under this constraint — range requests, predicate pushdown, and columnar reads all work without needing to load the entire file into memory.

## Setup

### Environment Variables

The catalog is the **OneLake Iceberg REST catalog** (a Microsoft Fabric lakehouse). In CI the
values come from GitHub repository **variables** (`WS_ID`, `LH_ID`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID` — public identifiers, no secrets) plus a per-run token minted after an OIDC
federated `azure/login`:

| Variable | Description |
|----------|-------------|
| `ONELAKE_ENDPOINT` | `https://onelake.table.fabric.microsoft.com/iceberg` |
| `WAREHOUSE_PATH` | `{workspace_id}/{lakehouse_id}` |
| `ONELAKE_TOKEN` | Short-lived Azure storage token (minted per run, never stored) |
| `FILES_PATH` | `abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Files` — where the CSV archive and its log live. Required off the `ci` target |
| `download_limit` | Files fetched per feed per run (default 2; the workflow uses 200) |
| `process_limit` | Files loaded per fact model per run (default 1000; the workflow uses 300) |
| `AZURE_TRANSPORT_OPTION_TYPE`, `CURL_CA_INFO` | `curl` and the CA bundle, on GitHub runners only |
| `GITHUB_TOKEN` | Optional: authenticated GitHub API calls for the backfill listings |
| `NEMTRACKER_TOKEN` | The one secret: pushes the dashboard to its GitHub Pages repo |

### Local Development

```bash
pip install -r requirements.txt

# Validate the models on plain DuckDB (no catalog needed). It runs the download
# for real: two files per feed, archived under /tmp.
dbt build --target ci --profiles-dir .
```

The `dev` target is not a sandbox: it attaches the same catalog as `prod` and writes the
same `landing` and `mart` tables. To use it against a lakehouse of your own (`az login` with
an identity that can access the Fabric workspace):

```bash
az login
export ONELAKE_ENDPOINT=https://onelake.table.fabric.microsoft.com/iceberg
export WAREHOUSE_PATH=<workspace-guid>/<lakehouse-guid>
export FILES_PATH=abfss://<workspace-guid>@onelake.dfs.fabric.microsoft.com/<lakehouse-guid>/Files
export ONELAKE_TOKEN=$(az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv)
dbt build --target dev --profiles-dir .
```
