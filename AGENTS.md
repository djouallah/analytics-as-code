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
- **Writes are insert-only merges** (`WHEN MATCHED DO NOTHING`): the OneLake catalog accepts
  one add-snapshot per commit and rejects a commit mixing delete files + data files
  (BadRequest 400). A `DELETE` in a commit of its own works. Same pattern as the sibling
  repo (dbt-fabric). `dim_calendar` is a plain
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
   leaves the list later stays in `dim_duid` (insert-only), but a `rebuild=dim_duid` loses it
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
   filter that duckdb-iceberg prunes data files on — a subquery (`MAX(DATE) FROM ...`,
   `DATE IN (SELECT ...)`) does not prune. Each model logs the bounds it read and the ranges
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
   (`pyiceberg==0.11.1`) because duckdb-iceberg has no `expire_snapshots` yet. It is
   metadata-only: snapshots leave the metadata JSON, the orphaned data files stay, so reads
   get faster but storage doesn't shrink. Tables hold 16-18 snapshots, none older than a day,
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

## DELETE works, in a commit of its own
On OneLake a commit may carry only one add-snapshot, so a commit that mixes delete files with
data files is rejected (`BadRequest 400`): an `UPDATE`, a `MERGE` that updates or deletes, a
`DELETE` and an `INSERT` in one transaction. A fix is expected upstream; until then the merges
are insert-only. A `DELETE` in a commit of its own works, so replacing rows is two commits,
the `DELETE` and then the `INSERT`. They are not atomic: a reader between the two sees the
rows gone, and a run that fails after the `DELETE` leaves them gone until the next run
writes them.

