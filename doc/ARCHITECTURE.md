# Analytics as Code — the details

> None of the individual pieces here are new — dbt, DuckDB, Iceberg, GitHub Actions have all existed for years. What makes this kind of project possible now is that AI has made the cost of writing and maintaining code dramatically cheaper. Ideally, code like this can be deployed to any data platform — the platform's job becomes hosting, security, and isolation, while the logic stays portable in Git.

The entire analytics stack — ingestion, transformation, storage, and visualization — defined and deployed from a single Git repository. No servers to manage, no orchestrator to maintain. The only persistent layer is an **Iceberg REST catalog** (OneLake, a Microsoft Fabric lakehouse), which also holds the raw CSV archive.

Much of the stack is pre-release: writes to OneLake's Iceberg catalog, DuckDB 2.0 (a
development build) and Fabric apps (a preview). A limit below that comes from one of them
describes the version in use, not the product.

## Architecture

| Source Data | → | dbt-duckdb | → | Iceberg Catalog | → | Semantic model | → | Clients |
|:-----------:|---|:----------:|---|:---------------:|---|:------:|---|:---------:|
| *external*  |   | *ephemeral, in-memory* | | *persistent, only state* | | *one Power BI `model.bim`: tables, relationships, measures* | | *one page on two hosts (DuckDB-WASM), and a Power BI report* |

