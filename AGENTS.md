# AGENTS.md — iceberg_as_code

## Quick Reference
- **Stack:** dbt-duckdb, **OneLake Iceberg REST catalog** (Microsoft Fabric workspace `power`,
  lakehouse `nem` — its own lakehouse, separate from the sibling repo's `data`, because both
  repos write identically-named tables in `landing`/`mart`)
- **Run:** `dbt build --target ci --profiles-dir .` (test, plain DuckDB, no Iceberg; it
  downloads two files per feed from nemweb and GitHub, so it needs both to be up)
- **Run:** `dbt build --target dev --profiles-dir .` (writes to Iceberg; needs the OneLake env
  vars below). **`dev` is `prod`**: same catalog, same `landing`/`mart` tables, there is no
  separate dev schema. It refuses to run without `FILES_PATH` (`dbt_project.yml`
  `on-run-start`): the archive would go to the local `/tmp` and its paths into the shared log.
- **Schemas:** `mart` (the dimensions and the tables the semantic model reads) / `landing`
  (the raw facts, staging)
- **Keep the source as raw as possible; transform in the next layer.** A source table holds
  what the feed published, as published. Combining, interpolating, filling in and reshaping
  for reporting happen in a derived table built from it, never in the source.
- **Writes are insert-only merges** (`WHEN MATCHED DO NOTHING`), from when the OneLake
  catalog rejected a commit mixing delete files + data files (BadRequest 400). It no longer
  does: a `MERGE` that updates and deletes, an `UPDATE` and a `DELETE` now commit (see
  "Row-replacing writes"), so insert-only is now a choice per model, not a constraint. Same
  pattern as the sibling repo (dbt-fabric). `dim_calendar` is a plain
  `append` — its NOT-IN filter keeps existing dates out; it runs to `current_date + 2 years`.