The catalog capability probe (CREATE/INSERT/DELETE/UPDATE/MERGE/DROP against a freshly
created table) lives in the user's **separate repo**, not here. Its matrix is the standing
evidence for what this catalog actually does; ask for it before relying on any claim here,
and ask for a re-run after the catalog or the duckdb pin moves.

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
  (`fabric-github-deploy`), a member of the app's workspace: it uploads the data
  (`scripts/deploy_onelake.py`) and is the identity of `deploy_fabric.yml` into a fabriccat
  workspace (the catalog's tenant gets `AZURE_CLIENT_ID`).
  It is a second tenant: `deploy_onelake.py` exchanges the job's GitHub OIDC token itself,
  next to the workflow's catalog login. The app's
  federated credential for this repo has the subject
  `repo:djouallah/analytics-as-code:ref:refs/heads/main`.
- `FABRIC_APP_WORKSPACE_ID` (workspace `app`), `ONELAKE_FILES_URL` (the lakehouse's Files
  folder, where the wasm app's function signs its SAS).
Env contract consumed by profiles.yml, the models and the scripts: `ONELAKE_ENDPOINT`,
`ONELAKE_TOKEN`, `WAREHOUSE_PATH`, `FILES_PATH`, `download_limit`, `process_limit`,
`ALL_PERIODS` (the two import workflows), plus
`AZURE_TRANSPORT_OPTION_TYPE=curl` + `CURL_CA_INFO` on runners (the azure extension's default
transport fails the OneLake TLS handshake).
`NEMTRACKER_TOKEN` (gh-pages deploy) is the one true secret.

## Dashboard
**The layout says who reads the model:** `semantic_model/` at the top of the repo is the one
semantic model, and `dashboard/` holds its clients: `github/` (the page, on GitHub Pages),
`fabric_app/` (the same page as a Fabric app) and `powerbi_report/` (`nem.Report`, a report
over the deployed model). **`dashboard/fabric_app/` is one app and two backends**, as
`github/` is one page and two ways of asking: `common/` (`build.mjs` and the Fabric sign-in,
`site/storage/auth.js`), `wasm/` (DuckDB-WASM over a copy of the tables, deployed) and
`vertipaq/` (the deployed model as the engine, installed by `deploy_fabric.yml`; see "The
whole stack in one workspace"). Each backend is a Rayfin project of its own, named by its
engine.
**`dashboard/github/` is one page and two ways of asking:**
`common/` (`index.html`, `frontend/` draw.js, logs.js, perflog.js, `storage/`, `dag/`), `dax/`
(`frontend/queries.js` and `semantic/query.js`: the page through the semantic model) and
`sql/` (`frontend/queries.js`: the page in plain SQL, with no semantic layer, each member one
SELECT over the views, its figures written in SQL: how a team would build the page in
practice). A page is `common/` with one of the two copied over it
(`scripts/stage_pages.mjs`, `stagePage`). The DAX page is served at the site's root, the
default, the SQL page at `sql/`, which reads the site's `data/` (`connect` in its `queries.js`
passes `base: '../'` to `data.js`'s `init`). The SQL page holds to the model through the DAX
page (`scripts/parity/sql_page.mjs`, below). Below, "the page" is the DAX page unless said.
**The GitHub page is the critical one: it is public and must never break.** The Fabric app
and Power BI are internal: they should not break either, but it is not the end of the world
if one does. So a change that touches what they share (the model, the `mart` tables, the
page's files) is checked on the public page first and goes out only when that check is
clean, and where the clients pull apart the public page wins.
The page has the layers of a BI stack, each in its own place under `dashboard/github/` (the
table of what stands in each place in a real product is in `doc/ARCHITECTURE.md`), and two
hosts that run it on DuckDB-WASM: GitHub Pages and a Fabric app. Everything is the same file
on both except `storage/data.js`.
- consumer: `index.html` (the charts) and `frontend/queries.js` (what each chart asks)
- query language: the page's queries, objects of the model's fields (`select`, `where`, ...),
  which the compiler writes as DAX
- semantic model: `semantic_model/model.bim` (at the top of the repo), a Tabular model in TMSL
- query: `semantic/query.js`, the page's queries to DAX (`toDax`)
- compiler: `packages/dax-sql` (staged as `semantic/dax-sql/`), the DAX to SQL
- engine: DuckDB-WASM
- storage: `storage/data.js`, `storage/history.js`, `storage/views.js` (a view per table)
- and the Logs tab, `frontend/`
`index.html` imports `storage/data.js` and `frontend/queries.js`, nothing else of these:
`queries.js` exports `connect(data)`, what runs its queries (here the compiler's
`createModel`, in the SQL page the data source as it is). So a client of the page swaps
`frontend/queries.js`, not `index.html`.

**It is a proof of concept; the point is that the layers are there, in the formats of a
real product.** The compiler is two steps, as in Power BI: the page's query becomes DAX
(`toDax`, in `semantic/query.js`, which knows the page's words and nothing of SQL), and the DAX
becomes SQL in `packages/dax-sql`, a general DAX compiler: any Tabular model, DAX's filter
context, context transition, relationships and blanks (see its README and DESIGN.md). Its
rows are DAX's: `SUMMARIZECOLUMNS` leaves out a group whose measures are all blank, `TOPN`
keeps the rows tied with the n-th, an ascending `ORDER BY` puts blanks first. **dax-sql
knows nothing of this model, this page or this data**: no case for a measure, a table or a
query, and nothing it assumes of the data that the model does not declare
(`relyOnReferentialIntegrity`, or the page's `assumeIntegrity`). A change there is a
general rewrite, checked by its own tests and by the page's (below), never a case for a
query. Which table a measure reads is the model's rule, which DAX answers from the query;
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
writes its DAX, checking each column and measure against `model.bim`, and `query()` refuses
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
which row is the largest), and all of it is in `dashboard/github/common/frontend/draw.js`.
So the page shows no figure that is not a measure: no Flows events under the clock (a jump
of a link or a price between two intervals), no "how long a link has had no flow", and no
share on the hero's "Other" (the share of several fuels together is no measure).
**`scripts/parity/page_lint.mjs` enforces it** (`build.yml`, on every push): no `+ - * / %`
on numbers, no `+= -=`, no `.reduce()` in the script of `index.html` or in either page's
`queries.js` (the SQL page's figures are SQL, in its strings); it
does not read `draw.js`, which a review reads instead. The rows the page uses as they are
stored are not figures: the filter lists, the newest interval, the Flows rows (a unit's MW,
a link's flow and limits).

**The Analyze tab is SQL, and only SQL**: a box over the views the compiler builds (the
example lists them, with their columns), which shows the stored columns, not the model's
measures, and says so. The page writes no SQL into it: SQL built from the page's filters
would be a second query language with figures of its own. The compiler never sees text a
user typed: `query()` translates a query object, which only the page's own queries are, and
refuses DAX text. Don't make the box accept DAX. Its CSV is the rows of its SQL (`draw.js`'s
`writeCsv`).

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
its `orderBy` asks. A measure changed in the model that the SQL page does not follow fails
there. With an output file it writes the shape `parity_model.py` reads, the DAX next to the
SQL page's rows, to ask the model directly.
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
(`scripts/stage_pages.mjs`: `common/`, the variant over it, and for the DAX page
`semantic_model/model.bim` next to the compiler that fetches it), and everything that serves
or imports the page stages it first: the site (`build.yml`, `import_data.yml`), the Fabric
app's build, the parity scripts. To serve it from a laptop, stage the site into a folder
(`node scripts/stage_pages.mjs <dir> <build>`) and put a copy of `data/` next to it. A relative
import is of the staged tree (`dax/semantic/query.js` imports `./dax-sql/index.js`, which
`stagePage` copies there from `packages/dax-sql/src`).
- `dashboard/github/common/index.html` is the page: the charts, which draw what
  `dashboard/github/dax/frontend/queries.js` asks: every query the charts send, by tab and chart
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
- `semantic_model/model.bim` is the semantic model, **the same file Power BI runs**
  (see "The semantic model"): TMSL, compatibility level 1604, every table one Direct Lake
  partition on a `mart` table, single-column relationships, and the measures. It holds DAX
  only: nothing in it is written for DuckDB, and no SQL goes into it, as an annotation or
  otherwise. `.platform` and `definition.pbism` next to it make the folder a Fabric item.
  It is JSON, so a browser reads it with no library: there are no comments, so the why goes
  in a `description`, and a long expression is an array of lines.
- `dashboard/github/common/storage/views.js` (`withViews(data)`, which every `data.js`
  returns itself wrapped in) is the tables as views: a view `v_<table>` per table attached,
  over the files (the table whole in `dim` or `agg`, or split by date over `today` and the
  half-years: `today` has the days it holds, cut at a literal date; the files are stacked by
  column name, so one built before a column was added reads as NULL in it). It creates them
  after every attach: one query reads what is attached from the engine's catalog
  (`information_schema`), and one runs the statements that are new or changed. It adds
  `views`, `has` and `needs` to the data source: `needs(sql)` says what a SQL
  query reads; `ensureHistory` attaches nothing for a range that starts inside the days
  `today` holds, so the default view fetches no history.
- `dashboard/github/dax/semantic/query.js` (`createModel(dataSource)`: the data source's
  members, `toDax` and `toSQL`): `toDax(query)` writes the page's query as DAX, checking each
  column and measure against `model.bim`; `toSQL(dax)` is `packages/dax-sql`'s compile of it
  over the data source's `v_<table>` views (staged next to the compiler as `semantic/dax-sql/`
  by `stagePage`), the same text once (a Map). The page's options: `assumeIntegrity` (a
  dimension's key is read off the fact: the dbt tests keep the data so) and its casts for the
  browser (a date as VARCHAR, a whole number as INTEGER, a number as DOUBLE: a BIGINT reaches
  the page as a BigInt). How dax-sql writes its SQL (fused scans, a subquery read once,
  decorrelation across a relationship that filters both ways) is in its DESIGN.md.
  Checked, offline, on every push (`build.yml`): dax-sql's own tests on made-up data;
  `sql_page.mjs`, the SQL page against the DAX page on the deployed files (the deploy waits
  for it); `compiler_ab.mjs`, the compiler against the commit before, rows and time (a report,
  with the slower queries' SQL and plans as an artifact). Against the model: the parity
  (`deploy_model.yml`).
- `storage/data.js` is the host: how the `.duckdb` files are fetched, cached and attached
  (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `query`, wrapped by
  `views.js`). It attaches `dim`, `today`, `agg` and the 5-minute history. On both the files
  are downloaded whole into OPFS, and the history is the half-year files (`p2026_h1`, ...),
  the ones a range needs. There are two, with the same members:
  - `dashboard/github/common/storage/data.js`, GitHub Pages: the files sit in `data/`
    (`mart_dim`, `mart_today`, `mart_agg`, `mart_<YYYY>_h<N>`), with `mart_manifest.json`
    listing the half-years.
  - `dashboard/fabric_app/wasm/site/storage/data.js`, the Fabric app: the files are in a
    lakehouse behind a Fabric sign-in, read with a short-lived read-only SAS, and downloaded
    as 2 MB Range requests, 6 at a time. Its own, and unknown to the page: the sign-in gate
    (`auth.js`, next to it) and the SAS (`sas.js`).
  The history is never read in place over HTTP: duckdb-wasm reads a remote file one block
  at a time, three round trips each, and OneLake answers one in ~700 ms whatever its size.
  Both set the session to Brisbane time, on purpose: the files carry `date` and `time`, no
  TIMESTAMPTZ, and the only thing the zone decides is that `CURRENT_DATE` is the NEM's day.
- `dashboard/github/common/storage/history.js` is what both `data.js` share about the
  half-year history files: `periodsForRange` (which ones a date range needs) and
  `attachCached` (ATTACH from OPFS in place, into memory if a second tab holds the file).
- `dashboard/github/common/frontend/perflog.js` and `dashboard/github/common/frontend/logs.js`
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

**Checking a change to `model.bim`, `packages/dax-sql`, `query.js`, a `data.js` or the page:** in headless
Chrome, the page before against the page after on one copy of the deployed files, through
the same page states; compare what each chart draws (its ECharts series) and the SQL that
ran (the Logs tab has it, translated), read `EXPLAIN` for a join that was not there, and
time old against new alternately in the same page (two separate sessions differ by more than
the change does). Speed is tracked every time: the total, and any query clearly slower. A
difference of some 10 ms on one query is not worth chasing: on a second run as many go the
other way.

## Dashboard deploy
`build.yml` (the pages, staged by `scripts/stage_pages.mjs`: the DAX page at the root with its
`frontend/`, `semantic/` and `storage/` folders, the SQL page at `sql/`, the dbt docs) and
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

**The same files also go to OneLake**, for the Fabric app (the same page, hosted in Fabric,
reading a lakehouse in another tenant — workspace `app`, lakehouse `data`).
`import_onelake.yml` (daily, 22:30 UTC) runs the same `cache_catalog.py` steps and publishes
with `scripts/deploy_onelake.py`. It builds the same files, with one difference: it sets
`ALL_PERIODS=true`, so every run copies all the history (OneLake keeps two whole imports and
has no deployed copy to add to). The build fails on both if a half-year file
outgrows 100 MB, GitHub's limit for a file.
On OneLake the files are `dim_`/`today_`/`agg_<ts>.duckdb` and `<YYYY>_h<N>_<ts>.duckdb`;
`latest.json` (`{"ts", "periods"}`), written last, names the current import, and the files
of two imports are kept so that an open page keeps reading the one it attached. The page's
OPFS cache keeps one import, so each daily import downloads a half-year again the first time
it is viewed.

**The Fabric app is `dashboard/fabric_app/wasm/`**, a Rayfin project: static hosting, Fabric
sign-in, and one function, `getDataSas` (`dashboard/fabric_app/wasm/rayfin/functions`), which
signs a read-only SAS on the data folder so that the browser never holds a storage token.
`dashboard/fabric_app/common/build.mjs` assembles a project's `dist/` (here
`dashboard/fabric_app/wasm/dist`): the DAX page staged (`stagePage('dax')`: `common/`,
`dax/` and `semantic_model/model.bim`) and the dbt docs, with `fabric_app/common/site/`
(`storage/auth.js`) and then the project's own `site/` copied over them (here
`storage/data.js` and `storage/sas.js`), and `?v=<build>` added to every relative import;
`query.js` passes its own on to `model.bim`. The project is the working directory of
`build.mjs` (`npm run build:fabric` in it).

**It is deployed from the owner's laptop**, under their own login:
```
cd dashboard/fabric_app/wasm
npm ci && npm ci --prefix rayfin/functions
export RAYFIN_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
npx rayfin up --yes --output json
```
The item is `wasm` in workspace `app`;
`dashboard/fabric_app/wasm/rayfin/.deployments.json` (untracked) records it, and its URL is in
`dashboard/fabric_app/wasm/rayfin/rayfin.yml` (`allowedRedirectUris`; the deploy adds it). On
a machine without that record, add `--workspace-id <app>`. A new item needs its secret once,
then one more deploy: `echo <Files URL> | npx rayfin secret set ONELAKE_FILES_URL --stdin`.

**Rayfin lets only the owner of an app item deploy to it**, and the owner is whoever created
it; the owner is also the identity `getDataSas` reads the lakehouse as. That is why the
laptop and CI cannot share an item: a deploy to someone else's fails with
`403 Only AppBackend artifact owner can perform this operation`.

**The wasm app from CI deploys but does not work yet** (`deploy_fabric.yml`'s
`fabric_app_wasm`, item `nemtracker`): Fabric answers 500 ("An internal error occurred.") to
every function call on an item owned by a service principal, before the function runs
(microsoft/rayfin#89, open, with this repo's case in its comments). The CI deploy needs:
- `dashboard/fabric_app/wasm/rayfin/functions/host.json` is committed: the deploy refuses
  without it, and the Rayfin scaffold's `.gitignore` leaves it out.
- The lock files resolve from `registry.npmjs.org`: generated on a laptop they name a
  private feed the runner cannot read.

Rules of the Fabric host that are easy to break:
- The browser never receives a storage token, only the SAS from `getDataSas` (read-only, one
  folder, about 55 minutes). New data access means extending that function.
- The workspace setting "Authenticate with OneLake user-delegated SAS tokens" must be on, and
  the item's owner must be able to read the lakehouse.
- Single-threaded here for one more reason than on Pages: cross-origin isolation breaks the
  Fabric sign-in popup.
To check a deploy, open the Logs tab: the build stamp, each fetch, attach and query.

### The whole stack in one workspace
`deploy_fabric.yml` (dispatch: `tenant_id`, `workspace_id`, and a tick per part, all on by
default: `data`, `semantic_model`, `powerbi_report`, `fabric_app_vertipaq`,
`fabric_app_wasm`) installs the project into one
Fabric workspace, independent of everything GitHub runs: the mechanism of the sibling
`fabric-medallion-dbt` (`.github/scripts/deploy.py`), ported. `scripts/deploy_fabric.py`:
- publishes `fabric_items/` with fabric-cicd: the lakehouse `nem` (schema-enabled), the
  Python notebook `run` and the pipeline `run_pipeline` that calls it;
- uploads the dbt project (`git archive HEAD`) to `nem/Files/project`, with a `COMMIT` file;
- runs the pipeline once and waits: the model names tables a first run creates;
- publishes the model and the report with `deploy_model.main()`, on that lakehouse;
- schedules the pipeline hourly, if it has no schedule.
Then the workflow deploys `dashboard/fabric_app/vertipaq/` (item `vertipaq`), its connector
naming the model `nem` of the same workspace, and `dashboard/fabric_app/wasm/` (item
`nemtracker`, CI's own: the laptop's `wasm` refuses another owner), which reads the
`.duckdb` files of `import_onelake.yml` and fails until microsoft/rayfin#89 is fixed. The workspace must exist, on a capacity in a
region with Fabric apps (preview); the login is the repo's Entra app of that tenant
(`AZURE_*` or `LAKE_*`), any other tenant fails at the first step.
The notebook does what `process_data.yml` does: the same env contract (from `notebookutils`:
the workspace, the lakehouse's id, a storage token), `pip install -r requirements.txt`, and
the same two `dbt run --target prod`. No `rebuild`, maintenance, tests or `.duckdb` import
there: those stay on GitHub, for the `power` catalog.

**The VertiPaq app** is the page with the deployed semantic model as its engine (Power BI in
Direct Lake over the `mart` tables, no DuckDB, no copy of the data). Its
`site/storage/data.js` sets `engine: 'dax'`, and the compiler's `createModel` then sends each
query's DAX (`toDax`) to it as it is, with no views and no SQL; with no `needs`, the page
leaves out Analyze. The route to the model is a Rayfin connector of type
`fabric-semanticmodel` (`executeQuery`, delegated): the app's backend runs the query on the
model as the signed-in user, so the browser holds no Power BI token. Not in `power`: its
capacity is in Australia Southeast, where Fabric refuses an app item
(`403 The feature is not available`, microsoft/rayfin#8).

A table or a column the page asks for and a deployed file lacks reads as "no data" where
the page checks (`data.has`), so a new page can go out before its data; a new table goes
into `cache_catalog.py`'s lists once it is a dbt model and a table of `model.bim`.
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
- `semantic_model/` is the model, a Fabric item (`model.bim`, `definition.pbism`,
  `.platform`; fabric-cicd finds an item by its `.platform`, whatever the folder is called,
  and `deploy_model.py` publishes a copy of that folder): each table one Direct Lake
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
- **The report is `dashboard/powerbi_report/nem.Report`**, in PBIR (a JSON file per page and
  per visual; schema versions and base theme as Power BI Desktop writes them). One page,
  "Overview": the model's measures by day, fuel, region and station, over the last 30 days
  (a page filter). It holds no measure of its own, and its filters are on the dimensions, so
  the measures read the daily tables. `definition.pbir` names the model by its path in the
  repo (`../../../semantic_model`); fabric-cicd turns that into the deployed model's id, so
  `deploy_model.py` copies the two to the same places relative to each other. No `.pbip`:
  the model's lakehouse ids are placeholders here, so Desktop could not open it. Nothing in
  CI sees a chart draw: a change to a visual is checked by opening the report.
- `deploy_model.yml` (dispatch only) publishes the model and the report into the catalog's
  workspace with `scripts/deploy_model.py` (fabric-cicd, not duckrun) and runs
  `scripts/check_model.py`: a refresh, then a row count per table and each measure per day
  for the newest week (the measures of the tables by month per month: a date does not
  filter those tables), then that the report is there and reads the model; with
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
| dim_duid | mart | incremental insert-only merge on DUID; NEM units from the registration list, then `duid_unregistered.csv`; registered capacity (RegCapMW etc.); `Renewable` — **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind"; `CO2eFactor` (t CO2-e/MWh) from MMSDM `GENUNITS` through `DUALLOC`, for registered and unregistered units alike, NULL for loads, AEMO's dummy units and the gensets "On Exclusion List" (Colongra, Jeeralang, Braemar 3 and 6), which `[Emissions t]` therefore leaves out; `Storage` (a battery, the fuel "Grid": the one place that rule lives), `Plant` (the station, or the unit when it has none: what the page groups units by) and `Owner` (the participant, rooftop's five units "Rooftop solar (AEMO estimate)"); one spelling per name, case-insensitively, for StationName, Participant and TechnologyType (VertiPaq stores text case-insensitively). A new column or a changed rule reaches the existing rows with a `rebuild=dim_duid` |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so `fct_interconnector` takes one row per interval (`MAX … GROUP BY`); the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/availability/cleared MW. History's demand/net interchange come from fct_price's DREGION rows |
| fct_summary | mart | incremental insert-only merge on (date, time, DUID) — the Power BI fact: `fct_scada` joined to `dim_duid` and `fct_price` (inner joins), then the intraday feed after the newest daily interval, for the units the daily files know (`dispatch_duids`), and rooftop solar as five units, `ROOFTOP_<region>`: `fct_rooftop` on the straight line between two half hours, with `fct_region`'s price. An interval is written once both sources have it (every branch stops at the newest half hour all five regions' rooftop has), so the units run 30-60 minutes late. `backfill_rooftop` (a dispatch input of `process_data.yml`) adds rooftop's history. Every run recomputes the newest daily date minus six days on; missing keys are added, a stored value is never revised. The dates come from the Iceberg manifests and are written as literals (no scan to find them); a refill takes `process_limit` dates below the oldest it holds, newest first. `rebuild=fct_summary` resets it |
| fct_region | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: price, demand, net interchange and the regional semi-scheduled wind and solar. The intraday record where `fct_price_today` and `fct_regionsum_today` both have the interval, else `fct_price`'s. Every run recomputes from six days before `fct_price`'s newest date on (from the manifests, a literal on all three sources); the merge adds what is missing. A first build reads them whole |
| fct_rooftop | mart | incremental insert-only merge on (REGIONID, date, time) — the source `fct_summary`'s rooftop units are built from (not a table of the semantic model): the `MEASUREMENT` estimate per region and half hour as published (zeros kept, blanks out), with the half hour's average price from `fct_region`; written once its six prices exist |
| fct_interconnector | mart | incremental insert-only merge on (interconnector, date, time) — for Power BI: `MWFLOW` and the two limits, the pricing run, one row per interval |
| fct_curtailment_region | mart | incremental insert-only merge on (REGIONID, date, fuel) — for Power BI and the curtailment chart: curtailed and available MWh per region, day and fuel (Wind, Solar), `source` `farms` (`fct_curtailment` added up by the unit's region and fuel) or `aemo` (`fct_region`'s regional semi-scheduled figures, the days after the farms' newest). Each run a pre-hook DELETEs the `aemo` rows in a commit of its own, then the merge adds the missing farm days and the current `aemo` days |
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

`dim_duid`'s insert-only merge means attribute changes (region/fuel/geo) never update in
place. **Rebuilding a table = dispatch `process_data.yml` with `rebuild=<table>`**: it runs
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
Every duckdb, dbt, pyiceberg and duckdb-wasm version is pinned exactly — none floats on
"latest". Not pinned: the GitHub actions (by major tag), the runner image, and the packages
those pins pull in. `import_onelake.yml` has the same two venvs as `import_data.yml`, with
the same pins, and pins the two Azure SDK packages its upload uses.
- **`process_data.yml`, `build.yml`, `table_maintenance.yml` and `import_data.yml`'s read venv
  pin `duckdb==2.0.0.dev2610011535`** (dbt via `requirements.txt`, which also pins
  `dbt-core`/`dbt-duckdb` exactly — the insert-only merges lean on adapter internals, and
  `macros/nothing_to_do.sql` is a copy of dbt-duckdb's incremental materialization). The
  1.6 line became **DuckDB 2.0.0** (stable due 2026-10-21); its pre-releases are published as
  `2.0.0.devYYMMDDHHMM`. The pre-release is required, not incidental:
  `iceberg_rewrite_data_files()` (duckdb-iceberg#1035) isn't in a stable release yet, and the
  compaction job needs it. Pinning the same build everywhere means the catalog is only ever
  touched by one known duckdb. The `iceberg` extension is installed from `core` first
  (`compact_iceberg.py` falls back to `core_nightly`) and its binary is keyed to the duckdb
  build, so pinning duckdb pins the extension too. Move every pin to `duckdb==2.0.0` once it
  ships. duckdb-iceberg has no `expire_snapshots` yet (duckdb-iceberg#1341 is open), so
  pyiceberg stays until that merges.
- **`pyiceberg==0.11.1`** (snapshot expiry, `table_maintenance.yml` only) is pinned on its own
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
- **The dashboard pins `@duckdb/duckdb-wasm@1.33.1-dev65.0`** (DuckDB 1.5.x line), a dev build
  because nothing stable has shipped since 1.33.0. Don't take npm's `latest` tag: it points
  at `1.33.1-dev57.0`, which the DuckDB blog says breaks OPFS. The dev build lets
  `attachCached` (`dashboard/github/common/storage/history.js`) read the OPFS-cached files in place
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