- **dbt-duckdb** — transformation engine that runs entirely in-memory. No database server, no cluster. A Python model handles data ingestion; SQL models handle transformation.
- **Iceberg REST catalog** — the single persistent layer. All warehouse state lives here as Iceberg tables, and the gzipped source CSVs are archived next to them in object storage, so nothing depends on the ephemeral CI runner's disk.
- **GitHub Actions** — orchestrates everything. Scheduled workflows replace traditional schedulers (Airflow, Dagster, etc.). Auth is OIDC, no secrets.
- **One semantic model** — a Power BI model (`semantic_model/model.bim`) over the Iceberg tables: what a table is, how tables relate, and every measure, in DAX. Every client reads the data through it.
- **The clients** — a static HTML page that queries a cached copy of the tables in the browser (DuckDB-WASM, no backend API), deployed to GitHub Pages (public) and as a Microsoft Fabric app (sign-in, data in a lakehouse), and a Power BI report on the same model in Direct Lake. See [The clients](#the-clients).

## Design Principles

- **Everything is code.** Models, tests, macros, pipelines, dashboard — all versioned in Git.
- **No running infrastructure.** dbt runs ephemerally in CI. The catalog is the only thing that persists.
- **File-based incremental processing.** Each fact reads its work list from the ingestion log minus the files it has already loaded (`landing.processed_files`). No watermark tables, no external state database.
- **Durable archive, no reconciliation code.** The CSV archive and its log live in object storage, not on the runner, so an interrupted run leaves nothing to repair — the next pass simply sees what is already there.
- **A source that fails skips itself, not the run.** An unreachable feed downloads nothing this pass; a failed write to OneLake still fails the run.
- **Insert-only writes.** OneLake's catalog accepts one add-snapshot per commit and rejects a commit mixing delete files with data files, so every write is a merge that only inserts (`WHEN MATCHED DO NOTHING`): a stored value is never revised. A `DELETE` in a commit of its own works. A table is rebuilt by a scripted DROP and a CTAS that refills it over the next runs.
- **The mart decides its dates without scanning.** The date bounds come from the Iceberg manifests and are written into the SQL as literals, so every scan of a big table prunes data files.
- **Every reader runs in UTC.** `SETTLEMENTDATE` is AEST wall clock stored as a TIMESTAMPTZ labelled UTC; the `date` and `time` columns are right.
- **CI validates SQL on every code change.** `dbt build --target ci` runs all models + tests on plain DuckDB, with real downloads (two files per feed).
- **Loading skips tests.** The hourly processing cadence is too frequent for expensive test runs against live tables, so `process_data` only runs `dbt run`.
- **Tests run daily.** `dbt test --target prod` runs the complete suite against the live Iceberg tables — uniqueness, not_null, accepted_values, and file completeness checks.
- **Tables are maintained daily.** The same workflow compacts each table's small data files (DuckDB) and then expires snapshots older than a day (pyiceberg, as duckdb-iceberg has no `expire_snapshots`). Maintenance never fails its workflow.

## Grain Reduction

Source data arrives at 5-minute resolution (rooftop solar every half hour). The raw Iceberg tables (`landing`) store everything at the grain it arrives in — no data is lost. What the clients read is a second set of tables built from them (`mart`): one row per unit and 5 minutes with its price on it, and the aggregates, per day and per hour of day by month. To give a sense of scale: ~1 billion raw records, ~300 million rows in the largest raw table, ~13 million 5-minute rows in one half-year dashboard file.

- **In dbt:** every table a chart reads is a dbt model, the aggregates included, because Direct Lake has no views. Rooftop solar is stored half-hourly, as published (`fct_rooftop`); `fct_summary` holds it as five units, `ROOFTOP_<region>`, on the straight line between two half hours.
- **At import time:** `scripts/cache_catalog.py` copies those tables as they are into DuckDB files for the browser, with no rule of its own. It only decides the split: the 5-minute history as one file per half-year (each under GitHub's 100 MB per-file limit), the last 14 days as a small file refreshed every hour, the dimensions and aggregates in their own files.
- **In the model:** a quantity is one measure, and the measure picks the table: the 5-minute table when a time of day is asked for, the daily one otherwise. The daily tables store the sums the 5-minute measure sums, so both grains give the same number.
- **At query time:** the page reads 5-minute data up to 30 days (downloading only the half-years the range touches, and none for the default last 3 days), the daily and hour-of-day tables beyond. This keeps queries fast in single-threaded DuckDB-WASM.

## How It Works

1. **Ingest** — A dbt Python model downloads source data and archives it as gzipped CSVs in the lakehouse's `Files/`, alongside a durable log of what has been fetched
2. **Transform** — dbt SQL models read those archived CSVs and write incrementally to Iceberg tables as insert-only merges
3. **Model** — more dbt SQL models turn the raw tables into the ones a reader wants (`mart`), and one semantic model describes those: relationships and measures
4. **Cache** — A script copies the `mart` tables from the Iceberg catalog into DuckDB files, as they are
5. **Visualize** — The page loads DuckDB-WASM, fetches the files and asks its questions as queries of the model's fields, which a small compiler writes as DAX and turns into SQL; Power BI reads the same tables through the same model, with no copy (Direct Lake). The page draws what comes back and works out no figure of its own

## The clients

One semantic model (`semantic_model/model.bim`), its clients under `dashboard/`:

- `github/` and `fabric_app/wasm/` are one page (`dashboard/github/common/index.html`) on two hosts. A
  host only decides where the data files live and how the browser gets them
  (`storage/data.js`), so a chart is written once and reaches both.
- `powerbi_report/` is a Power BI report (`nem.Report`, as JSON) on the model as deployed to Fabric,
  which reads the Iceberg tables in Direct Lake. `deploy_model.yml` publishes the two together.
- `fabric_app/vertipaq/` is the page as a Fabric app with the deployed model as its engine,
  its queries run by Power BI. `deploy_fabric.yml` installs it with the rest of the project
  (lakehouse, `fabric_items/` notebook and pipeline, model, report) into one workspace. The
  two Fabric apps share `fabric_app/common/` (the build and the sign-in), as the GitHub
  page's two ways of asking share `github/common/`.

A measure is written once, in the model, and reaches every client.

| | GitHub Pages | Fabric app, DuckDB-WASM | Power BI report |
|---|---|---|---|
| Live at | [nemtracker.github.io](https://nemtracker.github.io/) | inside a Fabric workspace | the model's Fabric workspace |
| Who can open it | anyone | people the app is shared with, after Fabric sign-in | people with access to the report |
| Engine | DuckDB-WASM, in the browser | DuckDB-WASM, in the browser | VertiPaq, in Fabric |
| Data | `.duckdb` files next to the page | the same files in a lakehouse, under `Files/data` | the `mart` Iceberg tables, Direct Lake, no copy |
| 5-minute history | one file per half-year, downloaded | the same files, downloaded as parallel range requests | — |
| Host code | `dashboard/github/common/storage/data.js` | `dashboard/fabric_app/wasm/site/storage/` | — |
| Deployed by | `build.yml` (page), `import_data.yml` (data) | `rayfin up` from `dashboard/fabric_app/wasm/` (page), `import_onelake.yml` (data) | `deploy_model.yml` |

### The layers of the dashboard

The dashboard has the layers of a BI stack, each in its own file. The implementation is naive
on purpose: the point is the layers, not their maturity.

| Layer | Here | In a real product |
|---|---|---|
| Consumer | `dashboard/github/common/index.html` | the BI tool |
| Query language | a query of the model's fields (`frontend/queries.js`), which the compiler writes as DAX | DAX, MDX, VizQL, Malloy, a metrics request |
| Semantic model | `semantic_model/model.bim`, a Tabular model in TMSL | a Tabular model (TMSL, TMDL), LookML, MetricFlow YAML |
| Compiler | `packages/dax-sql` | MetricFlow, Cube's schema compiler, Malloy's compiler, Looker's SQL generator, Power BI's formula engine, Tableau's VizQL |
| Engine | DuckDB-WASM | the warehouse, VertiPaq, Hyper |
| Storage | `dashboard/github/common/storage/` | the lakehouse or warehouse connection |

- **The semantic model** describes the tables, their relationships and the measures, each
  with a description. It is a real Power BI model (`model.bim`), the same file that is
  deployed to Fabric: it holds DAX only, and nothing in it is written for the page.
- **The compiler** writes the page's queries as DAX, and turns the DAX into SQL over the
  views of the tables that storage has: `packages/dax-sql`, a general DAX compiler that
  knows nothing of this model or this page.
- **The query language** is where the layers show. SQL asks for tables, while a semantic
  model offers tables that know how they relate; the page asks for `Generation MW` by
  `dim_duid.FuelSourceDescriptor` and the compiler works out that the two have to be
  joined, and writes the SQL. The page knows no DAX: a query is an object of the model's
  fields (`select`, `where`, `having`, `totals`, `orderBy`, `top`), as a report visual asks.
  Which measure a chart draws at which grain is the page's to say; every figure is a
  measure, and the page only draws the rows. The Analyze tab is the exception: a SQL box,
  written by whoever uses it, over the same views; its CSV export is the rows of that SQL.
- **The same page without the semantic layer** is `dashboard/github/sql/`, at `sql/` on the
  site: the same `index.html` and storage, and its own `frontend/queries.js`, which asks in
  SQL, each figure written out where a chart uses it, the joins written out. It is how a
  team would build the page in practice.

### How the page is checked

- `scripts/parity/page_lint.mjs` (every push): no arithmetic on numbers in the page's script
  or in either `queries.js`, so every figure is a measure.
- `scripts/parity/page_queries.mjs` and `scripts/parity_model.py`: every query of the page,
  over a set of page states, compiled to SQL and run on the deployed files, and its DAX run
  by the deployed model; the rows compared. `deploy_model.yml` runs it when dispatched with
  `parity=true` (model queries cost capacity), for the queries that changed since the last
  green run.
- `scripts/parity/sql_page.mjs`: the SQL page's rows against the DAX page's, in the same
  states.
- `scripts/check_model.py` (every model deploy): a refresh, row counts, each measure per day
  for the newest week, and that the report reads the model.

### How a Power BI report asks

A Power BI report holds no DAX. Each visual is a description: which columns and measures,
grouped how, filtered by what (the `visual.json` files of `nem.Report`).

- The browser sends that description, a *semantic query*, to the Power BI service.
- The service turns it into DAX, using the model, and the engine (VertiPaq) runs it.
- The service shapes the rows for the visual (groups, totals, how many points) and sends
  them back.
- A click on one visual adds a filter to the semantic queries of the others: that is
  cross-filtering, and it runs on the same path.

The page does the same in its own words: each chart sends a description of the model's
fields (`frontend/queries.js`), the compiler writes the DAX, and a click changes the filters
of those queries.

### The Fabric app

Built with [Rayfin](https://www.npmjs.com/package/@microsoft/rayfin-cli). Fabric hosts the
page and signs you in, and the page reads its data directly from OneLake: no backend to run,
no query service.

![The dashboard as a Fabric app](../dashboard/fabric_app/wasm/screenshots.png)

![Architecture of the Fabric app](../dashboard/fabric_app/wasm/architecture.svg)

- **Hosting:** `rayfin up` deploys the page to Fabric static hosting.
- **Sign-in:** Fabric single sign-on. Inside the Fabric portal there is no extra login; in
  its own tab it is one click.
- **Data:** the browser reads the files from OneLake itself, with read-only access to that
  one folder for about an hour at a time. A small server function signs that access; the
  storage token never reaches the browser.
- **Refresh:** `import_onelake.yml` rebuilds the files from the Iceberg catalog daily and
  uploads them to the lakehouse.

## Project Structure

```
├── models/
│   ├── staging/          # Python ingestion model
│   ├── dimensions/       # Dimension tables (calendar, units, regions, links, time, months)
│   └── marts/            # Incremental fact tables (landing) and the tables the model reads (mart)
├── macros/               # Iceberg adapter overrides, the pending-files and date-bounds helpers
├── scripts/              # The cache (Iceberg → DuckDB files), table maintenance, deploys, parity/
├── semantic_model/       # The one semantic model (model.bim): what every client reads, and a Fabric item
├── dashboard/            # Its clients
│   ├── github/           # The page on GitHub Pages, and its two ways of asking
│   │   ├── common/       # index.html, frontend/ (draws, Logs tab), storage/ (the host, the tables as views), dag/ (dbt docs)
│   │   ├── dax/          # through the semantic model: frontend/queries.js, semantic/ (the compiler); served at /
│   │   └── sql/          # in plain SQL, no semantic layer: frontend/queries.js; served at sql/
│   ├── fabric_app/       # The same page as a Fabric app, and its two backends
│   │   ├── common/       # build.mjs and the Fabric sign-in (site/storage/auth.js)
│   │   ├── wasm/         # DuckDB-WASM over a copy of the tables: its host code and the Rayfin project (deployed)
│   │   └── vertipaq/     # the deployed model as the engine: its host code and the Rayfin project (deploy_fabric.yml)
│   └── powerbi_report/   # A report over the deployed model
├── fabric_items/         # The lakehouse, notebook and pipeline deploy_fabric.yml installs into a workspace
├── doc/                  # This file and the architecture diagram
├── tests/                # dbt data tests
├── .github/workflows/    # CI/CD pipelines
├── dbt_project.yml
└── profiles.yml          # ci (in-memory) / dev / prod (Iceberg)
```

## Limits

- **GitHub Pages: 100 MB per file, about 1 GB per site.** The first is why the history is
  split into half-year files; the second binds now: the data files are about 880 MB and grow
  about 125 MB a year. Where the 5-minute history lives next is a decision: another host, or
  recent years only.
- **The deployed files are state too.** A daily import rebuilds the aggregates and only the
  latest two half-years; older half-year files are kept as deployed. A change to older data
  needs an import of every period (`all_periods=true`). The deploy repo's history is squashed
  weekly, as the hourly file grows it by gigabytes.
- **DuckDB-WASM runs single-threaded.** Its multi-threaded build can't load ICU or share OPFS
  file handles with its threads, and gains about 1.4x on 4 threads. The files are downloaded
  whole into OPFS and attached in place: DuckDB-WASM reads a remote file one block at a time,
  three round trips each, which is far slower than one download.
- **Limited by the browser.** A tab gets about 4 GB of memory; a query that needs more fails.
  Phones and old laptops will struggle.
- **The compiler is slower than hand-written SQL.** It computes what DAX says without
  knowing the data (the hours of each plant's regions, not of all of them), and writes
  larger queries than a person would: about 1.6 times the hand-written compiler's time
  over the page's queries, one thread.
- **A stored value is never revised.** Until merges may update, a correction from AEMO does
  not land, `dim_duid` changes only through a rebuild, and `fct_summary` keeps the intraday
  value of an interval where the next-day files have another.
- **Maintenance failures show only in the job's log.** There is no alert.
- **No CI sees a chart of the Power BI report draw**; a visual is checked by opening it.

The Fabric app has limits of its own:

- **Security is per table, not per row.** Only people the app is shared with in Fabric can
  sign in and read the data. For them there is no row-level or column-level security.
- **No public access.** Every visitor signs in with a Fabric account the app is shared with.
- **Only the item's owner can deploy to it.** An app deployed from a laptop cannot then be
  deployed from CI, or the reverse: each identity deploys the item it created. The
  DuckDB-WASM app is deployed from the owner's laptop: its function fails on an item owned
  by a service principal (microsoft/rayfin#89).

## Open items

**Waiting on upstream**
- OneLake accepting commits that mix delete files with data files: then the merges can
  update.
- DuckDB 2.0.0 stable: replace the `2.0.0.dev` pin everywhere.
- A DuckDB-WASM build on DuckDB 2.0: move the dashboard and the import's write venv (1.5)
  together, for one DuckDB version end to end.
- DuckDB-WASM with Iceberg on Azure (below).
- duckdb-iceberg#1341 (`expire_snapshots`): replace pyiceberg.
- microsoft/rayfin#89: deploy the DuckDB-WASM Fabric app from CI.
- AEMO publishing `ROOFTOP_PV_ACTUAL_PRED`/`_RUN`: move `fct_rooftop_pv` to the 5-minute
  estimate when `ROOFTOP_PV_ACTUAL` stops.

**Possible improvements**
- Dynamic filter pushdown into Iceberg manifests would make the literal-dates macros
  unnecessary.
- Correct instants at the writer would remove the "every reader in UTC" rule; it means
  rebuilding the seven facts.

### What SQL would need

No open-source language and runtime has DAX's semantics, so SQL with WHERE parameters is
always the shortest path for an AI writing a client: each chart is correct on its own, and
what is lost is one definition across clients. Five additions would make the right path the
easy one, each replacing work the compiler does:

1. **Measures in the catalog:** `CREATE MEASURE fct_summary.capacity_factor AS ...`,
   called by name, evaluated in the query's context. *Replaces:* inlining.
2. **Relationships that carry filters:** a filter on a dimension reaches every related
   fact; a filter on one fact's column stays there. *Replaces:* the per-fact CTEs.
3. **Context modifiers:** Calcite's `AT` ("Measures in SQL", Hyde, 2024),
   `revenue AT (SET date = date - 1)`, `AT (ALL region)`. *Replaces:* `KEEPFILTERS`,
   `ALLSELECTED`, `DATESBETWEEN`.
4. **Grain inside the measure**, and aggregate tables the engine routes to on its own.
   *Replaces:* the per-unit two-level query, `[Reads 5 minutes]`, `wholeDays`.
5. **A query surface for visuals:** group, filter, name measures, nothing else, with
   filters as structured values. *Replaces:* the page's query objects.

```sql
SELECT region, date, capacity_factor, renewable_share,
       revenue AT (SET date = date - 1) AS revenue_prev
FROM SEMANTIC nem
WHERE date BETWEEN ? AND ?          -- reaches every fact through relationships
GROUP BY region, date;
```

Calcite's proposal covers 1, 3 and part of 4; Malloy, dbt MetricFlow and Cube cover parts
of 1 and 2. None ships all five in an embeddable engine. DuckDB, which already runs in the
browser, is the natural place.

### Reading the catalog from the browser

- **Authentication works.** A page signs the user in with MSAL.js (PKCE, an SPA app
  registration, no client secret) and asks for `https://storage.azure.com/user_impersonation`.
  That one token is what the OneLake Iceberg endpoint and the storage both accept: the
  reader's own, for about an hour, reaching only what they can read.
- **CORS passes** for the catalog (`onelake.table.fabric.microsoft.com/iceberg`), a file
  read with a Range header (`onelake.dfs...`) and the user-delegation-key call
  (`onelake.blob...`), with `Authorization: Bearer`.
- **What's missing is the engine.** DuckDB-WASM's extensions include neither `iceberg` nor
  `azure`. OneLake's metadata points at `abfss://` paths, so it needs the azure extension in
  WASM, or the iceberg extension reading `https://` with a Bearer header or a SAS.
- **When it lands:** the Fabric app's SAS function and its owner-only deploy go away, and
  recent data can come live from the catalog. The public page, which has no reader identity,
  is not covered.

## Setup

### Environment Variables

The catalog is the **OneLake Iceberg REST catalog** (a Microsoft Fabric lakehouse). In CI the
values come from GitHub repository **variables** (`WS_ID`, `LH_ID`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID` — public identifiers, no secrets) plus a per-run token minted after an OIDC
federated `azure/login`. The Fabric app's deploys and data add `LAKE_TENANT_ID`,
`LAKE_CLIENT_ID`, `FABRIC_APP_WORKSPACE_ID` and `ONELAKE_FILES_URL`.

| Variable | Description |
|----------|-------------|
| `ONELAKE_ENDPOINT` | `https://onelake.table.fabric.microsoft.com/iceberg` |
| `WAREHOUSE_PATH` | `{workspace_id}/{lakehouse_id}` |
| `ONELAKE_TOKEN` | Short-lived Azure storage token (minted per run, never stored) |
| `FILES_PATH` | `abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Files` — where the CSV archive and its log live. Required off the `ci` target |
| `download_limit` | Files fetched per feed per run (default 2; the workflow uses 200) |
| `process_limit` | Files loaded per fact model per run (default 1000; the workflow uses 300) |
| `AZURE_TRANSPORT_OPTION_TYPE`, `CURL_CA_INFO` | `curl` and the CA bundle, on GitHub runners only |
| `ALL_PERIODS` | `true` copies every half-year file into the dashboard's files, not only the latest two (Import Data on dispatch, Import OneLake always) |
| `GITHUB_TOKEN` | Authenticated GitHub API calls for the backfill listings and the DUID registration list; the workflows pass it, since anonymous calls from shared runners get rate-limited |
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

### The Fabric App

You need a Fabric workspace with a lakehouse:

- Workspace settings → OneLake → turn on **Authenticate with OneLake user-delegated SAS tokens**
  (off by default; the tenant setting *Use short-lived user-delegated SAS tokens* is on by default).
- The owner of the Fabric app item must be able to read the lakehouse.

Everything else is Rayfin — see the
[Rayfin documentation](https://learn.microsoft.com/fabric/embedded/rayfin/overview):

```bash
cd dashboard/fabric_app/wasm
npm ci && npm ci --prefix rayfin/functions
npx rayfin login      # sign in to Fabric
npx rayfin up         # build + deploy to Fabric static hosting; prints the hosting URL

# once, after the first deploy: where the app's function signs read access
echo https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files \
  | npx rayfin secret set ONELAKE_FILES_URL --stdin
```

Then run the **Import OneLake** workflow to fill the lakehouse (`LAKE_TENANT_ID`,
`LAKE_CLIENT_ID`: an Entra app with a federated credential for this repo and write access to
the workspace), and open the app in the Fabric portal or in its own tab.
