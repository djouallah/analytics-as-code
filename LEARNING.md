# Learning

Where the project stands on 2026-10-07: what works, what limits it, and where each stage
could be better. [AGENTS.md](AGENTS.md) is the reference for how things are built.

Much of the stack is pre-release: writes to OneLake's Iceberg catalog are not released yet,
DuckDB is a 2.0 development build, and Fabric apps are a preview. A limit below that comes
from one of them describes the version in use today, not the product; several are already
fixed upstream.

## Summary

1. **A durable archive plus an append-only log needs no reconciliation code.** An
   interrupted run is picked up by the next one.
2. **The write path follows the catalog's current version.** A commit can't yet mix delete
   files with data files (fixed upstream, rolling out), so every write is an insert-only
   merge.
3. **Every timestamp is wall-clock time stored as UTC**, so every reader must run in UTC.
4. **The mart decides its dates from Iceberg manifests and writes them as literals**, so
   every scan prunes. The mart step takes 3.5 minutes.
5. **Every table a reader needs is a dbt model**, because Direct Lake has no views. The
   import to the browser is a plain copy.
6. **One semantic model serves four clients.** A measure is defined once, in DAX.
7. **Two serving paths: client side and VertiPaq.** Client side, DuckDB-WASM reads a copy
   of the tables and a small compiler turns the page's DAX into SQL by fixed cases.
   VertiPaq runs the same DAX as written, in Direct Lake over the Iceberg tables.
8. **There is no open-source language and runtime with DAX's semantics.** That is the main
   risk for an AI-written client: SQL with WHERE clauses is always the shortest path.
9. **A browser can authenticate to OneLake's catalog and storage directly** (CORS passes
   with a Bearer token). What's missing is DuckDB-WASM support for Iceberg on Azure.

## 1. Ingestion

### Now
- A dbt Python model downloads AEMO's files and archives them, gzipped, to OneLake
  `Files/`, with a durable log (`Files/csv_archive_log.parquet`). The parquet file is the
  source of truth; the Iceberg log table is rebuilt from it and appended with missing rows
  only.