## The sibling repo
[`dbt-fabric`](https://github.com/djouallah/dbt-fabric) runs the same AEMO models on other
engines: `models/aemo/dwh/` (Fabric Warehouse) and `models/aemo/spark/`. It has no
DuckDB/Iceberg variant, so ports are by idea, not by file (`macros/new_source_files.sql` there
is the counterpart of `macros/pending_archive_files.sql` here). The one model that is the
same file is `fct_summary`, taken from the iceberg tree of
[`fabric-medallion-dbt-community`](https://github.com/djouallah/fabric-medallion-dbt-community)
(dbt-duckdb on this same kind of catalog); the dashboard reads it with the other `mart`
tables, through the same semantic model as Power BI.
**Look there first for fixes, and port them rather than diverging.** Worth knowing: there,
downloading lives outside dbt and the log is read straight from parquet, not from an Iceberg
table.
Four deliberate local differences, all of which must survive a port:
- `fct_summary` decides its dates at compile time from the Iceberg manifests and writes
  them as literals (Architecture point 3): the newest daily date minus six days on, the
  intraday feed after the newest daily interval, and in a refill `process_limit` dates
  below the oldest it holds (uncapped, a refill runs the runner out of memory). The
  reference asks the data (`MAX(DATE)`, `DISTINCT DATE ... NOT IN`, the partial-dates
  `COUNT(DISTINCT time) < 280`): full scans of the biggest tables on every run. The
  partial-dates repair is not kept (its header says why; the test remains).
  `dispatch_duids` is the units of the window's next-day rows, not of all history.
- No `relationships → dim_duid` tests on `fct_scada`/`fct_scada_today` — `dim_duid` holds the
  registered DUIDs plus the unlisted ones that generated, while the facts go back to 2018 and
  also carry units only ever dispatched at 0 MW, so the test could never be 0.
  `tests/assert_recent_scada_duids_registered.sql` is the meaningful version and is this
  repo's own.
- `tests/assert_all_*files_processed_*.sql` use `NOT EXISTS` and are untagged; the sibling's
  use `NOT IN` (a single NULL `file` makes them permanently green) and are tagged `heavy`.
- `profiles.yml` keeps a `ci` target (plain DuckDB, no Iceberg; `build.yml` gives it a file,
  `ci.duckdb`), and `dbt_project.yml`'s `on-run-start` hooks are guarded with
  `target.name != 'ci'` — the sibling's are unconditional and would break that target.

## Architecture
1. `stg_csv_archive_log.py` (Python model) downloads AEMO + GitHub data and archives the
   gzipped CSVs **to OneLake Files** (`FILES_PATH`, i.e. the `nem` lakehouse's `Files/csv/`),
   alongside a durable `Files/csv_archive_log.parquet`. The archive is durable, so there is no
   reconciliation code: an interrupted run is picked up by the next one.
2. **No daily/intraday split.** Every hourly pass does every feed (the daily files,
   intraday SCADA, intraday DispatchIS, the monthly interconnector archive, rooftop current /
   weekly / monthly) plus the DUID reference, self-gated on data rather than on a schedule:
   each DUID reference file is downloaded when its log row is 24h old; the Daily_Reports folder
   is only listed while the log lacks yesterday's (Brisbane) next-day file; and the backfills
   (the GitHub historical listing, the monthly archives, the weekly rooftop archives) only run
   when that listing ran and returned fewer than `download_limit` new daily files. `download_limit` is per feed.
   **A source that fails skips itself, not the run**: a nemweb folder that can't be listed,
   or a reference file that can't be fetched, prints a `::warning::` and that feed downloads
   nothing this pass; the previous reference file and its log row stay. The model must not
   raise for it: every fact `ref`s this model, so one unreachable site (the WA one, or
   `ROOFTOP_PV/ACTUAL` once AEMO removes it) would skip all seven facts. A failed write to
   OneLake still raises.
   The DUID refresh saves the generator sheet of AEMO's **NEM Registration and Exemption
   List** (the newest copy archived weekly in `djouallah/aemo_data/data/duid/registration/`) as
   `Files/csv/duid/registration.csv`. `dim_duid` takes its NEM units from two files only: that
   list, and `duid_unregistered.csv` (`djouallah/aemo_data`), the units in the data that the
   list doesn't have (closed plant, replaced DUIDs, non-scheduled units; about 100). That file
   is generated, not typed, from AEMO's MMSDM registration history (`DUDETAILSUMMARY`,
   `DUALLOC`, `GENUNITS`, `STATION`, `PARTICIPANT`); its commits say how, and some small loads
   AEMO gives no energy source for have a region and no fuel. It is a snapshot: a unit that
   leaves the list later stays in `dim_duid` (the merge deletes nothing), but a `rebuild=dim_duid` loses it
   until the file is regenerated. **Missing or wrong units are fixed in that file, never in
   dbt** — `dim_duid` has no fallback.
   The same refresh keeps three tables of the newest MMSDM month (`genunits.csv`,
   `dualloc.csv`, `interconnector.csv`; last month's archive, or the one before while it is
   not out). They hold every DUID and genset that ever ran, registered or not:
   `dim_duid.CO2eFactor` comes from them for every unit, and `dim_interconnector` from the
   last.
3. Work is discovered from the **log table**, not a filesystem glob: each fact model's pre-hook
   (`macros/pending_archive_files.sql`) builds its path list from
   `SELECT DISTINCT stg_csv_archive_log.archive_path` filtered by `NOT EXISTS` against
   **`landing.processed_files`** (not `NOT IN`: one NULL would stop every load), newest first
   (`ORDER BY archive_path DESC LIMIT process_limit`; that is path order, so newest first
   within a source folder, and for a model that reads several folders one folder after the
   other). `processed_files` (`model, csv_filename, processed_at`) is appended by each
   fact's post-hook (`macros/record_processed_files.sql`, outside the model's transaction)
   with the files its batch merged: a file counts as processed once its batch committed,
   whether or not it yielded a row. Anti-joining against the fact's own `file` column
   instead would be a full scan of the fact over OneLake, twice per model per run. A
   `rebuild=<fact>` appends a reset row (`csv_filename` NULL) for it, so only files
   processed after the reset count and the refill reads the whole archive again. The
   table's first build seeds it from the facts' `file` columns (`rebuild=processed_files`
   reseeds it); the `assert_all_*files_processed_*` tests still compare the log to the
   facts. The DISTINCT is load-bearing: the log table is append-only and can hold a file
   more than once, and MERGE only dedupes against the target, never within a batch —
   without it a backlog is read 2-N times per batch and turns into duplicate keys.
   **The mart models decide their dates the same way, without scanning:**
   `MIN`/`MAX` of a date column come from the Iceberg manifests
   (`macros/date_bounds.sql`, `iceberg_column_stats()`), and the dates a run recomputes are
   written into the SQL as literals, so every scan of a big table carries a constant `DATE`
   filter that duckdb-iceberg prunes data files on. The pinned 2.0 build also prunes on a
   subquery or a join (a runtime min/max filter: `fct_scada`, 3 of 160 files, run
   38255990890, 2026-10-12), but the literals stay: `MAX(DATE)` of the table itself still
   reads it whole (87 s), a model decides at compile time whether it has anything to write
   (`nothing_to_do()`), and a refill's two ranges would become one min/max spanning every
   file between them. Each model logs the bounds it read and the ranges
   it chose, so a run's log says what it decided. The `ci` target (no Iceberg) reads plain
   `MIN`/`MAX`.
   The staging model appends only the rows the Iceberg table is missing (anti-join on
   source_type/source_filename/csv_filename against `dbt.this`). Appending the whole log every
   run would grow the table by its own size 48 times a day, until the OneLake catalog answers
   HTTP 500 to every load and commit of it. `Files/csv_archive_log.parquet` is the durable
   log and the only source of truth — the Iceberg table is a materialization, rebuildable
   from it.
4. `process_data.yml` runs `dbt run` (tests live in `table_maintenance.yml`), writing straight
   to the OneLake Iceberg catalog. No `dbt run-operation` anywhere — there are no operation
   macros.
5. **Maintenance:** the `compact_and_expire` job in `table_maintenance.yml` runs
   `scripts/compact_iceberg.py` (folding small data files together via
   `iceberg_rewrite_data_files()`) and then `scripts/expire_snapshots.py`. Order is not
   negotiable: the rewrite adds a snapshot and leaves the previous ones pointing at the files
   it replaced, so expiry is what makes compaction worth anything. Expiry is **pyiceberg**
   because duckdb-iceberg has no `expire_snapshots` yet. Expiry is metadata-only: snapshots
   leave the metadata JSON and their files stay. The same script then runs pyiceberg's
   `remove_orphan_files()` per table (apache/iceberg-python PR #3361, unreleased, built from
   its commit): it lists the table's folder and deletes the files no snapshot or metadata
   references, older than 3 days, skipping every `_`/`.` path (OneLake's `_delta_log`) and
   refusing when a listed and a referenced path differ only in scheme or host (adlfs lists
   `abfss://<ws>/...` for the metadata's `abfss://<ws>@onelake.dfs.fabric.microsoft.com/...`,
   so the script declares those the same authority). It deletes; `ORPHAN_DRY_RUN=true`
   only lists. The first pass, 2026-10-09, found 14,524 orphans, ~11.5 GB, 7 GB of it
   `fct_scada`'s.
   Tables hold 16-18 snapshots, none older than a day,
   so something on the OneLake side already trims them; treat this step as a bounded safety
   net, and if a table is ever seen above ~48 snapshots that assumption has changed. The job
   takes a job-level `process-data` concurrency group — both operations commit
   optimistically, so an overlap with a load could fail one side. GitHub keeps one pending
   run per group: while compaction holds it, each new Process Data run replaces the one
   waiting, and a maintenance job still waiting is replaced by the next Process Data run.
   It is `continue-on-error` and both scripts always exit 0: maintenance must never fail its
   workflow (a red run there means a dbt test failed). The price of that is that a
   compaction that has stopped working only shows in the job's log. Both scripts read their
   table list from `scripts/iceberg_tables.py`; a new model gets added there once.

## Row-replacing writes
Until October 2026 the OneLake catalog rejected a commit that mixed delete files with data
files (`BadRequest 400`): an `UPDATE`, a `MERGE` that updates or deletes, a `DELETE` and an
`INSERT` in one transaction. Hence the insert-only merges, and replacing rows as two commits
(`fct_curtailment_region`'s pre-hook `DELETE`, then its merge, until 2026-10-17), which
were not atomic.
On 2026-10-17 `power`'s catalog accepted all of them from duckdb `2.0.0.dev2610161340`
(duckdb-iceberg `10eafd0b`), the right rows each time (`probe_catalog.yml`, run
38993625254): a `MERGE` that updates and inserts, one that also deletes
(`WHEN NOT MATCHED BY SOURCE ... THEN DELETE`), an `UPDATE` and a `DELETE`, one snapshot each
(duckdb-iceberg#1581, #1584), and a `DELETE` and an `INSERT` in one transaction (two
snapshots, one commit). fabriccat's catalog gives the same. The first attempt of that run
timed out on the commit of the deleting `MERGE` (HTTP POST timeout) and the re-run passed:
one transient so far, but watch for it. The previous build, `dev2610011535`, cannot run a
`MERGE` with two update/delete actions at all (duckdb refuses it). Re-run
`probe_catalog.yml` after a new duckdb release.

The full catalog capability probe (CREATE/INSERT/DELETE/UPDATE/MERGE/DROP and the rest, per
engine) lives in the user's **separate repo**; `probe_catalog.yml` here covers only the
row-replacing writes, with this repo's pin, on `power`.

## Auth (GitHub Actions) — no secrets
OIDC only: `azure/login@v2` with a federated credential, then each job mints a short-lived
`ONELAKE_TOKEN` via `az account get-access-token --resource https://storage.azure.com/`.
The ids live in repository **variables** (public identifiers, not secrets):
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` — the tenant + Entra app (named
  `dbt_fabric_python_iceberg`, no client secret; shared with the sibling repo)
- `WS_ID`, `LH_ID` — the Fabric workspace (`power`) and lakehouse (`nem`). The workflows build
  `WAREHOUSE_PATH = {WS_ID}/{LH_ID}` and `FILES_PATH = abfss://{WS_ID}@onelake.dfs.fabric.microsoft.com/{LH_ID}/Files`
  directly from them. **No workflow creates or looks up this lakehouse** — that is
  infrastructure, created once by hand (schema-enabled, since the models write to
  `landing`/`mart`). If it is ever recreated, update `LH_ID`. (`deploy_fabric.yml` creates a
  lakehouse, but its own, in the workspace it installs into: see "The whole stack in one
  workspace".)
- `LAKE_TENANT_ID`, `LAKE_CLIENT_ID` — the Fabric app's tenant and an Entra app there
  (`fabric-github-deploy`), a member of the app's workspace: the identity of
  `deploy_fabric.yml` into a fabriccat workspace (the catalog's tenant gets
  `AZURE_CLIENT_ID`). The app's federated credential for this repo has the subject
  `repo:djouallah/analytics-as-code:ref:refs/heads/main`.
- `TEST_WS_ID`: fabriccat's `conformance-oracle`, where everything but the data pipeline
  is tested (`deploy_model.yml` and `deploy_fabric.yml` by default, dax-sql's Oracle). The
  data pipeline (`process_data.yml`, `table_maintenance.yml`, `import_data.yml`) is the only
  thing on `power` (`WS_ID`/`LH_ID`, the owner's tenant).
Env contract consumed by profiles.yml, the models and the scripts: `ONELAKE_ENDPOINT`,
`ONELAKE_TOKEN`, `WAREHOUSE_PATH`, `FILES_PATH`, `download_limit`, `process_limit`,
`ALL_PERIODS` (the two import workflows), plus
`AZURE_TRANSPORT_OPTION_TYPE=curl` + `CURL_CA_INFO` on runners (the azure extension's default
transport fails the OneLake TLS handshake).
`NEMTRACKER_TOKEN` (gh-pages deploy) is the one true secret.

## Dashboard
**The layout says who reads the model:** `semantic_model/` at the top of the repo is the one
semantic model, and `dashboard/` holds its one client, the page, and the hosts that run it.
**The page is written once, `dashboard/page/`**, and a host adds only how it reaches the
data, its `storage/data.js` (staged over the page, `scripts/stage_pages.mjs`):
- `dashboard/github/`: GitHub Pages, DuckDB-WASM over the `.duckdb` copies of the tables
  (`data.js`, `history.js`, `views.js`, staged into the page's `storage/`).
- `dashboard/fabric_app/`: the Fabric apps (Rayfin), one per engine. `iceberg/` is
  DuckDB-WASM over the Iceberg catalog (see "The Fabric app on the Iceberg catalog").
  `vertipaq/` is the deployed model as the engine, installed by `deploy_fabric.yml` (see
  "The whole stack in one workspace"). What the two share is in `dashboard/fabric_app/`:
  `common/` (`build.mjs` and the Fabric sign-in, `site/storage/auth.js`), `package.json`
  (the Rayfin CLI, one `npm ci` for both, `npx rayfin` run in an app's folder) and
  `.gitignore`. What Rayfin wants in each project stays there: `rayfin/rayfin.yml`,
  `rayfin/tsconfig.json`, `rayfin/data/schema.ts`, and `iceberg/`'s function.
**`dashboard/page/` is one page and two ways of asking:** the page itself
(`index.html`, `frontend/` draw.js, logs.js, perflog.js, `storage/queue.js`, `dag/`, and
`semantic/query.js`, which both ask through), `dax/` (`frontend/queries.js`: each query an
object of the model's fields) and `sql/` (`frontend/queries.js`: each query a SELECT over the
model in dax-sql's SQL, `... AGG("measure") ... FROM model`). The compiler builds the same
plan from either, as Spark's SQL and DataFrames build one logical plan: the same measures,
the same rows. No figure is written in SQL by hand any more (until 2026-10-13 the SQL page
was hand-written SQL over the views, and fell behind every rule the compiler learned). A page
is `page/` with one of the two copied over it, then a host's data source, and the model and the
compiler next to `semantic/query.js` (`scripts/stage_pages.mjs`, `stagePage`). The DAX page is served at the
site's root, the default, the SQL page at `sql/`, which reads the site's `data/` (`connect`
in its `queries.js` passes `base: '../'` to `data.js`'s `init`). The SQL page is held to the
DAX page (`scripts/parity/sql_page.mjs`, below). Below, "the page" is the DAX page unless
said.
**The GitHub page is the critical one: it is public and must never break.** The Fabric apps
are internal: they should not break either, but it is not the end of the world
if one does. So a change that touches what they share (the model, the `mart` tables, the
page's files) is checked on the public page first and goes out only when that check is
clean, and where the clients pull apart the public page wins.
The page has the layers of a BI stack, each in its own place under `dashboard/page/` (the
table of what stands in each place in a real product is in `doc/ARCHITECTURE.md`), and two
hosts that run it on DuckDB-WASM: GitHub Pages and a Fabric app. Everything is the same file
on both except `storage/data.js`.
- consumer: `index.html` (the charts) and `frontend/queries.js` (what each chart asks)
- query language: the page's queries, objects of the model's fields (`select`, `where`, ...),
  which the compiler writes as DAX
- semantic model: `semantic_model/ossie.yaml` (at the top of the repo), an Apache Ossie model
  whose measures are DAX
- query: `semantic/query.js`, the page's queries to DAX (`toDax`)
- compiler: `dax-sql` (its own repo, a submodule at `dax-sql/`; staged as `semantic/dax-sql/`), the DAX to SQL
- engine: DuckDB-WASM
- storage: `storage/data.js`, `storage/history.js`, `storage/views.js` (a view per table)
- and the Logs tab, `frontend/`
`index.html` imports `storage/data.js` and `frontend/queries.js`, nothing else of these:
`queries.js` exports `connect(data)`, what runs its queries (the compiler's `createModel`,
on both pages). So a client of the page swaps
`frontend/queries.js`, not `index.html`.

**It is a proof of concept; the point is that the layers are there, in the formats of a
real product.** The compiler is two steps, as in Power BI: the page's query becomes DAX
(`toDax`, in `semantic/query.js`, which knows the page's words and nothing of SQL), and the DAX
becomes SQL in `dax-sql`, a general DAX compiler: any Tabular model, DAX's filter
context, context transition, relationships and blanks (see its README and DESIGN.md). Its
rows are DAX's: `SUMMARIZECOLUMNS` leaves out a group whose measures are all blank, `TOPN`
keeps the rows tied with the n-th, an ascending `ORDER BY` puts blanks first. **dax-sql
knows nothing of this model, this page or this data**: no case for a measure, a table or a
query, and nothing it assumes of the data that the model does not declare
(`relyOnReferentialIntegrity`, or the page's `assumeIntegrity`). A change there is a
general rewrite, checked by its own tests and by the page's (below), never a case for a
query. **It is its own repo, [djouallah/dax-sql](https://github.com/djouallah/dax-sql)**
(MIT, N.S. Devaraj and the owner), whose contract is a model and a DAX query in, SQL out:
writing the DAX stays here. This repo pins it to one commit as the git submodule `dax-sql/`
(a clone needs `git submodule update --init`; every workflow checks it out, and a worktree of
another commit inits its own). A change to the compiler is made and tested there, and reaches
the page when the pin moves here, in a commit of its own: `compiler_ab.mjs` then compares the
two pins, as it compares any two commits. Which table a measure reads is the model's rule, which DAX answers from the query;
which grain a date range gets, and MW to MWh, are the page's.
**The page knows no DAX.** An agent must not be able to write arbitrary DAX, inline
calculations and the like into the page; a query asks the way a report visual does, and
`grep -i dax` finds nothing in `index.html` or `frontend/queries.js`. A query is an object of
the model's fields, and these words only:
`select` (a column `'table.column'` grouped by, a measure by its name `'Generation MW'`, or
`{ min | max: column }`, a key's first or last value), `where` (conditions on columns:
`= <> < <= > >= between in notIn blank notBlank`, and `{ any: [...] }`; a value is a string,
a number, true or false, or a date), `having` (on a value of the select), `totals` (a
subtotal over some of the select's columns), `orderBy` and `top`. `toDax` in `query.js`
writes its DAX, checking each column and measure against the model, and `query()` refuses
DAX text. What DAX needs that a query does not say is the compiler's to add: a query of a
dimension's columns alone leaves out the blank row DAX gives a dimension whose key a fact
names and it lacks (`dim_duid`, `dim_interconnector`).
**The words, and the compiler's cases for the measures, are frozen**: a new one is the
owner's to add, never a page's or an agent's. What a query cannot say is a measure of the
model, or a column of it. Power BI is the idea, not the format: none of its formats is
copied, ported or kept compatible.
**The DAX the compiler writes has to be right in DAX, not only through the compiler**: it is
run against the deployed model before a change goes out (the parity check, below). A fact's
own column does not filter a dimension, so a query that reads a unit's attribute per unit
(its station) groups by `dim_duid[DUID]`, which the compiler reads off the fact.

**The page is a renderer: it works out no figure.** It uses the same semantic model as
every other client, and the JS holds no logic: it renders mechanically. A figure is a
measure of the model, the one Power BI calls; a total is a `totals` row; a group is a column
of the model (`dim_duid[Plant]`, `[Owner]`, `[Storage]`); an order is an `orderBy`; a share
of what is shown is `[Generation share]`; a change against the days before is a
`[... change]` measure. If a measure can be expressed in the model, it is there. When the
model or the compiler cannot say something, the model gets the measure or the column, or the
compiler the case, never the page the formula. What numbers the page does handle is how it
draws (an axis cut at a percentile, a bubble's size, a layout, a number written as text,
which row is the largest), and all of it is in `dashboard/page/frontend/draw.js`.
So the page shows no figure that is not a measure: no Flows events under the clock (a jump
of a link or a price between two intervals), no "how long a link has had no flow", and no
share on the hero's "Other" (the share of several fuels together is no measure).
**`scripts/parity/page_lint.mjs` enforces it** (`build.yml`, on every push): no `+ - * / %`
on numbers, no `+= -=`, no `.reduce()` in the script of `index.html` or in either page's
`queries.js` (the SQL page's are measures named in its SELECTs); it
does not read `draw.js`, which a review reads instead. The rows the page uses as they are
stored are not figures: the filter lists, the newest interval, the Flows rows (a unit's MW,
a link's flow and limits).

**Analyze opens on Model**, its first sub-tab: the model drawn as a star
(`frontend/model.js`, the layout `draw.js`'s `modelLayout`: a dimension is a table a
relationship points to, in the centre; the facts either side), and for the table picked its
columns, measures and relationships as the file has them. It reads the staged
`semantic/ossie.json`, as the TMSL it stands for, and no data. The SQL box is the second sub-tab.
**The Analyze tab's SQL is SQL, and only SQL**, on both pages: DuckDB's, over the views
(`v_<table>`, the stored columns), in which **a SELECT over the semantic model** is a
relation. That SELECT (dax-sql's SQL: `SELECT <columns>, AGG("<measure>"),
SUM(<table.column>) ... FROM model WHERE ... GROUP BY ALL | ROLLUP ... HAVING ... ORDER BY
... LIMIT | FETCH ... WITH TIES`) is compiled as the page's own queries are, so a figure in it
is the model's measure, as the charts compute it; a column is `table.column`, or its name
alone when one table has it. It is the whole text, or in parentheses anywhere DuckDB takes a
subquery (a `WITH`'s query, `FROM`, an arm of a `UNION`, `IN`), and the SQL round it runs as
written: joins with the views, unions, window functions. **The model is not a view, and
cannot be one**: a measure has no value until the groups are chosen, so `JOIN model` or an
unparenthesised `UNION` arm over it is an error. Which text is a SELECT over the model is
dax-sql's to say (`compileStatement`, with a lexer: `FROM model` in a comment or a string is
text), never a regex of the page's. Analyze compiles with no browser casts
(`castOutput: false`), so the model's columns keep DuckDB's types and compose with the views'.
`analyze(text)` in `query.js` returns what runs; the preview, the count, EXPLAIN and the CSV
are built round it, and the Logs tab shows the DAX of each model SELECT in it. The example is the
model query alone. The page writes no SQL into it: SQL built from the page's filters would
be a second query language with figures of its own. `query()`, which the page's own queries
go through, takes a query object or a SELECT over the model and nothing else, so SQL over
the views cannot come back into the pages; `query()` and `analyze()` refuse DAX text. Don't
make the box accept DAX. Its CSV is the rows of its SQL (`draw.js`'s `writeCsv`).

**The compiler is checked against the model:** `scripts/parity/page_queries.mjs`
calls every member of `queries.js` the way `index.html` does, over 12 page states, and runs
each query's SQL on the deployed `.duckdb` files; `scripts/parity_model.py` asks the deployed
model the same DAX and compares the rows (to a cent, or a part in a million: VertiPaq's
fixed decimal). `deploy_model.yml` runs it after `check_model.py` **only when dispatched with
`parity=true`**: the queries cost the capacity's CU. A new query of the page is in it once
`asked()` there calls it. From a laptop it runs over REST with a user token
(`POWERBI_TOKEN`, `WS_ID`), which answers at most 100,000 rows. The states and `asked()` are
`scripts/parity/page_states.mjs`. **The SQL page is held to this one**
(`scripts/parity/sql_page.mjs`, the step after in `deploy_model.yml`): every member of the
SQL page's `queries.js`, in the same states, against the DAX page's over the same files, the
same rows (matched on the columns that are not figures, to a part in a million) in the order
its `orderBy` asks. Both compile through the same model, so a difference is a SELECT that
does not ask what the object asks, or a fault of dax-sql's SQL front end. With an output file
it writes the shape `parity_model.py` reads, the DAX next to the SQL page's rows, to ask the
model directly.
Rules these checks hold the page and the model to:
- A count of no rows is blank, as in DAX, not 0.
- `dim_duid` has one spelling per name (VertiPaq compares text case-insensitively, DuckDB
  does not).
- DAX does not filter a query of a fact's own columns by a dimension unless a measure of it
  is blank there. So such a query selects a measure (`[Average MW]` for a unit's MW), and a
  measure it selects is blank where there are no rows (`[No flow]` is 1 or 0, not a
  boolean: a boolean measure is never blank).
How the check runs:
- A result above 20,000 rows is not asked of the model, only listed (`not asked`) with its
  count: large results throttle the capacity, fetched or under `COUNTROWS`, which computes
  the rows all the same. The same DAX is compared at the states where it is smaller.
- It asks only the queries whose key changed since the commit of the last green parity run
  of `deploy_model.yml` (its run name ends in "+ parity"; dispatch `since` to name another
  commit, `since=all` for every query): the DAX and SQL without their literals, and the DAX
  of every measure the query reaches (a changed measure counts whichever side of an `IF` the
  query takes, so it asks more than it must, never less). The queries are built again from
  that commit's own `queries.js`, compiler and model; one it does not have counts as
  changed.
- A query over 20 s means the capacity is throttling, and the check waits 5 minutes after it.
- `publish=false parity=true` runs the check alone, on the model as deployed: publishing
  needs memory the model may not have left after a day of parity (3 GB limit).

`index.html` is the one file at the top of the staged page: it is the site's URL, and `data.js`
finds `data/` from the page's URL. **The repo tree is not the served tree**: a page is staged
(`scripts/stage_pages.mjs`: `page/`, the variant over it, the host's data source, and for the DAX page
`semantic_model/ossie.yaml`, as `semantic/ossie.json`, next to the compiler and its readers,
`dax-sql/formats` as `semantic/formats/`), and everything that serves
or imports the page stages it first: the site (`build.yml`, `import_data.yml`), the Fabric
app's build, the parity scripts. To serve it from a laptop, stage the site into a folder
(`node scripts/stage_pages.mjs <dir> <build>`) and put a copy of `data/` next to it. A relative
import is of the staged tree (`semantic/query.js` imports `./dax-sql/index.js`, which
`stagePage` copies there from `dax-sql/src`).
- `dashboard/page/index.html` is the page: the charts, which draw what
  `dashboard/page/dax/frontend/queries.js` asks: every query the charts send, by tab and chart
  (`createQueries(page)`, over the page's state passed in as functions; the renderers only
  call it). The queries name the model's tables, columns and measures (`fct_summary.mw`,
  `dim_duid.FuelSourceDescriptor`, `Capture price`). **The page joins nothing** and names no
  view (outside Analyze and `data.has('v_...')`). Which fuels are renewable, and which units
  are storage, is not in the dashboard at all: `dim_duid.Renewable` and `dim_duid.Storage`
  say (a generator is a unit that is not storage, a unit with no fuel included). What
  `queries.js` holds is which grain a date range reads (`grain()`: the 5-minute tables up to
  30 days, the daily ones beyond), and with it which measure a chart draws at that grain.
  The page does not name the table for it: up to 30 days it
  filters and groups by the fact's own columns (`fct_summary.date`, `fct_region.REGIONID`),
  beyond by the dimensions' (`dim_calendar.date`, `dim_duid.DUID`, `dim_region.Region`)
  with `queries.wholeDays` (the range cut to the first day the daily table holds and the
  newest day both daily tables hold, read once `agg` is attached), and the same measure
  reads the 5-minute table or the daily one, as the model's `[Reads 5 minutes]` says. Where
  the two grains are different figures, each is its own measure and `grain()` names it:
  `[Generation MW]` at a time and `[Generation MWh]` a day, `[Negative price share]` of
  intervals and `[Negative price days share]`.
  The filters are conditions of a query's `where` (`queries.whereGen`, `queries.unitFilters`,
  `queries.wherePrice`, `queries.priceFilters`: on the fact's own `date` and on the unit's
  attributes). A fuel or unit pick reaches the regional tables because the model's
  relationship from `dim_duid` to `dim_region` filters both ways: the regions those units
  are in, in Power BI and in the compiler alike.
  **Rooftop solar is five units**: `ROOFTOP_<region>`, fuel "Rooftop solar", rows of
  `fct_summary` like any unit's, so every filter on the units reaches it and no query adds
  it on its own. It is in the unit picker, search and Analyze; not on the map (no position)
  and not in `[Units]`.
- `semantic_model/ossie.yaml` is the semantic model (see "The semantic model"), in
  [Apache Ossie](https://github.com/apache/ossie) (core-spec 0.2.0.dev0), edited by hand:
  datasets, fields, keys, relationships, and the measures as metrics in the DAX dialect.
  What Ossie has no place for is in `POWER_BI` custom extensions, as the TMSL properties (a
  JSON string): a relationship's `crossFilteringBehavior` (`dim_duid` → `dim_region`,
  `bothDirections`; apache/ossie#580 asks Ossie for a property) and
  `relyOnReferentialIntegrity`, a measure's `table` and `formatString`, the Direct Lake
  partitions, `compatibilityLevel` 1604. dax-sql's reader (`dax-sql/formats/ossie.js`)
  turns it into the TMSL it stands for, losslessly, and that TMSL is what Power BI runs:
  `scripts/ossie_to_bim.mjs` writes the `model.bim`, at deploy only (the repo holds none).
  It holds DAX only: nothing in it is written for DuckDB, and no SQL goes into it. The
  browser reads no YAML: staging writes it as `semantic/ossie.json`. Reading it needs
  `yaml` (`npm ci --prefix scripts`). `repo.test.mjs` checks it reads back as itself.
- `dashboard/github/views.js` (`withViews(data)`, which every `data.js`
  returns itself wrapped in) is the tables as views: a view `v_<table>` per table attached,
  over the files (the table whole in `dim` or `agg`, or split by date over `today` and the
  half-years: `today` has the days it holds, cut at a literal date; the files are stacked by
  column name, so one built before a column was added reads as NULL in it). It creates them
  after every attach: one query reads what is attached from the engine's catalog
  (`information_schema`), and one runs the statements that are new or changed. It adds
  `views`, `has` and `needs` to the data source: `needs(sql)` says what a SQL
  query reads; `ensureHistory` attaches nothing for a range that starts inside the days
  `today` holds, so the default view fetches no history.
- `dashboard/page/semantic/query.js` (`createModel(dataSource)`: the data source's
  members, `toDax`, `toSQL` and `analyze`): `toDax(query)` writes the DAX page's query as
  DAX, checking each column and measure against the model; a SELECT over the model (the SQL
  page's) dax-sql reads itself, into the same syntax tree; `toSQL(dax)` is `dax-sql`'s compile of it
  over the data source's `v_<table>` views (staged next to the compiler as `semantic/dax-sql/`
  by `stagePage`), the same text once (a Map). The page's options: `assumeIntegrity` (a
  dimension's key is read off the fact: the dbt tests keep the data so) and its casts for the
  browser (a date as VARCHAR, a whole number as INTEGER, a number as DOUBLE: a BIGINT reaches
  the page as a BigInt). How dax-sql writes its SQL (fused scans, a subquery read once,
  decorrelation across a relationship that filters both ways) is in its DESIGN.md.
  Checked, offline, on every push (`build.yml`): the compiler on this model
  (`scripts/parity/repo.test.mjs`: every measure in five filter contexts, every query of
  the page, and the SQL page's against the DAX page's, on made-up data; dax-sql's own tests
  run in its repo);
  `sql_page.mjs`, the SQL page against the DAX page on the deployed files (the deploy waits
  for it); `compiler_ab.mjs`, the compiler against the commit before, rows and time (a report,
  with the slower queries' SQL and plans as an artifact). Against the model: the parity
  (`deploy_model.yml`).
- `storage/data.js` is the host: how the `.duckdb` files are fetched, cached and attached
  (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `query`, wrapped by
  `views.js`). It attaches `dim`, `today`, `agg` and the 5-minute history. The files sit in
  `data/` (`mart_dim`, `mart_today`, `mart_agg`, `mart_<YYYY>_h<N>`), with
  `mart_manifest.json` listing the half-years; they are downloaded whole into OPFS, and the
  history is the half-year files (`p2026_h1`, ...), the ones a range needs. The other DuckDB
  host, the Fabric app on the Iceberg catalog, has a `data.js` of its own with the same
  members (`dashboard/fabric_app/iceberg/site/storage/data.js`, below).
  The history is never read in place over HTTP: duckdb-wasm reads a remote file one block
  at a time, three round trips each, and a remote host answers one in ~700 ms whatever its
  size. Both DuckDB hosts set the session to Brisbane time, on purpose: the tables carry
  `date` and `time`, no TIMESTAMPTZ, and the only thing the zone decides is that
  `CURRENT_DATE` is the NEM's day.
- `dashboard/github/history.js` is GitHub Pages' about the half-year history
  files: `periodsForRange` (which ones a date range needs) and `attachCached` (ATTACH from
  OPFS in place, into memory if a second tab holds the file).
- `dashboard/page/storage/queue.js` is how both DuckDB `data.js` send queries: one
  at a time (the worker runs one anyway), the hero's `early`, the KPI deltas `later`, and a
  query whose render a newer one replaced dropped unrun when its turn comes (`runQuery` in
  `index.html` says which render a query is for; Analyze's are never dropped).
- `dashboard/page/frontend/perflog.js` and `dashboard/page/frontend/logs.js`
  are the Logs tab, on both hosts: a table of what this session fetched, attached and ran,
  with timings, and the build stamp. This session only: it lives in the page's memory,
  nothing is stored, written to a file or uploaded, and the Copy button is the one way out.
  A host's `data.js` does the logging (`perf.log`, `perf.time`, and `perf.query` around
  every query, the compiler's included); the page has the tab and its panel, and `logs.js`
  fills it. A query's DAX, as the compiler wrote it, is shown with the SQL it became under
  it: `query(sql, dax)` in both `data.js`, the compiler passing the DAX. An event's `what`
  is always the SQL, which is what a change is checked against; the DAX is its `dax`.

Three things in that design are there for speed and must survive an edit:
- A query that needs nothing about the unit (previous-period generation with no filter, the
  Flows generators, the cutoff) reads the plain fact view, not the relationship's: no join
  to pay for. The compiler does this, from the tables the query names: so a query that needs
  nothing of the unit must not name a column of `dim_duid` other than its key, and a unit
  pick is a filter on the fact's own `DUID`.
- The price is on `fct_summary`'s row: capture price and the battery chart join nothing.
- A share of what is shown (`[Generation share]`) over a sum is a window, not a second scan
  (a subquery for the shares is slower than the shares and the stack's totals together).

How the page looks is decided in five places of `index.html`, and a chart goes through them
rather than round them:
- The chrome is monochrome: surfaces, ink and hairlines are CSS tokens on `:root` (light under
  `[data-theme="light"]`, set by the `<head>` script before first paint: the stored choice,
  else the system's). Colour is for the data and for status, and status comes with an arrow
  or a label. The CSS stays inline: a separate file next to `index.html` would need both
  deploy copy lists (`build.yml`, `dashboard/fabric_app/common/build.mjs`).
- `chartTheme()` builds one ECharts theme per scheme from those tokens (font, label size,
  tooltip, legend, zoom slider, colour scale) and `plot()` is every chart's plot area, with
  measured axis labels. A chart sets no margin, font or tooltip style of its own.
- A colour of the data is a pair, `[dark, light]`: `FUEL_COLORS`, `REGION_COLORS`, `PALETTES`.
  The eight fuels that carry the stack were checked pair by pair for colour-blind and normal
  vision; black coal (a neutral) and rooftop solar (a lighter solar) are off the checker's
  bands on purpose. A region keeps its colour on every chart.
- The Dashboard tab leads with "Right now" (`renderNow`): the newest interval from
  `fct_summary` and `fct_region`, its renewable share the model's measure, following the
  region filter only. With the pointer on the generation or the price chart (the fuel
  view only) it shows that interval instead (`scrubHero`), from what those charts and the
  Renewables KPI already read: no query of its own.
- **One screen per tab on a desktop**, no scrolling page. At 1100 px
  wide and 600 tall or more the page does not scroll: each tab is a flex/grid that fills the
  window under the header, and a chart takes its cell's height (`--h` is its height only where
  the page scrolls, below that size). A chart of the Dashboard and Insights is never under
  150 px (`--chart-min`): a window too short for that under the header, the hero and the
  KPIs scrolls by the difference (from about 1280x720 up nothing scrolls). Under 960 tall a
  compact layout applies (the hero one band, the Dashboard's three charts side by side).
  Charts follow their boxes through a `ResizeObserver`. Insights is three sub-pages of four
  charts (`INSIGHTS_PAGES`) and only the one shown is drawn; the Flows board holds each
  link's small chart in its row; the History calendar lays its years out to fill the card; a
  tab's notes are an (i) popover. A new chart goes into a cell of that grid, not under it.

**Checking a change to `ossie.yaml`, `dax-sql`, `query.js`, a `data.js` or the page:** in headless
Chrome, the page before against the page after on one copy of the deployed files, through
the same page states; compare what each chart draws (its ECharts series) and the SQL that
ran (the Logs tab has it, translated), read `EXPLAIN` for a join that was not there, and
time old against new alternately in the same page (two separate sessions differ by more than
the change does). Speed is tracked every time: the total, and any query clearly slower. A
difference of some 10 ms on one query is not worth chasing: on a second run as many go the
other way.

## Dashboard deploy
`build.yml` (the pages, staged by `scripts/stage_pages.mjs`: the DAX page at the root with its
`frontend/`, `semantic/` and `storage/` folders, the SQL page at `sql/` with its own, the dbt
docs) and
`import_data.yml` (the .duckdb files; with `with_page`, the same staging)
publish into `NemTracker/nemtracker.github.io` with `scripts/deploy_pages.sh`: a blobless
depth-1 clone, the published paths added with `-f` (so the deploy repo's `.gitignore` can't
skip a file), push retried on a race. It only adds and replaces: a file leaves the site by
hand, in the deploy repo.
**Every build stamps its files** (`scripts/stamp_build.mjs`, run by `build.yml` and by
`dashboard/fabric_app/common/build.mjs`): `__BUILD__` becomes the build, and every relative
import gets `?v=<build>`. Pages serves the files with `max-age=600`, so without it a browser
would run the new page with its cached old modules for up to 10 minutes after a deploy. A
harness that imports a module itself from a stamped copy has to add the same `?v=`, or it
gets a second instance of it.
**The files are a copy of the `mart` tables, with no rule of their own**
(`scripts/cache_catalog.py`: `SELECT *` per table, into `mart_dim`, `mart_agg`, `mart_today`
and `mart_<YYYY>_h<N>`). Every run copies the newest 14 days; the daily run also copies the
dimensions, the aggregates whole, and the latest two half-years: older half-year files stay
as deployed. Dispatch `import_data.yml` with `all_periods=true` after a backfill that
touched older data. The manifest of half-year files is built last, from the files actually
in the deploy repo; an empty listing fails the step instead of publishing an empty manifest.
`squash_deploy_repo.yml` (weekly, Sunday 17:00 UTC, also dispatchable) replaces the deploy
repo's history with one commit of its current tree (`scripts/squash_deploy_repo.sh`,
force-with-lease): `mart_today.duckdb` is redeployed every hour, and the kept copies would
otherwise grow the repo by gigabytes a week. The site is unchanged; GitHub reclaims the
space on its own schedule.
A half-year must stay under 100 MB (GitHub's limit for a file; the build fails over it) and
the whole site near 1 GB (GitHub Pages' limit): the copy is about 880 MB. That is why
`fct_summary` is written by date, time, price, DUID: its price is the region's, so in that
order the column is runs and costs nothing; in key order the files are 60% larger.

**The Fabric app on the Iceberg catalog is `dashboard/fabric_app/iceberg/`**, a Rayfin
project: static hosting, Fabric sign-in, and one function, `openCatalog`
(`rayfin/functions`). Its inputs are the semantic model and a OneLake Iceberg catalog, nothing
else: no import, no file written for it.
- The model names the tables: an Ossie dataset's `source`, or a TMSL table's Direct Lake
  partition (`schema.table`).
- The catalog is the app setting `CATALOG_URL`,
  `https://onelake.table.fabric.microsoft.com/iceberg/<workspace id>/<lakehouse id>`. Rayfin
  keeps an app's settings as "secrets" (`rayfin secret set`): it holds no credential.
- On every page load, `openCatalog` asks the catalog, server side with the item owner's
  storage token, where each of the model's tables is now (`loadTable`, all at once:
  `metadata-location`). It then signs a read-only user-delegation SAS on the lakehouse's
  `Tables/` (`sp=r`, about 55 minutes). It returns those two and nothing else.
- `site/storage/data.js` gives each table a view `v_<table>`, which the compiler reads as on
  the other hosts. DuckDB-WASM reads the metadata, manifests and data files from OneLake with
  the `iceberg` extension and the community extension `azure_wasm`. That one turns
  `abfss://` into `https://…?<SAS>`, because the official `azure` extension has no WASM
  build; it is loaded before the first scan, or DuckDB tries to autoload `azure`.
- **The engine is DuckDB 2.0, served by the app itself** (`duckdb.mjs`, run by
  `rayfin.yml`'s `buildCommand` before `build.mjs`, into `vendor/duckdb/`, not in git; it
  needs `gh` signed in). duckdb-wasm has no 2.0 release on npm, so the engine is its CI
  build of main (pinned run, single-threaded loadable package), and the extensions are
  DuckDB's bucket's `v2.0.0/wasm_eh` ones plus `azure_wasm` from its own CI (its 2.0 port,
  duckdb/community-extensions#3393 pending). That build calls itself `d54cbbe3df` (the v2.0.0
  commit), so each extension's footer is relabelled, which voids its signature: `data.js`
  opens DuckDB with unsigned extensions allowed and installs them from the app's own `ext/`
  repository. The CI artifacts expire after 90 days: a new pin then, and back to npm and the
  signed extensions once duckdb-wasm 2.0 ships. The `.wasm` is 33.7 MB, served uncompressed
  (Rayfin's hosting compresses nothing); it loads while the function is called. The
  extensions (~11 MB) sit in `ext-<hash of the pins>/` (named in `pins.json`), so a file there
  never changes: the worker keeps them in OPFS (`blockcache.js`) and answers DuckDB from there
  after a browser's first load (1-11 ms each instead of 1.5-2.8 s; Rayfin's hosting
  revalidates every file, `max-age=0`). On that first load the page fetches them all at once
  at the start (`warmExtensions`), as DuckDB downloads them one at a time (13 s live), and
  remembers in `localStorage` the folder it has loaded.
- **2.0 sends every ranged read with `If-Match`**, even with `unsafe_disable_etag_checks`,
  and the browser's cache answers no request that carries it: every table's
  `metadata.json` went back to OneLake (~0.9 s each). The worker drops the header
  (`blockcache.js`); an Iceberg file is never rewritten in place. The engine also URL-encodes
  it, which OneLake answers with 412 (duckdb/duckdb-wasm#2297).
- **The worker keeps what DuckDB reads of an Iceberg table's files in OPFS, by block**
  (`site/storage/blockcache.js`, a classic script loaded into DuckDB's worker before the
  engine): what `cache_httpfs` does for `httpfs`, which has no WASM build. Each ranged read
  is cut into 256 KB blocks, kept under the file's path without the SAS (so a new SAS keeps
  them), and a miss is one request sized for what follows (a request costs ~0.5 s whatever
  its size): a file of 4 MB or less whole, a read of 1 MB or more with 16 MB of read-ahead
  (DuckDB scans a file in ~2 MB reads, one after the other), a read in a file's last 1 MB the
  whole tail (the footer's three reads in one), else its own blocks. A HEAD of a known file is
  answered without a request: the page sends the worker the sizes of a table's files as it
  opens it (`BroadcastChannel('blockcache')`). Only what queries read is kept, plus that.
  Every file of an Iceberg table is immutable (a commit writes a new `metadata.json`, a new
  manifest list and new manifests, and touches no old one), so the store keeps `.parquet`,
  `.avro` and `.metadata.json` alike: planning a table reads its old manifests from OPFS.
  `blockcache/blocks.bin` and `index.jsonl` in OPFS; over 2 GB the store starts over. One tab
  writes it; another opens it read-only (Chrome 121+): it answers from what the writer kept,
  re-reads the index on a miss, and keeps nothing itself. On `power`'s full data, a returning
  visit (new SAS):
  Parquet reads 0.15 s in all instead of 85 s, charts drawn in 25 s instead of 138 s. The
  first visit still pays for the scans of a big table's whole history: `MAX(fct_summary[date])`
  reads the `date` column of all 27 files of the 1.3 GB table, one request at a time (66 s of
  a cold 120 s with the footers; the footers are now fetched ahead, below), and `fct_region`'s
  `REGIONID` list 11 s. `httpfs`'s `force_download` does not reach duckdb-wasm's file system.
- **The client has a catalog of its own: a snapshot record per table**
  (`site/storage/snapshots.js`, `localStorage`), keyed by the metadata location the function
  gave: the snapshot's live data files (with their sizes once learnt), whether it has delete
  files, and the manifests read. A table is planned once (`PLAN`: `iceberg_metadata()`, one
  request per manifest) and its view is `read_parquet` over the record's files, written as
  literals (`iceberg_scan`, which plans again at every query, only with delete files). The
  same location again is the same snapshot: the table opens from its record, no
  `metadata.json` fetched, no prefetch, nothing read from OneLake. A new location is planned
  again, and the page prefetches only what is new: the manifests the last record lacks, and a
  large table's new Parquet footers (`prefetchFooters`, the block-aligned tail of each new
  file, six at a time, before the view binds; all its files on a first visit). A record
  that fails to open is dropped and the table planned again, once. The record holds paths
  only, never a SAS.
- **Threads are not possible yet**: every `wasm_threads` extension published (DuckDB's
  bucket, `azure_wasm`'s CI) imports unshared memory, which the threaded engine refuses
  (`LinkError … mismatch in shared state of memory`), and the page would need cross-origin
  isolation, which breaks Fabric's sign-in popup ("Page not accessible directly").
- **A table is opened when a query first names its view**, so the first paint pays only for
  the tables it reads. The rest are opened after the first paint, in the background, at the
  back of the queue (`attachAgg`, not awaited).
- **A small table is copied into memory.** Its size is the current snapshot's
  `total-files-size`, read from its `metadata.json`. Up to `SMALL_BYTES` (32 MB), the table
  is copied into DuckDB's memory once and its view reads that. Above it, the view is over
  `iceberg_scan`, read in place. `has()` and `views()` answer from the model's columns,
  with no table opened.
- **The browser's HTTP cache is the prefetch** (`prefetch.js`), for a new snapshot:
  - DuckDB-WASM reads one request at a time, and OneLake answers each in about 0.6 s.
  - At start the page fetches each changed table's `metadata.json`, manifest list and new
    manifests, six at a time (OneLake is HTTP/1.1). For a small table it also fetches the
    data files those name, after every table's metadata. The manifests are Avro, deflate
    blocks, read with `DecompressionStream`.
  - DuckDB's HEAD and Range requests then come from the cache: OneLake sends
    `Last-Modified` and no `Cache-Control`.
  - Fetching data files only when their table opened was slower, because tables open one
    at a time.
  - Served table by table: the table a query is about to open first (`prioritize`, from
    `open`), then the others smallest first; within a table, manifests before data files.
    First come, first served across tables, the first query on `power` waited 35 s for
    `dim_region`'s three files behind the large tables' hundreds of manifests (one per
    hourly commit); now it runs at 7 s. A manifest also names files later removed (404),
    which are skipped.
- **DuckDB's own caches are on** (`enable_http_metadata_cache`, `parquet_metadata_cache`):
  Iceberg files never change once written.
- **Timings, cold, conformance-oracle's small `nem`, function call excluded:** charts drawn
  in 14 to 15 s on 2.0 (loading the extensions 0.7 s, opening the 15 tables 1.6 s), 15 to
  17 s on 1.5.6 (3.2 s and 5.4 s). It was 48 s with lazy opening alone, and 70 to 79 s when
  every view was created up front.
- **The function's answer is kept for about 55 minutes** (`catalog.js`), in that viewer's
  `localStorage`. A reload within it calls no function, starts without a session, reads the
  same snapshots, and gets cache hits (same URLs). A tab open longer gets a new SAS before
  the old one expires; its views stay on their snapshots. A new SAS changes every URL, so
  the browser cache starts over; the OPFS store and the snapshot records do not.
- What is stored between visits: the block store (OPFS), the snapshot records and the
  function's answer (`localStorage`). Nothing that can write, and no token.
`dashboard/fabric_app/common/build.mjs` assembles a project's `dist/`: the DAX page staged
(`stagePage('dax')`: `page/`, `dax/` and the model, `semantic_model/ossie.yaml` as
`ossie.json`; it needs `npm ci --prefix scripts` first) and the dbt docs, with
`fabric_app/common/site/` (`storage/auth.js`) and then the project's own `site/` copied over
them (here `storage/` `data.js`, `catalog.js`, `snapshots.js`, `prefetch.js`,
`blockcache.js`), and `?v=<build>` added to every
relative import; `query.js` passes its own on to `ossie.json`. The project is the working
directory of `build.mjs` (`rayfin.yml`'s `buildCommand`, `node ../common/build.mjs`).

**It is deployed from the owner's laptop**, under their own login, into two workspaces, each
its own item `iceberg` reading that workspace's lakehouse `nem`: fabriccat's
`conformance-oracle` (East US, little data) and `power` (the owner's tenant, Australia
Southeast, the full data; since 2026-10-27). `.deployments.json` keeps both, `active` the last
deployed: `--workspace-id` picks the other.
```
cd dashboard/fabric_app && npm ci && npm ci --prefix ../../scripts
cd iceberg && npm ci --prefix rayfin/functions
export RAYFIN_TOKEN=$(az account get-access-token --tenant <fabriccat> --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
npx rayfin up --yes --output json
```
`dashboard/fabric_app/iceberg/rayfin/.deployments.json` (untracked) records the item, and
its URL is in `rayfin/rayfin.yml` (`allowedRedirectUris`; the deploy adds it). On a machine
without that record, add `--workspace-id <workspace>`. A new item needs its catalog once,
then the function deployed again (`npx rayfin up functions deploy`):
`echo -n <catalog url> | npx rayfin secret set CATALOG_URL --stdin`.

**Rayfin lets only the owner of an app item deploy to it**, and the owner is whoever created
it; the owner is also the identity `openCatalog` reads the catalog and signs the SAS as. That
is why the laptop and CI cannot share an item: a deploy to someone else's fails with
`403 Only AppBackend artifact owner can perform this operation`.

**The iceberg app from CI deploys but does not work yet** (`deploy_fabric.yml`'s
`fabric_app_iceberg`): Fabric answers 500 ("An internal error occurred.") to every function
call on an item owned by a service principal, before the function runs (microsoft/rayfin#89,
open, with this repo's case in its comments). The CI deploy needs:
- `dashboard/fabric_app/iceberg/rayfin/functions/host.json` is committed: the deploy refuses
  without it, and the Rayfin scaffold's `.gitignore` leaves it out.
- The lock files resolve from `registry.npmjs.org`: generated on a laptop they name a
  private feed the runner cannot read.

Rules of the Fabric host that are easy to break:
- **The browser never receives a token, and nothing that can write.** The only credential
  it gets is the SAS from `openCatalog`: read-only, one folder, about 55 minutes. The
  catalog's own vended credentials (`X-Iceberg-Access-Delegation: vended-credentials`) are
  not used: OneLake vends them read-write-delete (`sp=racwdl`), and on 2026-10-27 they
  answered 401 to reads.
- The workspace setting "Authenticate with OneLake user-delegated SAS tokens" must be on
  (off, OneLake answers 401 to the SAS), and the item's owner must be able to read the
  lakehouse.
- Single-threaded here for one more reason than on Pages: cross-origin isolation breaks the
  Fabric sign-in popup.
To check a deploy, open the Logs tab: the build stamp, the function call, each view and
query, and the worker's requests.

### The whole stack in one workspace
`deploy_fabric.yml` (dispatch: `tenant_id`, `workspace_id`, empty for the fabriccat test
workspace, `TEST_WS_ID`; and a tick per part, all on by
default: `data`, `semantic_model`, `ossie`, `fabric_app_vertipaq`,
`fabric_app_iceberg`; and `schedule`, off by default) installs the project into one
Fabric workspace, independent of everything GitHub runs: the mechanism of the sibling
`fabric-medallion-dbt` (`.github/scripts/deploy.py`), ported. `scripts/deploy_fabric.py`:
- publishes `fabric_items/` with fabric-cicd: the lakehouse `nem` (schema-enabled), the
  Python notebook `run` and the pipeline `run_pipeline` that calls it;
- uploads the dbt project (`git archive HEAD`) to `nem/Files/project`, with a `COMMIT` file;
- runs the pipeline once and waits: the model names tables a first run creates;
- publishes the model with `deploy_model.main()`, on that lakehouse;
- copies HEAD's `semantic_model/ossie.yaml` to `nem/Files/semantic_model/ossie.yaml`, its
  `{WS_ID}`/`{LH_ID}` replaced by the workspace's and lakehouse's ids (its own tick, `ossie`:
  a file copy, no Power BI);
- with `schedule`, runs the pipeline hourly; without it, turns its schedules off (the test
  workspace, `conformance-oracle` in fabriccat, must not spend CU every hour). A run with
  no part ticked only sets the schedule.
- the notebook takes 10 files per feed per run (`download_limit`, `process_limit`), and
  writes its log to `nem/Files/logs/run.log` too, whose end the deploy prints when the
  pipeline fails (the notebook's output stays in Fabric). nemweb answers 403 to most
  downloads from Fabric (2026-10-14), so such a lakehouse holds little data; a fact with no
  file is created empty, and the MMSDM dimensions build without their files.
Then the workflow deploys `dashboard/fabric_app/vertipaq/` (item `vertipaq`), its connector
naming the model `nem` of the same workspace, and `dashboard/fabric_app/iceberg/` (item
`iceberg`, CI's own: the laptop's refuses another owner), its `CATALOG_URL` the same
workspace's lakehouse `nem`, which fails until microsoft/rayfin#89 is fixed. The workspace must exist, on a capacity in a
region with Fabric apps (preview); the login is the repo's Entra app of that tenant
(`AZURE_*` or `LAKE_*`), any other tenant fails at the first step.
The notebook does what `process_data.yml` does: the same env contract (from `notebookutils`:
the workspace, the lakehouse's id, a storage token), `pip install -r requirements.txt`, and
the same two `dbt run --target prod`. No `rebuild`, maintenance, tests or `.duckdb` import
there: those stay on GitHub, for the `power` catalog.

**The Fabric app on the `.duckdb` files is `dashboard/fabric_app/duckdb/`** (item `duckdb` in
`power`, since 2026-10-27): the GitHub page's data source (`dashboard/github/data.js`, staged
as `storage/github.js` by `node ../common/build.mjs github`) reading the same files from the
lakehouse's `Files/duckdb/` instead of the site's `data/` (its `init` takes `url(file)`).
`import_data.yml`'s last step uploads each run's files there and then writes the folder's
`mart_manifest.json` from what it holds (`scripts/upload_onelake.py`: a temporary name, then a
rename over the old file; allowed to fail, the GitHub page never waits on it). The function
`openFiles` signs a read-only SAS on that folder (setting `FILES_URL`,
`https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>/Files/duckdb`), kept per browser until
shortly before it expires (`site/storage/files.js`). Deployed like the iceberg app, from the
owner's laptop.

**The VertiPaq app** is the page with the deployed semantic model as its engine (Power BI in
Direct Lake over the `mart` tables, no DuckDB, no copy of the data). Its
`site/storage/data.js` sets `engine: 'dax'`, and the compiler's `createModel` then sends each
query's DAX (`toDax`) to it as it is, with no views and no SQL; with no `needs`, the page
leaves out Analyze. The route to the model is a Rayfin connector of type
`fabric-semanticmodel` (`executeQuery`, delegated): the app's backend runs the query on the
model as the signed-in user, so the browser holds no Power BI token. Not deployed in
`power` yet: Fabric answered `403 The feature is not available` there (microsoft/rayfin#8)
until the tenant's admin setting for Fabric apps was turned on (2026-10-27).

A table or a column the page asks for and a deployed file lacks reads as "no data" where
the page checks (`data.has`), so a new page can go out before its data; a new table goes
into `cache_catalog.py`'s lists once it is a dbt model and a table of the model.
What the charts read beyond 30 days: `fct_summary_daily` and `fct_region_daily` (whole
days: a day is written once the next-day files hold it, so a long range ends on the newest
whole day), `fct_summary_hourly`, `fct_region_hourly` and `dim_month` (hour of day by whole
month, for the daily profile and the price heatmap), and the curtailment tables:
`fct_curtailment_region` (per region, day and fuel: the semi-scheduled farms to their
newest day, AEMO's regional figures from `fct_region` after it, drawn lighter) and, when
units are picked, `fct_curtailment` (per semi-scheduled unit and day, the farms alone).
Only units on the current registration list have a classification, so semi-scheduled farms
that have left the list are not counted.

## The semantic model, for Power BI and for the dashboard
The core of the project is the Iceberg catalog and a semantic model. Its clients are the two
DuckDB-WASM hosts above and Power BI in Direct Lake. The dashboard reads the `mart` tables
through this model, and `scripts/cache_catalog.py` is the import, a plain copy. The raw facts
in `landing` are what these tables are built from.
- **The tables** are dbt models in schema `mart`, tagged `powerbi`: `fct_summary`,
  `fct_region`, `fct_interconnector`, `fct_curtailment`, `fct_curtailment_region`,
  `dim_region`, `dim_time`, the aggregates `fct_summary_daily`, `fct_region_daily`,
  `fct_summary_hourly`, `fct_region_hourly` and `dim_month`, and `dim_duid`, `dim_calendar`,
  `dim_interconnector`. The raw facts cannot be read by Direct Lake as they are (both
  dispatch runs, an interval under two `file`s, regional data split over three tables, no
  curtailment table at all), and Direct Lake has no view to fix that in, so every rule is
  in a model. `process_data.yml` builds them in a second step, after the landing facts they
  are built from, **and it stays in that workflow**: the dashboard's files are a copy of
  these tables, so the import has to find them built. A failure of that step fails the
  job: Import Data only runs after a green Process Data, so the dashboard keeps the files
  it has and the red run says why. Dispatched with `debug`, both steps print every
  statement with its timing.
- **The import is a copy**: no logic beyond splitting per size. So every table the dashboard
  reads is a dbt model here and a table of the semantic model, its aggregates included: per
  day (`fct_summary_daily`, `fct_region_daily`) and per month and hour of day
  (`fct_summary_hourly`, `fct_region_hourly`, with `dim_month` for the days of a month). An
  aggregate row is written once, when its day or month is whole.
- **Their shape:** MW and price sit on one row at 5 minutes (`fct_summary`), because joining
  two facts at query time is too slow; rooftop's source is its own table, kept as published;
  a value that is held, carried forward or interpolated is never stored in a source table
  (a derived reporting table may hold it); the logic is measures.
- `semantic_model/` holds the model, `ossie.yaml`, and nothing else. The Fabric item is the
  deploy's business: `deploy_model.py` writes it into a temporary `semantic_model/`: `model.bim` (`ossie_to_bim.mjs`), `definition.pbism`,
  and `.platform`, named after the YAML's `name` (`nem`, what `check_model.py`,
  `parity_model.py` and the workflows look the model up by) with a fixed logicalId. The model
  Power BI runs: each table one Direct Lake
  partition on a `mart` table of the `nem` lakehouse, reached through OneLake (no SQL
  endpoint; Fabric shows Direct Lake the Iceberg tables as Delta on its own), single-column
  relationships, and the measures. `{WS_ID}`/`{LH_ID}` in the `DirectLake` expression are
  placeholders. A measure cannot have the name of a column of its table, in any case
  (`Price` on `fct_region` is refused). Rooftop solar is five units of `fct_summary`:
  `fct_rooftop`, its source, is a dbt model and not a table of the model, and no measure
  adds rooftop to the units. `[Units]` leaves those five out; `[Capacity MW]` and
  `[Capacity factor]` do too, as they have no registered capacity.
- **A quantity is one measure, and the measure picks the table.** Direct Lake has no
  aggregation tables (user-defined aggregations are not supported), so the switch is DAX:
  `[Generation MWh]`, `[Charging MWh]`, `[Revenue]`, `[Capture price]`, `[Units]` and
  `[Capacity factor]` read `fct_summary_daily` when no time of day is asked for, plus
  `fct_summary` for the days after the newest one the daily table holds, and
  `fct_summary` alone when one is; `[Average price]`, `[Demand MWh]`, `[Net interchange MW]`
  and `[Hours]` do the same over `fct_region_daily` (a day there is 288 intervals).
  The newest day is a hidden measure per daily table (`[Newest whole day]`,
  `[Newest whole day regional]`, `CALCULATE(MAX(date), REMOVEFILTERS())`), and the days
  after it a `KEEPFILTERS(dim_calendar[date] > _last)`: the daily tables are written in date
  order with no gaps. (A set of those days, `EXCEPT` of the calendar's dates and the daily
  table's, goes over the capacity's 1 GB per query over a year grouped by unit.)
  "A time of day is asked for" is written once per fact, in a hidden measure
  (`[Reads 5 minutes]`, `[Reads 5 minutes regional]`): any column of `dim_time` filtered or
  grouped, or a column of the fact itself filtered. So filters go through the dimensions.
  **The switch is not there for VertiPaq alone: it is what lets the browser call the same
  measure over a long range**, where it cannot hold the 5-minute rows; keep it on every
  quantity, the regional ones included. `check_model.py` times it at every deploy (the
  whole history by year and fuel from each table: the daily table about four times faster,
  the same total).
  For the number to be the same from either table, the daily table stores the day's sums of
  what the 5-minute measure sums: `output_mwh`, `charging_mwh`, `revenue`. Its `mwh` (net)
  and `price` (the day's average) are not the same numbers (a battery's day nets out, a day
  is priced at its average) and no measure reads them; Analyze's SQL lists them. The
  hour-of-day tables are not switched to: `[Output MWh hourly]`, `[Average MW at hour]` and
  `[Price at hour]` name them, as `[Negative price days share]`, `[Lowest daily price]` and
  `[Average MWh a day]` name the daily tables: a share of days is not a share of intervals.
  **An average MW is energy over `[Hours]`**: `[Average generation MW]`,
  `[Average demand MW]`. The hours are the regions' (the intervals the price data holds),
  nights included, so rooftop's average over 3 days is its energy over 72 hours, not over
  its daylight intervals. `[Capacity MW]` is the registered capacity of the units with
  output, which `[Capacity factor]` divides by.
- **Writing DAX for this model:**
  - Give variables a leading underscore (`_last`): some short names (`d`, `m`, `r`,
    `step`, `before`, `after`) fail to parse (`SYNTAXERROR`).
  - Dividing a fixed-decimal column gives a fixed decimal, 4 places (`SUMX(...) / 12` on
    `mw`): wrap it in `CONVERT(..., DOUBLE)`.
  - A filter set inside `CALCULATE` on one column of a dimension does not remove the
    query's filter on another column of it: remove the dimension's filters first.
  - Fabric takes several minutes to show a recreated Iceberg table to Direct Lake: a
    refresh right after a `rebuild=` answers `DirectLake_TableNotFound`; wait and retry.
- `deploy_model.yml` (dispatch only) publishes the model into a workspace,
  by default the test one (`tenant_id`/`workspace_id` empty: fabriccat's
  `conformance-oracle`, repository variable `TEST_WS_ID`; tests never spend `power`'s
  capacity), on that workspace's lakehouse `nem`, with `scripts/deploy_model.py`
  (fabric-cicd, not duckrun) and runs
  `scripts/check_model.py`: a refresh, then a row count per table and each measure per day
  for the newest week (the measures of the tables by month per month: a date does not
  filter those tables); with
  `parity=true`, the parity checks above. A table or a column the model names has to exist
  before a deploy: the refresh fails on it and leaves the deployed model broken until the
  next good one. And a dispatched `process_data.yml` can be cancelled by the next scheduled
  run queueing behind it (one concurrency group), so read its conclusion and its Power BI
  step before deploying on the strength of it.
- **The check asks its DAX over XMLA** (ADOMD.NET under pythonnet), not the REST
  `executeQueries` call: that one answers 401 `PowerBINotAuthorizedException` to a service
  principal on this model, as Contributor and as Admin. Its reference page says service
  principals are not supported on a model with single sign-on. The same token is accepted
  over XMLA.

## Models (24)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) — only rows missing from the target; the durable log is `Files/csv_archive_log.parquet` |
| processed_files | landing | incremental append — the files each landing fact has loaded (`model, csv_filename, processed_at`), appended by the facts' post-hooks; the pending check is the log minus this table. A `rebuild=<fact>` appends a reset row (`csv_filename` NULL); the first build seeds it from the facts' `file` columns |
| dim_calendar | mart | incremental append (the NOT-IN filter keeps existing dates out; runs 2 years ahead; a run sends nothing once it reaches that far) |
| dim_duid | mart | incremental merge on DUID that inserts new units and updates a unit whose row differs (nothing deleted; skipped when nothing differs); NEM units from the registration list, then `duid_unregistered.csv`; registered capacity (RegCapMW etc.); `Renewable` — **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind"; `CO2eFactor` (t CO2-e/MWh) from MMSDM `GENUNITS` through `DUALLOC`, for registered and unregistered units alike, NULL for loads, AEMO's dummy units and the gensets "On Exclusion List" (Colongra, Jeeralang, Braemar 3 and 6), which `[Emissions t]` therefore leaves out; `Storage` (a battery, the fuel "Grid": the one place that rule lives), `Plant` (the station, or the unit when it has none: what the page groups units by) and `Owner` (the participant, rooftop's five units "Rooftop solar (AEMO estimate)"); one spelling per name, case-insensitively, for StationName, Participant and TechnologyType (VertiPaq stores text case-insensitively). A changed rule or file reaches the existing rows on the next run; a new column still goes out with a `rebuild=dim_duid` (see below) |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so `fct_interconnector` takes one row per interval (`MAX … GROUP BY`); the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/availability/cleared MW. History's demand/net interchange come from fct_price's DREGION rows |
| fct_summary | mart | incremental insert-only merge on (date, time, DUID) — the Power BI fact: `fct_scada` joined to `dim_duid` and `fct_price` (inner joins), then the intraday feed after the newest daily interval, for the units the daily files know (`dispatch_duids`), and rooftop solar as five units, `ROOFTOP_<region>`: `fct_rooftop` on the straight line between two half hours, with `fct_region`'s price. An interval is written once both sources have it (every branch stops at the newest half hour all five regions' rooftop has), so the units run 30-60 minutes late. `backfill_rooftop` (a dispatch input of `process_data.yml`) adds rooftop's history. Every run recomputes the newest daily date minus six days on; missing keys are added, a stored value is never revised. The dates come from the Iceberg manifests and are written as literals (no scan to find them); a refill takes `process_limit` dates below the oldest it holds, newest first. `rebuild=fct_summary` resets it |
| fct_region | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: price, demand, net interchange and the regional semi-scheduled wind and solar. The intraday record where `fct_price_today` and `fct_regionsum_today` both have the interval, else `fct_price`'s. Every run recomputes from six days before `fct_price`'s newest date on (from the manifests, a literal on all three sources); the merge adds what is missing. A first build reads them whole |
| fct_rooftop | mart | incremental insert-only merge on (REGIONID, date, time) — the source `fct_summary`'s rooftop units are built from (not a table of the semantic model): the `MEASUREMENT` estimate per region and half hour as published (zeros kept, blanks out), with the half hour's average price from `fct_region`; written once its six prices exist |
| fct_interconnector | mart | incremental insert-only merge on (interconnector, date, time) — for Power BI: `MWFLOW` and the two limits, the pricing run, one row per interval |
| fct_curtailment_region | mart | incremental merge on (REGIONID, date, fuel), the one mart table whose rows are revised — for Power BI and the curtailment chart: curtailed and available MWh per region, day and fuel (Wind, Solar), `source` `farms` (`fct_curtailment` added up by the unit's region and fuel) or `aemo` (`fct_region`'s regional semi-scheduled figures, the days after the farms' newest). Each run one MERGE, one commit: updates a row whose figures or source changed (an `aemo` day filling, or becoming `farms`), inserts the new ones, deletes the `aemo` rows the run no longer gives |
| fct_curtailment | mart | incremental insert-only merge on (DUID, date) — for Power BI: curtailed and available MWh per semi-scheduled unit and day. A day is written once `fct_scada` holds its 288 intervals: the days after the newest one here, and in a refill `process_limit` days below the oldest, newest first (`macros/whole_days.sql`) |
| dim_region | mart | incremental insert-only merge on Region — for Power BI: the regions of `dim_duid`, the one filter that reaches the units and the regional data |
| dim_interconnector | mart | incremental insert-only merge on interconnector — the links between regions of `dim_region` (from MMSDM `INTERCONNECTOR`): `from_region`/`to_region` (a positive `mw` flows from the first to the second) and AEMO's `description`. The Flows page names a link by its id on the map and by the description on its board; only the bend of each arc is typed there (`LINK_CURVES`) |
| dim_time | mart | incremental insert-only merge on time — the 288 5-minute times of a day (`time` HHMM, `minute`, `hour`): the time axis of the 5-minute facts, and what the measures look at to choose a table |
| fct_region_daily | mart | incremental insert-only merge on (REGIONID, date) — the plain average of a day's 288 intervals of `fct_region` (price, demand, net interchange); a day is written once it has all 288 |
| fct_summary_daily | mart | incremental insert-only merge on (DUID, date) — `fct_summary` per unit and day, written once `fct_scada` holds the day whole (`macros/whole_days.sql`: the days after the newest one here; in a refill `process_limit` days below the oldest, newest first, never below `fct_summary`'s oldest): `output_mwh`, `charging_mwh`, `revenue` (the sums the measures switch to) and `mwh` net with the region's daily `price` (no measure reads those two; Analyze lists them). Inner join to `fct_region_daily` |
| dim_month | mart | incremental insert-only merge on month — the whole months of `fct_summary_daily` with their number of days |
| fct_summary_hourly | mart | incremental insert-only merge on (DUID, month, hour) — output energy per unit, whole month and hour of day (`time // 100`), 12 months per run |
| fct_region_hourly | mart | incremental insert-only merge on (REGIONID, month, hour) — average price per region, whole month and hour of day, with the number of intervals averaged |
| fct_rooftop_pv | landing | incremental insert-only merge (by file) — rooftop solar per region and half hour, AEMO's `ROOFTOP_PV_ACTUAL` estimate **kept as published**: the current folder, the monthly MMSDM archive 2018-01 → 2026-08 and the weekly archives after it. The monthly files from 2024-08 swap `QI` and `LASTCHANGED`; the model reads each file's `I` row to tell |

**Rooftop solar's source is a table of its own, `fct_rooftop`, never units.** AEMO's
`MEASUREMENT` estimate per region and half hour, as published (it starts 2018-03-06); a
blank (`QI = 0`) is missing, not zero. Nothing held, carried forward or interpolated is
stored in it. The derived table is where rooftop meets the units: `fct_summary` holds it as
five units, `ROOFTOP_<region>` in `dim_duid`, the straight line between two consecutive half
hours (nothing across a missing one, nothing carried forward), and writes an interval once
both sources have it. On the generation chart the dashed Demand line is operational demand
**plus** the rooftop in the stack. AEMO's data model 5.6 report says `ROOFTOP_PV_ACTUAL`
will be removed in a later release in favour of `ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute),
neither published yet: when the current folder stops updating, that is the replacement to
move to.

`dim_duid`'s merge updates a unit whose attributes changed (region/fuel/geo) in place.
**Rebuilding a table = dispatch `process_data.yml` with `rebuild=<table>`**: it runs
`scripts/rebuild_table.py` (DROP, names checked against `scripts/iceberg_tables.py`) and the
dbt run that follows recreates the table with a plain CTAS, refilling at `process_limit`
files per run (for a landing fact the script also appends the reset row to
`processed_files`, which is what makes its files pending again; a mart table refills from
the oldest date it holds, see Architecture point 3). It also works on a table the catalog
can no longer serve (the pre-drop count is best-effort). Do not use
`dbt run --full-refresh`: dbt-duckdb builds `<table>__dbt_tmp` and RENAMEs it into place,
and RENAME has never been probed against this catalog. A model change that adds a column to
an existing table goes out together with its rebuild, not ahead of it: the semantic model
would name a column the catalog doesn't have, and dbt would try an ALTER TABLE that has
never been probed either.

## Key Patterns
- Profiles: `ci` (plain DuckDB, no Iceberg), `dev`/`prod` (the OneLake Iceberg REST
  catalog, the same one).
- **SETTLEMENTDATE is AEST wall clock stored as TIMESTAMPTZ labelled UTC.** The models cast
  the CSV string to TIMESTAMPTZ in a session whose zone is UTC, so the instant in the column
  is 10h early; the `DATE`/`YEAR` columns next to it are cast from the string and are right.
  `profiles.yml` sets `TimeZone: UTC` on every target, so a run from any machine writes the
  same values. Every reader of the Iceberg tables must run with `TimeZone = 'UTC'` too (as
  `scripts/cache_catalog.py` does) — a Brisbane session shifts every date and time by +10h.
  The browser is not such a reader: the exported files hold `date` and `time`, and `data.js`
  runs in Brisbane time for `CURRENT_DATE` alone. Fixing it at the writer would change the
  column's values and mean rebuilding all seven facts.
- **Where `fct_summary`'s MW comes from.** The intraday feed (`fct_scada_today`,
  `SCADAVALUE`) first, then the next-day files (`fct_scada`, `INITIALMW`, the `DUNIT` rows
  of AEMO's `PUBLIC_DAILY`) add the keys that are missing; a stored value is never revised.
  They are different AEMO columns from different reports. Only the units the next-day files
  know are taken (`dispatch_duids`): about 35 small non-scheduled units report in the
  intraday feed alone and are left out, so that a unit does not appear for a few days and
  then vanish. `fct_scada_today` drops the 0 MW rows at load, `fct_scada` keeps them and
  `fct_summary` leaves them out.
- **What the `mart` models apply to the raw facts** (a reader of the `landing` tables has to
  redo it): `INTERVENTION = 0` only (the pricing run); 0 MW rows left out; one row per key,
  because `file` is part of every merge key in `landing` and an interval can be there from
  two files; interconnector `mw` is the dispatch target `MWFLOW`, not `METEREDMWFLOW`;
  energy is `SUM(mw) / 12`; `date` is the calendar date of the interval's end and `time` its
  HHMM; daily price and demand are plain averages of the intervals.
- Pre-hooks set DuckDB VARIABLEs with the file paths to process, read from the log table
- **Nothing to write, nothing sent.** A model that knows at compile time it has nothing to
  do (a landing fact with no new file, `dim_duid` with no new unit, `processed_files` on
  every incremental run, `fct_summary_daily`/`fct_curtailment` with no whole day in their
  range (`has_whole_days`), `fct_region_daily` with no whole day missing in its week,
  `dim_month` and the two hourly tables with no month missing (`pending_months`, from the
  manifests)) renders `{{ nothing_to_do() }}`, and the incremental
  materialization (`macros/nothing_to_do.sql`) returns before any statement: no pre-hook,
  BEGIN, temp table, MERGE, post-hook or COMMIT. The materialization is dbt-duckdb 1.11.0's,
  copied with one block added (a wrapper cannot run the Python model: dbt checks the macro
  stack), so it is re-copied when the dbt-duckdb pin moves.
- **Every file a model reads is a dbt source** (`models/sources.yml`, dbt-duckdb
  `external_location`), so the lineage graph shows it. `aemo.*` compiles to the fact model's
  `getvariable('…_paths')`, `duid_reference.*` to the file's path under `Files/csv/duid/`.
  They are not tables — the variable only exists inside its model, so no tests or freshness
  on them. The variable is there because DuckDB has no manifest: `read_csv` takes a constant
  list or a glob, not a subquery, and a glob lists the whole folder whatever the `filename`
  filter. Asked upstream in duckdb/duckdb-aws-glue#37 (`hive_scan` over a symlink manifest)
- CSVs read from gzipped archives in OneLake Files via `read_csv()` with `ignore_errors=true`
- CI target uses plain DuckDB (no Iceberg) for SQL validation; `FILES_PATH` is unset there so
  the archive falls back to `/tmp`. It runs the download for real (two files per feed)
- Dev/prod targets attach the OneLake Iceberg REST catalog via `database: iceberg_catalog`

## DuckDB version policy
Every dbt, pyiceberg and duckdb-wasm version is pinned exactly, and duckdb's 1.5 write venv;
the Python duckdb that touches the catalog is `>=2.0.0`, the newest stable release (pip
takes no pre-release on its own). Not pinned: the GitHub actions (by major tag), the runner
image, and the packages those pins pull in.
- **`process_data.yml`, `build.yml`, `table_maintenance.yml` and `import_data.yml`'s read venv
  take `duckdb>=2.0.0`** (dbt via `requirements.txt`, which pins `dbt-core`/`dbt-duckdb`
  exactly — the insert-only merges lean on adapter internals, and
  `macros/nothing_to_do.sql` is a copy of dbt-duckdb's incremental materialization). 2.0
  is the floor: `iceberg_rewrite_data_files()` (duckdb-iceberg#1035), which the compaction
  job needs, first shipped stable in 2.0.0 (2026-10-21; until then the pin was the
  pre-release `2.0.0.dev2610161340`). Every job installs the same newest release, so a new
  duckdb reaches the catalog on the next run, unannounced: a failure right after a duckdb
  release is the first thing to check against it, and `probe_catalog.yml` is re-run then.
  The `iceberg` extension is installed from `core` first (`compact_iceberg.py` falls back
  to `core_nightly`); its binary is keyed to the duckdb build, in a folder per version, so
  the extension follows duckdb. duckdb-iceberg has no `expire_snapshots` yet
  (duckdb-iceberg#1341 is open), so pyiceberg stays until that merges.
- **pyiceberg is pinned to a commit**, `4adf237` (snapshot expiry and orphan files,
  `table_maintenance.yml` only): apache/iceberg-python PR #3361 on main after 0.12.0, built
  on the runner from `djouallah/iceberg-python` (tag `orphan-files-4adf237` keeps the commit
  reachable). Back to a release pin once the PR ships in one. It is pinned on its own
  schedule — it never touches the duckdb file format, only the REST catalog, and the script
  reaches into `RestCatalog._supported_endpoints`, which is exactly the kind of internal a
  floating version breaks. That poke is a fallback: pyiceberg refuses to `commit_table` unless
  `GET /v1/config` advertises the update-table endpoint, and Microsoft's docs show a
  GET/HEAD-only config. The live catalog advertises 13 endpoints including
  `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}`, so the override doesn't fire —
  the script logs the list each run, which is the evidence.
- **`import_data.yml`'s write venv stays on the 1.5 line (`duckdb==1.5.6`).** Different reason: it
  builds the `.duckdb` files deployed to the NemTracker dashboard, read client-side by
  DuckDB-WASM (1.5.x), so the on-disk file format must stay stable for the *already deployed*
  reader. Patch releases within 1.5 keep the format; don't move it to 2.0 until a duckdb-wasm
  build on 2.0 is pinned in the dashboard. Parquet is the handoff between the two venvs: 1.5
  can't read tables that compaction rewrote with the 2.0 build.
- **The GitHub page pins `@duckdb/duckdb-wasm@1.33.1-dev65.0`** (DuckDB 1.5.x line; the Iceberg
  Fabric app runs 2.0, see its section), a dev build
  because nothing stable has shipped since 1.33.0. Don't take npm's `latest` tag: it points
  at `1.33.1-dev57.0`, which the DuckDB blog says breaks OPFS. The dev build lets
  `attachCached` (`dashboard/github/history.js`) read the OPFS-cached files in place
  (`registerFileHandle` + `BROWSER_FSACCESS`) instead of copying each one into the WASM heap.
  Register the plain filename, not `opfs://`: an `opfs://` ATTACH also opens `<file>.wal`,
  which is never registered, so the ATTACH fails. The handle is exclusive, so a second tab
  falls back to in-memory.
  It runs **single-threaded on purpose**. The `coi` (threads) build loads, but it can't load
  ICU (`SET TimeZone` fails with a shared-memory LinkError), it can't pass the OPFS handle to
  its pthreads, and it only gains ~1.4x on 4 threads. The page is therefore not cross-origin
  isolated. The `coi-serviceworker.js` still deployed on the site is a self-unregistering
  kill switch for browsers that installed an old one; it is not in this repo and stays
  published because deploys only add files. Don't delete it from the deploy repo: a browser
  that still has the old worker would keep it.