- Each fact's pre-hook takes its work from the log minus `landing.processed_files`,
  newest first, `NOT EXISTS` and `DISTINCT` (MERGE doesn't dedupe within a batch). A fact
  with nothing to do takes 5 s.
- Every hourly pass does every feed; backfills run only when AEMO returned fewer new files
  than the limit.
- A source that fails skips itself, not the run. A failed write to OneLake raises.

### Limits and next
- **Downloading lives inside dbt.** The sibling repo downloads outside dbt and reads the log
  from parquet, which is simpler.
- **The file list goes through a DuckDB `VARIABLE`**, because `read_csv` takes no subquery
  and DuckDB has no manifest scan (duckdb/duckdb-aws-glue#37).
- **The empty MERGE:** a fact with no new file still runs a MERGE (5-7 s each, seven facts).
  Skipping it needs a custom incremental strategy.
- **Intraday tables are not trimmed.** Their scans are bounded; a scheduled DELETE of rows
  older than the newest daily date, with a re-count, would keep them small.
- **The refill path is not exercised by CI.** The next `rebuild=` of a mart fact is its
  first run on the catalog.

## 2. Storage: Iceberg on the OneLake REST catalog (pre-release)

### Now
- The catalog and the archive next to it are the only state. Runner, dbt and DuckDB are
  ephemeral.
- Direct Lake reads the same Iceberg tables, with no copy.
- Auth is OIDC from GitHub Actions, no secrets.
- A capability probe (CREATE/INSERT/DELETE/UPDATE/MERGE/DROP, separate repo) is the
  evidence for what the catalog accepts.
- Writes: one add-snapshot per commit; a DELETE alone is accepted; a commit mixing delete
  files with data files is not, in the current version. So every write is an insert-only
  merge (`WHEN MATCHED DO NOTHING`):
  - a stored value is never revised;
  - `dim_duid` attributes change through a `rebuild=dim_duid`;
  - a rebuild is a scripted DROP plus CTAS, refilling at `process_limit` files per run;
  - `--full-refresh` is not used (RENAME is unprobed).
- `SETTLEMENTDATE` is AEST wall clock stored as TIMESTAMPTZ labelled UTC (10 hours early);
  `date` and `time` are right. Every reader runs in UTC.
- Two DuckDB lines: the 2.0 dev build writes the catalog (compaction needs
  `iceberg_rewrite_data_files()`), 1.5 writes the browser's files (DuckDB-WASM is on 1.5).
  Parquet is the handoff.
- Maintenance: DuckDB compaction, then pyiceberg snapshot expiry (duckdb-iceberg has no
  `expire_snapshots` yet). It never fails its workflow.

### Limits and next
- **Merges that update**, once the upstream fix rolls out: corrections land, `dim_duid`
  updates in place, `fct_summary` can take the next-day value over the intraday one.
- **Correct instants at the writer** would remove the "every reader in UTC" rule; it means
  rebuilding the seven facts.
- **One DuckDB version end to end** once 2.0 is stable and DuckDB-WASM follows.
- **An alert when compaction or expiry stops working**; today it shows only in a log.

## 3. The mart

### Now
- Every table a reader needs is a dbt model in `mart`: the raw facts can't be read by
  Direct Lake as they are, and Direct Lake has no views. The rules (`INTERVENTION = 0`,
  0 MW out, one row per key, `MWFLOW`, energy as `SUM(mw) / 12`) live in the models.
- MW and price on one row at 5 minutes (`fct_summary`): joining two facts at query time is
  too slow.
- Aggregates per day and per month-and-hour, written once a day or month is whole.
- Dates come from the Iceberg manifests (`macros/date_bounds.sql`) and are written as
  literals, which duckdb-iceberg prunes on; a subquery doesn't prune. `fct_summary` takes
  47 s, the mart step 3.5 minutes.
- `fct_summary` is written by date, time, price, DUID: the price is the region's, so in that
  order it compresses to nothing. Key order made the files 60% larger.

### Limits and next
- **Dynamic filter pushdown into Iceberg manifests** would make the literal-dates macros
  unnecessary.
- **`fct_region` is recomputed whole every run** (4.5M rows). Cheap now, grows with history.
- **First value wins:** the intraday feed lands first and the next-day files add only
  missing keys, so `fct_summary` mixes two AEMO columns from two reports.

## 4. The semantic model

### Now
- `semantic_model/model.bim` (TMSL) is deployed to Fabric in Direct Lake over `mart`, and
  is the file the page reads. A measure is defined once.
- A quantity is one measure, and the measure picks the table:
  `IF([Reads 5 minutes], 5-minute table, daily table)`. Direct Lake has no user-defined
  aggregations, and the same switch lets the browser ask a measure over ten years.
- The daily tables store the sums the 5-minute measure sums (`output_mwh`, `charging_mwh`,
  `revenue`), so both grains give the same number.
- An average MW is energy over `[Hours]`, nights included.
- The deployed model answers DAX from the development machine; a new measure can be tried
  as `DEFINE MEASURE ... EVALUATE` before it goes into `model.bim`.
- CI checks every deploy (`check_model.py`) over XMLA: the REST query API refuses a service
  principal on this model (401).
- Parity with the old dashboard at every grain: 25,737 values equal, none different
  (2026-10-05).

### Limits and next
- **Try measures against the deployed model before deploying them**, and the page's queries
  too (section 7).
- **TMSL is open JSON, but one engine runs it.** The browser needs the compiler to read it.
- **JSON has no comments:** the why of a measure goes in its `description`.

## 5. Serving

Two serving paths read the same semantic model and the same DAX.

| | Client side | VertiPaq |
|---|---|---|
| Engine | DuckDB-WASM 1.5, in the reader's browser | Power BI (VertiPaq), in Fabric |
| Data | a copy of the `mart` tables as `.duckdb` files | the `mart` Iceberg tables, in Direct Lake, no copy |
| DAX | turned into SQL by `compiler.js` | run as written |
| Clients | GitHub page, Fabric app (DuckDB-WASM) | Power BI report, Fabric app (VertiPaq) |
| Reader identity | none (GitHub) or Fabric sign-in with a SAS | the reader's own access to the model |

### Client side: now
- `scripts/cache_catalog.py` copies the `mart` tables into `.duckdb` files and only decides
  the split: a half-year per file (GitHub's 100 MB limit), the newest 14 days hourly, the
  dimensions and aggregates whole.
- DuckDB-WASM runs single-threaded, with files downloaded whole into OPFS and attached in
  place.
  - Remote reads go one block at a time, three round trips each, about 700 ms per round
    trip to OneLake (one 2024 day: 38 s). Downloading whole is faster; a block cache in
    the engine would change that.
  - The threaded build can't load ICU or share the OPFS handle, and gains about 1.4x.
- `compiler.js` turns the model into views and the page's DAX into one SQL query, by fixed
  cases, and throws on anything it doesn't know. It implements by hand what DAX gives for
  free: measures inlined; filters reaching another fact only along relationships (one CTE
  per fact); `ISFILTERED` for the grain switch; `KEEPFILTERS`; DAX's rows (`SUMMARIZECOLUMNS`
  leaves out all-blank groups, `TOPN` keeps ties).
- Measured in the browser: a measure of another fact as a CTE 0.25 s (1.3 s inline);
  capacity per unit in two levels 0.8 s (2.7 s); `MAX(col, 0)` as DOUBLE 335 ms (623 ms).

### Client side: limits and next
- **The site is about 880 MB against GitHub Pages' 1 GB**, growing about 125 MB a year.
  Where the 5-minute history lives is a decision: another host, or recent years only.
- **The deploy repo is squashed weekly**, because the hourly file grows its history by
  gigabytes.
- **The compiler covers this page only.** An open semantic runtime would replace it
  (section 9).
- **Reading the catalog directly** instead of a copy (section 10).

### VertiPaq: now
- `deploy_model.yml` deploys `model.bim` to workspace `power`; Direct Lake reads the `mart`
  Iceberg tables as Fabric exposes them, so nothing is copied and the data is as fresh as
  the last run.
- The measures' grain switch reads the daily tables when no time of day is asked: the whole
  history by year and fuel takes 0.43 s from them, 1.9 s from the 5-minute table, same total.
- The Fabric app on VertiPaq sends the page's DAX through a Rayfin connector, as the
  signed-in reader; its `storage/data.js` only reshapes the rows (column names, dates).

### VertiPaq: limits and next
- **Fabric apps aren't available in Australia Southeast**, the model's capacity region, so
  the VertiPaq app is built but not deployed.

## 6. Clients

### Now
| Client | Engine | State |
|---|---|---|
| GitHub page (public) | DuckDB-WASM | Live. Every shared change is checked here first |
| Fabric app, DuckDB-WASM | DuckDB-WASM | Live, deployed from the laptop (microsoft/rayfin#89). Reads the lakehouse with a short-lived read-only SAS from a function |
| Fabric app, VertiPaq | Power BI | Built, not deployed: Fabric apps aren't available in Australia Southeast |
| Power BI report | Power BI | Live; holds no measure of its own |

### Limits and next
- **Run the page's DAX against the deployed model** and compare its rows with the
  compiler's. It needs no app and no CI.
- **Deploy the DuckDB-WASM Fabric app from CI** once rayfin#89 is fixed.
- **No CI sees a chart draw** in the report; a visual is checked by opening it.

## 7. Verification

### Now
- `dbt build --target ci`: plain DuckDB, real downloads (two files per feed), every model
  and test.
- Daily `dbt test` on the live tables. The completeness tests use `NOT EXISTS`; the
  DUID test checks recent units only (`assert_recent_scada_duids_registered`).
- Dashboard changes: old page against new in headless Chrome, on the same deployed files,
  comparing each chart's ECharts series, the SQL that ran, `EXPLAIN`, and alternating
  timings.
- Every model deploy: refresh, row counts, each measure per day, the grain switch timed
  (0.43 s daily table, 1.9 s 5-minute table, same total).
- The owner's review. The automated checks compare a figure before and after; none checks
  where a figure is defined.

### Limits and next
- **Golden DAX queries through both engines:** the page's queries run by the compiler and
  by the deployed model, rows compared. The real test of the compiler; it can run from the
  development machine today.
- **A lint on the page:** fail when `index.html` does arithmetic on measure results or
  names a view outside the Analyze tab.
- **Layout measured:** element boxes before and after a hover or drag.

## 8. Semantic layer and AI agents

- **The risk:** an agent writing a client defaults to SQL per chart, with WHERE clauses
  standing in for interaction. Each chart is correct on its own, so per-chart checks pass;
  what's lost is one definition across clients.
- **What guards against it here:**
  - the rule in AGENTS.md: a figure the model can express is a measure, and the page only
    groups, filters and names measures;
  - the compiler throws on what it doesn't know, so a gap is fixed in the language;
  - the page's DAX has to be valid DAX, because the VertiPaq app sends it to Power BI as
    written.
- **What would guard better:** checks rather than rules (the golden queries, the page lint
  in section 7). A written rule depends on the agent reading it; a failing check doesn't.
- **AGENTS.md is the real specification** (about 860 lines), with dates and the owner's
  reasons, so a later session doesn't undo a decision it doesn't understand.

## 9. What SQL would need

No open-source language and runtime has DAX's semantics, so SQL with WHERE parameters is
always the shortest path. Five additions would make the right path the easy one, each
replacing a part of `compiler.js`:

1. **Measures in the catalog:** `CREATE MEASURE fct_summary.capacity_factor AS ...`,
   called by name, evaluated in the query's context. *Replaces:* inlining, and divisions
   in the client.
2. **Relationships that carry filters:** a filter on a dimension reaches every related
   fact; a filter on one fact's column stays there. *Replaces:* the per-fact CTEs.
3. **Context modifiers:** Calcite's `AT` ("Measures in SQL", Hyde, 2024),
   `revenue AT (SET date = date - 1)`, `AT (ALL region)`. *Replaces:* `KEEPFILTERS`,
   previous-period queries in the page.
4. **Grain inside the measure**, and aggregate tables the engine routes to on its own.
   *Replaces:* the per-unit two-level query, `[Reads 5 minutes]`, `wholeDays`.
5. **A query surface for visuals:** group, filter, name measures, nothing else, with
   filters as structured values. *Replaces:* the possibility of a client computing its own
   figures.

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

## 10. Reading the catalog from the browser

- **Authentication works today.** A page signs the user in with MSAL.js (PKCE, an SPA app
  registration, no client secret) and asks for `https://storage.azure.com/user_impersonation`.
  That one token is what the OneLake Iceberg endpoint and the storage both accept. It is the
  reader's own, lasts about an hour, and reaches only what they can read: nothing to hide.
- **CORS passes.** Checked 2026-10-07 in Chrome 154: a fetch with `Authorization: Bearer`
  to the catalog (`onelake.table.fabric.microsoft.com/iceberg`), to a file with a Range
  header (`onelake.dfs...`) and to the user-delegation-key call (`onelake.blob...`) all get
  through the preflight.
- **What's missing is the engine.** DuckDB-WASM's documented extensions include neither
  `iceberg` nor `azure`. Iceberg in the browser has been shown over S3 Tables and R2 with
  the native http extension, not over Azure. OneLake's metadata points at `abfss://` paths,
  so it needs the azure extension in WASM, or the iceberg extension reading `https://`
  with a Bearer header or a SAS (the page can sign one itself from a user delegation key).
- **When it lands:** the Fabric app's SAS function and its owner-only deploy go away, and
  recent data can come live from the catalog, with a cache in the engine for the history.
- **Not covered:** the public page, which has no reader identity.

## 11. Open items

**Waiting on upstream**
- OneLake accepting commits that mix delete files with data files (fixed upstream, rolling
  out): re-run the probe, then switch the merges to updates and update AGENTS.md's
  "insert-only" sections.
- DuckDB 2.0.0 stable (due 2026-10-21): replace `2.0.0.dev2609250715` everywhere it is
  pinned, and re-run the probe.
- A duckdb-wasm build on DuckDB 2.0: move the dashboard and the import's write venv
  together.
- DuckDB-WASM with Iceberg on Azure (section 10).
- duckdb-iceberg#1341 (snapshot expiry): replace pyiceberg.
- microsoft/rayfin#89: deploy the DuckDB-WASM Fabric app from CI (`deploy_fabric.yml`,
  `app=wasm`, item `nemtracker`).
- AEMO publishing `ROOFTOP_PV_ACTUAL_PRED`/`_RUN`: move `fct_rooftop_pv` to the 5-minute
  estimate.

**Ideas**
- Emissions on the page: `[Emissions t]` and `[Emissions intensity]` are in the model.
