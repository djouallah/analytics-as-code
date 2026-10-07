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
- **Writes are insert-only merges** (`WHEN MATCHED DO NOTHING`): the OneLake catalog accepts
  one add-snapshot per commit and, for now, rejects a commit mixing delete files + data files
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
(dbt-duckdb on this same kind of catalog). The dashboard reads it too, since 2026-10-05, with
the other `mart` tables and through the same semantic model as Power BI.
**Look there first for fixes, and port them rather than diverging.** Worth knowing: there,
downloading lives outside dbt and the log is read straight from parquet, not from an Iceberg
table.
Four deliberate local differences, all of which must survive a port:
- `fct_summary` decides its dates at compile time from the Iceberg manifests and writes
  them as literals (Architecture point 3): the newest daily date minus six days on, the
  intraday feed after the newest daily interval, and in a refill `process_limit` dates
  below the oldest it holds (uncapped, the first build ran the runner out of memory). The
  reference asks the data (`MAX(DATE)`, `DISTINCT DATE ... NOT IN`, the partial-dates
  `COUNT(DISTINCT time) < 280`): full scans, which cost 450-700 s a run here. The
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
   each DUID reference file is downloaded when its log row is 24h old, and the backfills (the
   GitHub historical listing, the monthly archives, the weekly rooftop archives) only run when
   AEMO returned fewer than `download_limit` new daily files. `download_limit` is per feed.
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
   whether or not it yielded a row. Until 2026-10-06 the anti-join was against the fact's
   own `file` column — a full scan of the fact over OneLake (`fct_scada`: 80-175 s), twice
   per model per run, to find most runs that there was nothing to do. A `rebuild=<fact>`
   appends a reset row (`csv_filename` NULL) for it, so only files processed after the
   reset count and the refill reads the whole archive again. The table's first build seeds
   it from the facts' `file` columns (`rebuild=processed_files` reseeds it); the
   `assert_all_*files_processed_*` tests still compare the log to the facts. The DISTINCT is
   load-bearing: the log table is append-only and can hold a file more than once, and MERGE
   only dedupes against the target, never within a batch — without it a backlog is read 2-N
   times per batch and turns into duplicate keys.
   **The mart models decide their dates the same way, without scanning** (2026-10-06):
   `MIN`/`MAX` of a date column come from the Iceberg manifests
   (`macros/date_bounds.sql`, `iceberg_column_stats()`), and the dates a run recomputes are
   written into the SQL as literals, so every scan of a big table carries a constant `DATE`
   filter that duckdb-iceberg prunes data files on — a subquery (`MAX(DATE) FROM ...`,
   `DATE IN (SELECT ...)`) does not prune. `fct_summary` scanned `fct_scada` whole five times
   and itself twice per run (450-700 s) to recompute a week; `whole_days` grouped all of
   `fct_scada` by date for each daily table (75-100 s each). Each model logs the bounds it
   read and the ranges it chose, so a run's log says what it decided. The `ci` target (no
   Iceberg) reads plain `MIN`/`MAX`. Measured on the first run (37408067580, 2026-10-06):
   `fct_scada` with nothing to do 5 s, `fct_summary` 47 s (its MERGE 22 s of it),
   `fct_summary_daily` 7 s, `fct_curtailment` 33 s; the mart step 3.5 min against 16.
   The staging model appends only the rows the Iceberg table is missing (anti-join on
   source_type/source_filename/csv_filename against `dbt.this`). Appending the whole log every
   run grows the table by its own size 48 times a day, until the OneLake catalog answers HTTP
   500 to every load and commit of it. `Files/csv_archive_log.parquet` is the durable log and
   the only source of truth — the Iceberg table is a materialization, rebuildable from it.
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
   waiting, and a maintenance job still waiting is replaced by the next Process Data run. It is `continue-on-error`
   and both scripts always exit 0: maintenance must never fail its workflow (a red run there
   means a dbt test failed). The price of that is that a compaction that has stopped working
   only shows in the job's log. Both scripts read their table list from
   `scripts/iceberg_tables.py`; a new model gets added there once.

## DELETE works, in a commit of its own
On OneLake a commit may carry only one add-snapshot, so, for now, a commit that mixes delete
files with data files is rejected (`BadRequest 400`): an `UPDATE`, a `MERGE` that updates or
deletes, a `DELETE` and an `INSERT` in one transaction. That is expected to be fixed soon,
and it is why the merges are insert-only. A `DELETE` in a commit of its own works (the
owner's, 2026-10-07), so replacing rows is two commits, the `DELETE` and then the `INSERT`.
They are not atomic: a reader between the two sees the rows gone, and a run that fails after
the `DELETE` leaves them gone until the next run writes them.

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
  directly from them. **No workflow creates or looks up a lakehouse** — that is infrastructure,
  created once by hand (schema-enabled, since the models write to `landing`/`mart`). If it is
  ever recreated, update `LH_ID`; CI is deliberately not in the provisioning business.
- `LAKE_TENANT_ID`, `LAKE_CLIENT_ID` — the Fabric app's tenant and an Entra app there
  (`fabric-github-deploy`), a member of the app's workspace: it uploads the data
  (`scripts/deploy_onelake.py`); the parked `deploy_fabric.yml` deployed the app with it.
  It is a second tenant: `deploy_onelake.py` exchanges the job's GitHub OIDC token itself,
  next to the workflow's catalog login. The app's
  federated credential for this repo has the subject
  `repo:djouallah/analytics-as-code:ref:refs/heads/main`.
- `FABRIC_APP_WORKSPACE_ID` (workspace `app`), `ONELAKE_FILES_URL` (the lakehouse's Files
  folder, where the app's function signs its SAS) — `deploy_fabric.yml`.
Env contract consumed by profiles.yml, the models and the scripts: `ONELAKE_ENDPOINT`,
`ONELAKE_TOKEN`, `WAREHOUSE_PATH`, `FILES_PATH`, `download_limit`, `process_limit`,
`ALL_PERIODS` (the two import workflows), plus
`AZURE_TRANSPORT_OPTION_TYPE=curl` + `CURL_CA_INFO` on runners (the azure extension's default
transport fails the OneLake TLS handshake).
`NEMTRACKER_TOKEN` (gh-pages deploy) is the one true secret.

## Dashboard
**The layout says who reads the model** (the owner's, 2026-10-05): `semantic_model/` at the
top of the repo is the one semantic model, and `dashboard/` holds its four clients:
`github/` (the page, on GitHub Pages), `fabric_app_wasm/` (the same page as a Fabric app, on
DuckDB-WASM), `fabric_app_vertipaq/` (the same page as a Fabric app, its DAX run by the
deployed model: see "The Fabric app on VertiPaq") and `powerbi/` (`nem.Report`, a report over
the deployed model). The two Fabric apps are named by their engine (the owner's, 2026-10-06).
**The GitHub page is the critical one: it is public and must never break** (the owner's,
2026-10-05). The Fabric apps and Power BI are internal: they should not break either, but it
is not the end of the world if one does. So a change that touches what they share (the
model, the `mart` tables, the page's files) is checked on the public page first and goes
out only when that check is clean, and where the clients pull apart the public page wins.
The page has the layers of a BI stack, each in its own place under `dashboard/github/` (the
table of what stands in each place in a real product is in `ARCHITECTURE.md`), and two hosts
that run it on DuckDB-WASM: GitHub Pages and a Fabric app. Everything is the same file on
both except `storage/data.js`. On the third host, the Fabric app on VertiPaq, the last three
layers are Power BI's, and of this list it has `index.html`, its own `storage/data.js` and
the Logs tab.
- consumer: `index.html`
- query language: DAX, written in the page
- semantic model: `semantic_model/model.bim` (at the top of the repo), a Tabular model in TMSL
- compiler: `semantic/compiler.js`, the model to views and the DAX to SQL
- engine: DuckDB-WASM
- storage: `storage/data.js`, `storage/history.js`
- and the Logs tab, `frontend/`

**It is a proof of concept (2026-10-05); the point is that the layers are there, in the
formats of a real product.** The compiler is not a DAX engine. It knows the constructs the
page uses and throws on anything else (`DAX: X is not supported`), and where DAX and SQL
differ the result is SQL's: a blank is a NULL, and there is no filter context (a filter is a boolean argument of `CALCULATETABLE` or
`CALCULATE`). Its rows are DAX's: `SUMMARIZECOLUMNS` leaves out a group whose measures are
all blank (a `HAVING`), and `TOPN` is descending unless `ASC` and keeps the rows tied with
the n-th (`QUALIFY RANK()`). A chart that needs a new construct gets it in `compiler.js`, as one more case;
don't grow it into a general engine. Of the rules a query compiler applies on its own, it
applies one, when a join is needed (below). Which table a measure reads is the model's rule,
which the compiler answers from the query; which grain a date range gets, and MW to MWh, are
still the page's.
**The page's DAX has to be right in DAX, not only through the compiler** (2026-10-06): the
Fabric app on VertiPaq sends it to Power BI as written. Where the two would differ, the
query is written for DAX and the compiler gets the case. Found so far: a filter inside
`CALCULATE` replaces the ones around it on the same column, so the KPI deltas and "Right
now"'s generator column (a filter on the fuel it is grouped by) wrap theirs in
`KEEPFILTERS`, which the compiler reads as the filter itself; and a fact's own column does
not filter a dimension, so a query that reads a unit's attribute per unit
(`SELECTEDVALUE(dim_duid[StationName])`) groups by `dim_duid[DUID]`, which the compiler
reads off the fact.

**A figure the model can express is a measure there, the one Power BI calls, and the page
asks for it** (the owner's, 2026-10-05, angrily, on finding that the page worked most of its
figures out itself: "the whole point is to use the same semantic model"; and 2026-10-06, on
finding it still divided measures itself: "if something makes sense to be done using custom
formula then it is fine, but the rule is if the measure can be expressed upstream in the
semantic model then it should be there"). An average, a share, a rate or a factor is never
rebuilt in `index.html` from its parts, least of all one the model already has: for a day
the page bypassed `[Capacity factor]`, `[Renewable share]` and `[Curtailment rate]` because
the compiler could not translate a measure over two facts. When that happens the compiler
gets the case, not the page the formula. A query groups, filters and names measures. What
stays the page's, each for its reason:
- what the model does not hold: rooftop's newest half hour carried forward, and so the
  renewable share up to 30 days, "Right now" and rooftop's average day (their parts are
  measures, the division is in JS);
- the Flows readout: the renewable share of the frame being played, from the unit and
  rooftop rows the animation already holds (a measure would be a query per frame);
- the curtailment total in the chart's title: the farms' table to its newest day plus
  AEMO's regional figures after it, two tables the model has no one measure for;
- shaping rows: rename, `UNION` with rooftop, add up the rows of an additive measure (the
  units of a station or an owner, the stack for a sparkline, the series' averages for the
  total);
- rows as they are stored, which are not figures: the filter lists, the newest interval,
  the Flows rows, the first and last key of a table;
- presentation: a share of what is shown, the change between two values of a measure.
A figure that is not a measure yet becomes one in `model.bim` first. Analyze is not part of
this: it is SQL.

**The Analyze tab is SQL, and only SQL**: its box, the two builders that fill it
(`buildAnalyzeSQL`, `buildGenPriceSQL`) and the `sql` filter helpers they use. It reads the
same views. The compiler never sees text a user typed: `query()` translates what
starts with `EVALUATE`, and only the page's own queries do. Don't make the box accept DAX.

`index.html` is the one file at the top of `dashboard/github/`: it is the site's URL, and `data.js`
finds `data/` from the page's URL. The deployed tree is the repo tree, so a relative import
resolves the same locally and deployed, with one exception: `model.bim` is not in this
folder. Both builds (`build.yml`, `dashboard/fabric_app_wasm/build.mjs`) copy
`semantic_model/model.bim` to `semantic/model.bim`, next to the compiler that fetches it,
and anything that serves the page from the repo has to do the same.
- `dashboard/github/index.html` is the page: charts, and DAX that names the model's tables, columns
  and measures (`fct_summary[mw]`, `dim_duid[FuelSourceDescriptor]`, `[Capture price]`). **It
  joins nothing** and names no view (outside Analyze and `data.has('v_...')`). Which fuels
  are renewable is not in the dashboard at all: `dim_duid[Renewable]` says. The rules it does
  hold are written once, at the top of its section 1, which holds every DAX query the
  charts send (the `dax` object, by tab and chart; the renderers only call it): storage is the fuel "Grid", a
  generator is anything else (a blank fuel included, which DAX and SQL disagree on, so it is
  spelled out), and which grain a date range reads (`grain()`: the 5-minute tables up to 30
  days, the daily ones beyond). The page does not name the table for it: up to 30 days it
  filters and groups by the fact's own columns (`fct_summary[date]`, `fct_region[REGIONID]`),
  beyond by the dimensions' (`dim_calendar[date]`, `dim_duid[DUID]`, `dim_region[Region]`)
  with `dax.wholeDays`, and the same measure reads the 5-minute table or the daily one, as
  the model's `[Reads 5 minutes]` says. Where the two grains are different figures, each is
  its own measure and `grain()` names it: `[Generation MW]` at a time and `[Generation MWh]`
  a day, `[Negative price share]` of intervals and `[Negative price days share]`.
  The filters are DAX too (`dax.whereGen`, `dax.unitFilters`, `dax.wherePrice`,
  `dax.priceFilters`: the arguments of a `CALCULATETABLE`, on the fact's own `date` and on
  the unit's attributes); the `sql` ones next to them are Analyze's.
  **Rooftop solar is not a unit.** It has its own table, which no filter on the units
  reaches, so a query that lists units by fuel or by region adds it as one more branch of a
  `UNION` (`dax.rooftop`, `dax.rooftopInRange`, `dax.withRooftop`): `[Rooftop MW]` at 5
  minutes, `[Rooftop MWh]` per day, under the fuel "Rooftop solar", following the region
  filter, absent when units are picked or another fuel is. What the model does not hold is
  the page's, where it draws: the newest half hour carried forward for up to 55 minutes,
  never past the newest unit interval (`heldRooftop`), and so the renewable share and the
  average day are divided in JS. Rooftop is in no unit list, search or Analyze row.
- `semantic_model/model.bim` is the semantic model, **the same file Power BI runs**
  (see "The Power BI model"): TMSL, compatibility level 1604, every table one Direct Lake
  partition on a `mart` table, single-column relationships, and the measures. It holds DAX
  only: nothing in it is written for DuckDB, and no SQL goes into it, as an annotation or
  otherwise. `.platform` and `definition.pbism` next to it make the folder a Fabric item.
  It is JSON, so a browser reads it with no library: there are no comments, so the why goes
  in a `description`, and a long expression is an array of lines.
- `dashboard/github/semantic/compiler.js` has two parts (`createModel(dataSource)`: the data
  source's members plus `has`, `needs` and `toSQL`). **It is a toy on purpose** (the owner,
  2026-10-05): an example of where that layer of the stack sits, not a DAX engine. It
  translates what this page asks, by fixed cases; it does not plan, and a construct it cannot
  translate gets its equivalent SQL written here, never a general mechanism.
  The model: a view `v_<table>` per table of the model, over the files that are attached
  (the table whole in `dim` or `agg`, or split by date over `today` and the half-years:
  `today` has the days it holds, cut at a literal date; the files are stacked by column
  name, so one built before a column was added reads as NULL in it), and a view per relationship under
  its name (`fct_summary_to_dim_duid`: the fact LEFT JOIN the dimension). It compiles after
  every attach: one query reads what is attached from the engine's catalog
  (`information_schema`), and one runs the statements that are new or changed.
  `needs(sql)` says what a SQL query reads; `ensureHistory` attaches nothing for a range
  that starts inside the days `today` holds, so the default view fetches no history.
  The queries: `toSQL(dax)` turns a DAX query into one SELECT over those views, the same
  text once (a Map). The header of the file lists what each DAX construct becomes. To know:
  - It picks the view from the tables a query names: `fct_summary` alone reads
    `v_fct_summary`, with a column of `dim_duid` the relationship's view.
  - The key of a dimension (`dim_calendar[date]`, `dim_time[time]`, `dim_region[Region]`,
    `dim_duid[DUID]`) is read off the fact's own column: no join for it.
  - The result is cast by the column's `dataType` for the browser: a date as VARCHAR, a
    whole number as INTEGER, a number as DOUBLE. A subquery or a CTE is left as it is.
  - A `[Name]` that is not a column of the table being built is a measure, and its
    expression is written out in its place: there are no macros. Under `CALCULATE` its
    aggregates take the `FILTER (WHERE ...)`.
  - A measure that picks its table, `IF([Reads 5 minutes], a, b)`, picks it here as in
    Power BI: `ISFILTERED` and `ISCROSSFILTERED` are answered from the columns the query's
    keys and filters name around the measure, and an `IF` on one keeps the side it picks;
    the other is never translated. (Until 2026-10-05 it was always `a`, and the page named
    the daily table itself, with figures of its own.)
  - **A measure of another table is a subquery of its own** (2026-10-06). A SELECT is about
    one table, the one its first measure is defined on. A measure defined on another
    (`[Hours]`, the regions', inside `[Capacity factor]`; `[Rooftop MWh]` inside
    `[Renewable share]`; `[Month days]` inside `[Average MW at hour]`) is written as a
    subquery: that measure under the filters around it that reach its table along the
    relationships, grouped by the keys that do and matched on them. It is what the filter
    context does: a filter on `dim_calendar` reaches every fact, one on `dim_duid` or on
    `fct_summary[date]` only the units. For the same reason a filter on another fact is
    left out of the SELECT it does not reach. So a query that calls a two-fact measure
    filters each fact (`dax.whereAll`): up to 30 days `fct_summary[date]`,
    `fct_region[date]` and `dim_calendar[date]`, beyond `dim_calendar[date]` with
    `wholeDays`; and the region on `dim_region[Region]`, which reaches all three.
    The subquery is a CTE, read once per query and looked up per row of the result:
    `[Rooftop MWh]` is on both sides of `[Renewable share]`, and written inline the share
    per day of the whole history took 1.3 s against 0.25.
    A blank from such a subquery is 0, as DAX adds it. Not supported: under a subtotal of
    a key that reaches it. In a measure of the model `<>` is DAX's (`IS DISTINCT FROM`: a
    blank fuel is not "Grid"); in the page's own filters it stays SQL's.
  - Its fixed cases for this model: `[Rooftop MW]` is `SUM(mw)` over `v_fct_rooftop_5min`,
    a view whose SQL is in the file (a half hour and the five times after it on the line
    to the next half hour). The days the daily table lacks, which a measure adds from the
    5-minute table (`late`, an `EXCEPT`), are none: the page restricts a long range to the
    days the daily table holds (`dax.wholeDays`, `dax.wholeRegionDays`), which makes that
    set empty in DAX too. So a long range ends on the newest whole day on the page, and
    on the newest interval in Power BI. `[Units]` off the daily table is
    `COUNT(DISTINCT DUID)`. And `wholeDays` on the daily table itself is not written: as a
    semi-join it cost 100 ms a query to keep every row. `MAX(column, 0)` and
    `MIN(column, 0)` read the column as DOUBLE: a sum of fixed decimals is 128-bit, and
    two of them (output and charging) made the 30-day generation query slower than the
    one sum by sign it replaced (623 ms against 452; 335 as DOUBLE). `[Capacity MW]`,
    the capacity of the units that have rows
    (`CALCULATE(SUM(dim_duid[RegCapMW]), SUMMARIZE(fact, dim_duid[DUID]))`), makes its
    SELECT two levels: the rows per unit first (its sums, its capacity once), then the
    groups asked for (`perUnit`). In one level, as `list(DISTINCT {DUID, RegCapMW})`, the
    capacity factor of 30 days took 2.7 s in the browser against 0.8. And a table's own
    values put on a dimension (`wholeDays`) are a CTE, read once per query: a two-fact
    measure puts that filter on each of its subqueries.
- `storage/data.js` is the host: how the `.duckdb` files are fetched, cached and attached
  (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `query`). It attaches `dim`,
  `today`, `agg` and the 5-minute history, and builds no view. On both the files are
  downloaded whole into OPFS, and the history is the half-year files (`p2026_h1`, ...), the
  ones a range needs. There are two, with the same members:
  - `dashboard/github/storage/data.js`, GitHub Pages: the files sit in `data/` (`mart_dim`, `mart_today`,
    `mart_agg`, `mart_<YYYY>_h<N>`), with `mart_manifest.json` listing the half-years.
  - `dashboard/fabric_app_wasm/site/storage/data.js`, the Fabric app: the files are in a lakehouse behind a
    Fabric sign-in, read with a short-lived read-only SAS, and downloaded as 2 MB Range
    requests, 6 at a time. Its own, and unknown to the page: the sign-in gate (`auth.js`,
    next to it) and the SAS (`sas.js`).
  The Fabric app on VertiPaq has a third, `dashboard/fabric_app_vertipaq/site/storage/data.js`,
  with the same members and none of this: it attaches nothing and sends the DAX to the model.
  The history is never read in place over HTTP: duckdb-wasm reads a remote file one block
  at a time, three round trips each, and OneLake answers one in ~700 ms whatever its size
  (one 2024 day took 38 s that way, 2026-10-04).
  Both set the session to Brisbane time, on purpose: the files carry `date` and `time`, no
  TIMESTAMPTZ, and the only thing the zone decides is that `CURRENT_DATE` is the NEM's day.
- `dashboard/github/storage/history.js` is what both `data.js` share about the half-year history
  files: `periodsForRange` (which ones a date range needs) and `attachCached` (ATTACH from
  OPFS in place, into memory if a second tab holds the file).
- `dashboard/github/frontend/perflog.js` and `dashboard/github/frontend/logs.js` are the Logs tab, on both
  hosts: a table of what this session fetched, attached and ran, with timings, and the build
  stamp. This session only: it lives in the page's memory, nothing is stored, written to a
  file or uploaded, and the Copy button is the one way out. A host's `data.js` does the
  logging (`perf.log`, `perf.time`, and `perf.query` around every query, the compiler's
  included); the page has the tab and its panel, and `logs.js` fills it. A query the page
  wrote in DAX is shown as written, with the SQL it became under it: `query(sql, dax)` in
  both `data.js`, the compiler passing the DAX. An event's `what` is always the SQL, which
  is what a change is checked against; the DAX is its `dax`.

Three things in that design are there for speed and must survive an edit:
- A query that needs nothing about the unit (previous-period generation with no filter, the
  Flows generators, the cutoff) reads the plain fact view, not the relationship's: no join
  to pay for. The compiler does this, from the tables the DAX names: so a query that needs
  nothing of the unit must not name a column of `dim_duid` other than its key, and a unit
  pick is a filter on the fact's own `DUID`.
- The price is on `fct_summary`'s row: capture price and the battery chart join nothing.
- The charts that leave storage out filter on the fuel (`<> "Grid"`), never on
  `NOT (fuel = "Grid")`: with the fuel filter on Grid the optimizer then sees
  `fuel = 'Grid' AND fuel <> 'Grid'` and reads nothing; through `NOT (...)` it does not.
  With a fuel picked the page writes the bare rule (`generatorUnits()`); with none it adds
  `|| ISBLANK(fuel)`, because a unit with no fuel is a generator and SQL would drop it.

How the page looks is decided in five places of `index.html`, and a chart goes through them
rather than round them:
- The chrome is monochrome: surfaces, ink and hairlines are CSS tokens on `:root` (light under
  `[data-theme="light"]`, set by the `<head>` script before first paint: the stored choice,
  else the system's). Colour is for the data and for status, and status comes with an arrow
  or a label. The CSS stays inline: a separate file next to `index.html` would need both
  deploy copy lists (`build.yml`, `dashboard/fabric_app_wasm/build.mjs`).
- `chartTheme()` builds one ECharts theme per scheme from those tokens (font, label size,
  tooltip, legend, zoom slider, colour scale) and `plot()` is every chart's plot area, with
  measured axis labels. A chart sets no margin, font or tooltip style of its own.
- A colour of the data is a pair, `[dark, light]`: `FUEL_COLORS`, `REGION_COLORS`, `PALETTES`.
  The eight fuels that carry the stack were checked pair by pair for colour-blind and normal
  vision; black coal (a neutral) and rooftop solar (a lighter solar) are off the checker's
  bands on purpose. A region keeps its colour on every chart.
- The Dashboard tab leads with "Right now" (`renderNow`): the newest interval from
  `fct_summary` and `fct_region`, with rooftop's newest half hour carried forward, following
  the region filter only. With the pointer on the generation or the price chart (the fuel
  view only) it shows that interval instead (`scrubHero`), from what those charts and the
  Renewables KPI already read: no query of its own.
- **One screen per tab on a desktop** (the owner's, 2026-10-06: no scrolling page). At 1100 px
  wide and 600 tall or more the page does not scroll: each tab is a flex/grid that fills the
  window under the header, and a chart takes its cell's height (`--h` is its height only where
  the page scrolls, below that size). Under 960 tall a compact layout applies (the hero one
  band, the Dashboard's three charts side by side). Charts follow their boxes through a
  `ResizeObserver`. Insights is three sub-pages of four charts (`INSIGHTS_PAGES`) and only the
  one shown is drawn; the Flows board holds each link's small chart in its row; the History
  calendar lays its years out to fill the card; a tab's notes are an (i) popover. A new chart
  goes into a cell of that grid, not under it.

**Checking a change to `model.bim`, `compiler.js`, a `data.js` or the page:** in headless Chrome, the page before against
the page after on one copy of the deployed files, through the same page states; compare what
each chart draws (its ECharts series) and the SQL that ran (the Logs tab has it, translated),
read `EXPLAIN` for a join that was not there, and time
old against new alternately in the same page (two separate sessions differ by more than the
change does). Speed is tracked every time: the total, and any query clearly slower. A
difference of some 10 ms on one query is not worth chasing: on a second run as many go the
other way.

## Dashboard deploy
`build.yml` (index.html, the `frontend/`, `semantic/` and `storage/` folders, dbt docs) and
`import_data.yml` (the .duckdb files)
publish into `NemTracker/nemtracker.github.io` with `scripts/deploy_pages.sh`: a blobless
depth-1 clone, the published paths added with `-f` (so the deploy repo's `.gitignore` can't
skip a file), push retried on a race. It only adds and replaces: a file leaves the site by
hand, in the deploy repo.
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
the whole site near 1 GB (GitHub Pages' limit): the copy is about 880 MB, 2026-10-05. That
is why `fct_summary` is written by date, time, price, DUID: its price is the region's, so
in that order the column is runs and costs nothing, where in key order the files were 60%
larger than the ones before the port.

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

**The Fabric app is `dashboard/fabric_app_wasm/`**, a Rayfin project: static hosting, Fabric sign-in, and one
function, `getDataSas` (`dashboard/fabric_app_wasm/rayfin/functions`), which signs a read-only SAS on the data
folder so that the browser never holds a storage token. `dashboard/fabric_app_wasm/build.mjs` assembles
`dashboard/fabric_app_wasm/dist`: `index.html`, the three folders and `dag/` from `dashboard/github/`,
`semantic_model/model.bim`, with
`dashboard/fabric_app_wasm/site/` copied over them (`storage/data.js`, its own, `storage/auth.js` and
`storage/sas.js`), and
`?v=<build>` added to every relative import; `compiler.js` passes its own on to `model.bim`.
`build.mjs` is the build of both Fabric apps: the project is the working directory, and the
page folders to take besides `frontend/` are its arguments (`semantic storage` here, none
for the VertiPaq app). `site/storage/auth.js` here is the sign-in of both, copied into each.

**It is deployed from the owner's laptop**, under their own login:
```
cd dashboard/fabric_app_wasm
npm ci && npm ci --prefix rayfin/functions
export RAYFIN_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
npx rayfin up --yes --output json
```
The item is `wasm` in workspace `app`, created that way on 2026-10-04;
`dashboard/fabric_app_wasm/rayfin/.deployments.json` (untracked) records it, and its URL is in
`dashboard/fabric_app_wasm/rayfin/rayfin.yml` (`allowedRedirectUris`; the deploy adds it). On a machine without
that record, add `--workspace-id <app>`. A new item needs its secret once, then one more
deploy: `echo <Files URL> | npx rayfin secret set ONELAKE_FILES_URL --stdin`.

**Rayfin lets only the owner of an app item deploy to it**, and the owner is whoever created
it; the owner is also the identity `getDataSas` reads the lakehouse as. That is why the
laptop and CI cannot share an item: a deploy to someone else's fails with
`403 Only AppBackend artifact owner can perform this operation`.

**`deploy_fabric.yml` with `app=wasm` is parked** (dispatch only), waiting for a fix
upstream (with `app=vertipaq` it deploys the other app, below). It runs the
same `rayfin up` with a Fabric API token from the OIDC login, no secret, into an item of its
own (`nemtracker`), and the deploy works. The app it makes does not: Fabric answers 500
("An internal error occurred.") to every function call on an item owned by a service
principal, before the function runs. That is microsoft/rayfin#89, open, with this repo's
case in its comments (2026-10-04). It is not the federated login, which works, and not
permissions: OneLake issues the CI identity a delegation key (the workflow's last step
checks it). The page-only deploy into the owner's item (`rayfin up staticapp deploy`) is no
way round it: owner-only too, the same 403. When #89 is fixed: dispatch the workflow, open
`nemtracker`, read its Logs tab. Keep that item until then: the comment on #89 says it is
there for re-testing. What the workflow took:
- `dashboard/fabric_app_wasm/rayfin/functions/host.json` is committed: the deploy refuses without it, and the
  Rayfin scaffold's `.gitignore` leaves it out.
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

### The Fabric app on VertiPaq (2026-10-06)
`dashboard/fabric_app_vertipaq/` is the same page with the deployed semantic model as its
engine: the page's DAX goes to `nem` as written and Power BI runs it, in Direct Lake over
the `mart` tables. **It talks to Power BI only, and nothing of the DuckDB path is in it**
(the owner's, 2026-10-06): no DuckDB-WASM, no `.duckdb` file, no compiler, no `model.bim`,
no function, no SAS. Its `dist` is `index.html`, `frontend/`, `dag/`, `storage/data.js` and
`storage/auth.js`, and `semantic/compiler.js`, which here is one line
(`createModel = data => data`) standing where the compiler does so that `index.html` is the
same file.
- **How it reaches the model:** a Rayfin connector, `nem` in `rayfin/rayfin.yml` (type
  `fabric-semanticmodel`, one operation, `executeQuery`, delegated). The browser calls the
  app's backend, which runs the query on the model as the signed-in user: the browser holds
  no Power BI token, and a reader sees what their own access to the model allows. A function
  could not do it: functions have no Power BI audience and run as the item's owner.
  The entry is not in the repo's `rayfin.yml`: it holds the workspace and model ids, and
  `rayfin connector add` takes literals only, so the deploy writes it (the model is found
  by its name), as `model.bim`'s ids are written at its deploy.
- **It is meant for workspace `power`**, next to the model (the owner's, 2026-10-06), not
  the other app's tenant, and **it is deployed from CI, as the model is**:
  `deploy_fabric.yml` with `app=vertipaq`, under the catalog's identity (the OIDC login of
  `deploy_model.yml`), into an item `vertipaq`. No laptop and no interactive login: the
  owner's account in that tenant asks for MFA, the service principal does not.
- **`storage/data.js`** has the members the page calls. `query` hands back the shape the
  page reads from DuckDB: Power BI names a column `table[column]` or `[alias]` and the page
  asks for the bare name; a date comes back as a date and time and the page wants the day.
  `has` is always true: the model holds every table. There is no `needs`, which is how the
  page knows to leave the Analyze tab out (it is SQL).
- **A long range still ends on the newest whole day**, as on the other hosts, because the
  page's own filter says so (`wholeDays`).
- **Not deployed: Fabric refuses the item in `power`** (2026-10-06, run 37395788585):
  `403 The feature is not available` when `rayfin up` creates it. The workspace's capacity
  is in Australia Southeast, and Microsoft's region list says of that region "Not
  available: Fabric App (preview)" (Australia East has it); microsoft/rayfin#8 is the same
  answer. It is not this repo's to fix: the app needs a workspace on a capacity in a
  region that has Fabric apps, in the model's tenant (the connector names the model's
  workspace, so the app's can be another one), or the region to get the feature.
- **What that run did prove:** the connector is declared against the model (`Verified
  item: "nem"`), and the model answers DAX on the connector's route to a service
  principal: `rayfin connector invoke nem executeQuery` from the runner returned its row
  (it needs a token for `https://analysis.windows.net/powerbi/api`, not the Fabric one).
  That is Power BI's `executeDaxQueries`, not the `executeQueries` call that answers 401
  to a service principal (see `check_model.py`). A date comes back as
  `2026-10-06T00:00:00.000`, which is what `data.js` expects. Not proven: anything in a
  browser. The deployed page drawing rows is the real check (the delegated path, as the
  signed-in reader, can refuse where the runner's call passed), and whether rayfin#89
  (500 on an item owned by a service principal) reaches connector calls is not known.

A table or a column the page asks for and a deployed file lacks reads as "no data" where
the page checks (`data.has`), so a new page can go out before its data; a new table goes
into `cache_catalog.py`'s lists once it is a dbt model and a table of `model.bim`.
What the charts read beyond 30 days: `fct_summary_daily` and `fct_region_daily` (whole
days: a day is written once the next-day files hold it, so a long range ends on the newest
whole day), `fct_summary_hourly`, `fct_region_hourly` and `dim_month` (hour of day by whole
month, for the daily profile and the price heatmap), and `fct_curtailment` per
semi-scheduled unit and day. After its newest day the curtailment chart reads AEMO's
regional figures from `fct_region` (`wind_available`, `wind_curtailed`, `solar_available`,
`solar_curtailed`), draws those days lighter and leaves them out when units are picked.
Only units on the current registration list have a classification, so semi-scheduled farms
that have left the list are not counted.

## The semantic model, for Power BI and for the dashboard (2026-10-05)
The core of the project is the Iceberg catalog and a semantic model. Four clients are
meant to read it: the two DuckDB-WASM hosts above, the Fabric app on VertiPaq (since
2026-10-06), and Power BI in Direct Lake. The owner's
order: keep the existing tables and the dashboard as they are, add the tables Power BI needs
next to them, deploy the model and check it, and only then port `compiler.js` and the cache
to it (the import ends as a copy with no rule of its own). **All of it is done
(2026-10-05)**: the dashboard reads these tables, through this model, and
`scripts/cache_catalog.py` is the import, a plain copy. The old facts in `landing` stay:
they are what these tables are built from.
- **The tables** are dbt models in schema `mart`, tagged `powerbi`: `fct_summary`,
  `fct_region`, `fct_rooftop`, `fct_interconnector`, `fct_curtailment`, `dim_region`,
  `dim_time`, the aggregates `fct_summary_daily`, `fct_region_daily`, `fct_summary_hourly`,
  `fct_region_hourly` and `dim_month` (and the existing `dim_duid`, `dim_calendar`). Each of
  the new ones is a query that
  the export used to run when it still held rules, written as a model: the raw facts cannot be read by
  Direct Lake as they are (both dispatch runs, an interval under two `file`s, regional data
  split over three tables, no curtailment table at all), and Direct Lake has no view to fix
  that in. `process_data.yml` builds them in a second step, after the landing facts they are
  built from, **and it stays in that workflow**: the dashboard's files are a copy of these
  tables, so the import has to find them built (the owner refused a workflow of its own for
  them, 2026-10-05). A failure of that step fails the job (since 2026-10-05; while the
  dashboard did not read these tables it could not): Import Data only runs after a green
  Process Data, so the dashboard keeps the files it has and the red run says why.
  Dispatched with `debug`, both steps print every statement with its timing.
- **The import is a copy** (the owner, 2026-10-05: "python import for duckdb native file is
  a simple import and has zero logic to it beside maybe splitting per size"). So every table
  the dashboard reads is a dbt model here and a table of the semantic model, its aggregates
  included: per day (`fct_summary_daily`, `fct_region_daily`) and per month and hour of day
  (`fct_summary_hourly`, `fct_region_hourly`, with `dim_month` for the days of a month). An
  aggregate row is written once, when its day or month is whole.
- **What the owner decided about their shape:** MW and price sit on one row at 5 minutes
  (`fct_summary`), because joining two facts at query time is too slow; rooftop is its own
  table, never units; a value that is only held, carried forward or interpolated for drawing
  is the reader's to work out and is never stored; the logic is measures.
- `semantic_model/` is the model, a Fabric item (`model.bim`, `definition.pbism`,
  `.platform`; fabric-cicd finds an item by its `.platform`, whatever the folder is called,
  and `deploy_model.py` publishes a copy of that folder): fourteen tables, each one Direct Lake partition on a `mart`
  table of the `nem` lakehouse, reached through OneLake (no SQL endpoint; Fabric shows
  Direct Lake the Iceberg tables as Delta on its own), single-column relationships, and the
  measures. `{WS_ID}`/`{LH_ID}` in the `DirectLake` expression are placeholders. A measure
  cannot have the name of a column of its table, in any case (`Price` on `fct_region` was
  refused). Rooftop has no unit, so a filter on `dim_duid` does not reach it:
  `[Total generation MWh]` and `[Renewable share]` are for slicing by region or date.
- **A quantity is one measure, and the measure picks the table.** Direct Lake has no
  aggregation tables (user-defined aggregations are not supported), so the switch is DAX:
  `[Generation MWh]`, `[Charging MWh]`, `[Revenue]`, `[Capture price]`, `[Units]` and
  `[Capacity factor]` read `fct_summary_daily` when no time of day is asked for, plus
  `fct_summary` for the days the daily table does not hold yet (`EXCEPT` on the dates), and
  `fct_summary` alone when one is; `[Average price]`, `[Demand MWh]`, `[Net interchange MW]`
  and `[Hours]` do the same over `fct_region_daily` (a day there is 288 intervals).
  "A time of day is asked for" is written once per fact, in a hidden measure
  (`[Reads 5 minutes]`, `[Reads 5 minutes regional]`): any column of `dim_time` filtered or
  grouped, or a column of the fact itself filtered. So filters go through the dimensions.
  **The switch is not there for VertiPaq alone: it is what lets the browser call the same
  measure over a long range**, where it cannot hold the 5-minute rows. For a few hours on
  2026-10-05 the regional measures read `fct_region` alone, on the argument that 4.5M rows
  need no aggregate in VertiPaq; that was judged by one client and undone the same day.
  What the switch is worth in Power BI is timed at every deploy (`check_model.py`, the whole
  history by year and fuel from each table): 0.43 s from the daily table, 1.9 s from the
  5-minute one, the same total (run 37319760193).
  For the number to be the same from either table, the daily table stores the day's sums of
  what the 5-minute measure sums: `output_mwh`, `charging_mwh`, `revenue`. Its `mwh` (net)
  and `price` (the day's average) are not the same numbers (a battery's day nets out, a day
  is priced at its average) and no measure reads them: they were the page's long-range
  figures until 2026-10-05, and Analyze's SQL still lists them. The hour-of-day tables are
  not switched to: `[Output MWh hourly]`, `[Average MW at hour]` and `[Price at hour]` name
  them, as `[Negative price days share]`, `[Lowest daily price]` and `[Average MWh a day]`
  name the daily tables: a share of days is not a share of intervals.
  **An average MW is energy over `[Hours]`** (2026-10-06): `[Average generation MW]`,
  `[Average total generation MW]` (with rooftop), `[Average rooftop MW]`,
  `[Average demand MW]`. The hours are the regions' (the intervals the price data holds),
  nights included, so rooftop's average over 3 days is its energy over 72 hours, not over
  its daylight intervals as the page's KPI had it. `[Capacity MW]` is the registered
  capacity of the units with output, which `[Capacity factor]` divides by;
  `[Renewable share of units]` is the share without rooftop, for when units are picked.
- **Rooftop at 5 minutes is a measure**, `[Rooftop MW]`: only the half-hourly estimate is
  stored, and the measure draws the straight line between two consecutive half hours
  (nothing across a missing one). The newest value is not held forward: that is the chart's.
- **The report is `dashboard/powerbi/nem.Report`**, in PBIR (a JSON file per page and per
  visual; schema versions and base theme as Power BI Desktop wrote them in 2026). One page,
  "Overview": the model's measures by day, fuel, region and station, over the last 30 days
  (a page filter). It holds no measure of its own, and its filters are on the dimensions, so
  the measures read the daily tables. `definition.pbir` names the model by its path in the
  repo (`../../../semantic_model`); fabric-cicd turns that into the deployed model's id, so
  `deploy_model.py` copies the two to the same places relative to each other. No `.pbip`:
  the model's lakehouse ids are placeholders here, so Desktop could not open it. Nothing in
  CI sees a chart draw: a change to a visual is checked by opening the report.
- `deploy_model.yml` (dispatch only) publishes the model and the report into the catalog's
  workspace with
  `scripts/deploy_model.py` (fabric-cicd; the owner asked for it, not duckrun) and runs
  `scripts/check_model.py`: a refresh, then a row count per table and each measure per day
  for the newest week (the measures of the tables by month per month: a date does not
  filter those tables), then that the report is there and reads the model. A table or a column the model
  names has to exist before a deploy: the refresh fails on it and leaves the deployed model
  broken until the next good one. And a dispatched `process_data.yml` can be cancelled by
  the next scheduled run queueing behind it (one concurrency group), so read its conclusion
  and its Power BI step before deploying on the strength of it.
- **The check asks its DAX over XMLA** (ADOMD.NET under pythonnet), not the REST
  `executeQueries` call: that one answers 401 `PowerBINotAuthorizedException` to a service
  principal on this model, as Contributor and as Admin. Its reference page says service
  principals are not supported on a model with single sign-on. The same token is accepted
  over XMLA.
- **Before the port, the model was held to the old dashboard's deployed files**
  (`scripts/parity_model.py`, deleted with them: it is in git at `b2572d0`), at the
  grains the dashboard draws: per day (by region, by fuel, by link) for the newest five
  settled days, per 5-minute time for the newest of them, and per hour of day for the two
  newest whole months. The per-day figures come from the daily tables and the per-time ones
  from the 5-minute tables, through the same measures, so it is also the check that the
  switch gives one number. The dashboard's long-range figures (net energy of the day, the
  day's average price) are checked as columns of the daily tables (`LONG_RANGE`).
  **2026-10-05, deploy run 37285256636: 25,737 values equal, none different** (30 Sep to
  4 Oct; August and September by hour), slowest model query 0.6 s. Known and not compared:
  rooftop's capture price, half-hourly in the model and 5-minute in the dashboard (mean
  1.14 $/MWh apart). Compared to within a cent or five: capture prices and revenue, because
  `fct_summary` keeps MW to 4 decimals and the dashboard's files a REAL.
- **Three things that cost a deploy each, 2026-10-05:** the first `[Rooftop MW]` did not
  parse (`SYNTAXERROR`) with variables named `d`, `m`, `r`, `step`, `before`, `after`, and
  did once they had a leading underscore (which name it was is not known); dividing a
  fixed-decimal column gives a fixed decimal, 4 places (`SUMX(...) / 12` on `mw`: hence
  `CONVERT(..., DOUBLE)`); and a filter set inside `CALCULATE` on one column of a dimension
  does not remove the query's filter on another column of it (`[Rooftop MW]` removes the
  filters on `dim_time` and `dim_calendar` first). And Fabric takes some minutes to show a
  recreated Iceberg table to Direct Lake: a refresh 2.5 and 5 minutes after a
  `rebuild=fct_summary_daily` answered `DirectLake_TableNotFound`, at 7 minutes it passed.

## Models (24)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) — only rows missing from the target; the durable log is `Files/csv_archive_log.parquet` |
| processed_files | landing | incremental append — the files each landing fact has loaded (`model, csv_filename, processed_at`), appended by the facts' post-hooks; the pending check is the log minus this table. A `rebuild=<fact>` appends a reset row (`csv_filename` NULL); the first build seeds it from the facts' `file` columns |
| dim_calendar | mart | incremental append (the NOT-IN filter keeps existing dates out; runs 2 years ahead) |
| dim_duid | mart | incremental insert-only merge on DUID; NEM units from the registration list, then `duid_unregistered.csv`; registered capacity (RegCapMW etc.); `Renewable` — **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind"; `CO2eFactor` (t CO2-e/MWh) from MMSDM `GENUNITS` through `DUALLOC`, for registered and unregistered units alike, NULL for loads, AEMO's dummy units and the gensets "On Exclusion List" (Colongra, Jeeralang, Braemar 3 and 6), which `[Emissions t]` therefore leaves out. A new column or a changed rule reaches the existing rows with a `rebuild=dim_duid` |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so `fct_interconnector` takes one row per interval (`MAX … GROUP BY`); the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/availability/cleared MW. History's demand/net interchange come from fct_price's DREGION rows |
| fct_summary | mart | incremental insert-only merge on (date, time, DUID) — the Power BI fact: `fct_scada` joined to `dim_duid` and `fct_price` (inner joins), then the intraday feed after the newest daily interval, for the units the daily files know (`dispatch_duids`). Every run recomputes the newest daily date minus six days on; missing keys are added, a stored value is never revised. The dates come from the Iceberg manifests and are written as literals (no scan to find them); a refill takes `process_limit` dates below the oldest it holds, newest first. `rebuild=fct_summary` resets it |
| fct_region | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: price, demand, net interchange and the regional semi-scheduled wind and solar. The intraday record where `fct_price_today` and `fct_regionsum_today` both have the interval, else `fct_price`'s. Recomputed whole every run (4.5M rows); the merge adds what is missing |
| fct_rooftop | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: the `MEASUREMENT` estimate per region and half hour as published (zeros kept, blanks out), with the half hour's average price from `fct_region`; written once its six prices exist |
| fct_interconnector | mart | incremental insert-only merge on (interconnector, date, time) — for Power BI: `MWFLOW` and the two limits, the pricing run, one row per interval |
| fct_curtailment | mart | incremental insert-only merge on (DUID, date) — for Power BI: curtailed and available MWh per semi-scheduled unit and day. A day is written once `fct_scada` holds its 288 intervals: the days after the newest one here, and in a refill `process_limit` days below the oldest, newest first (`macros/whole_days.sql`) |
| dim_region | mart | incremental insert-only merge on Region — for Power BI: the regions of `dim_duid`, the one filter that reaches units, regional data and rooftop |
| dim_interconnector | mart | incremental insert-only merge on interconnector — the links between regions of `dim_region` (from MMSDM `INTERCONNECTOR`): `from_region`/`to_region` (a positive `mw` flows from the first to the second) and AEMO's `description`. The Flows page names a link by its id on the map and by the description on its board; only the bend of each arc is typed there (`LINK_CURVES`) |
| dim_time | mart | incremental insert-only merge on time — the 288 5-minute times of a day (`time` HHMM, `minute`, `hour`): the time axis of the 5-minute facts, and what the measures look at to choose a table |
| fct_region_daily | mart | incremental insert-only merge on (REGIONID, date) — the plain average of a day's 288 intervals of `fct_region` (price, demand, net interchange); a day is written once it has all 288 |
| fct_summary_daily | mart | incremental insert-only merge on (DUID, date) — `fct_summary` per unit and day, written once `fct_scada` holds the day whole (`macros/whole_days.sql`: the days after the newest one here; in a refill `process_limit` days below the oldest, newest first, never below `fct_summary`'s oldest): `output_mwh`, `charging_mwh`, `revenue` (the sums the measures switch to) and `mwh` net with the region's daily `price` (no measure reads those two; Analyze lists them). Inner join to `fct_region_daily` |
| dim_month | mart | incremental insert-only merge on month — the whole months of `fct_summary_daily` with their number of days |
| fct_summary_hourly | mart | incremental insert-only merge on (DUID, month, hour) — output energy per unit, whole month and hour of day (`time // 100`), 12 months per run |
| fct_region_hourly | mart | incremental insert-only merge on (REGIONID, month, hour) — average price per region, whole month and hour of day, with the number of intervals averaged |
| fct_rooftop_pv | landing | incremental insert-only merge (by file) — rooftop solar per region and half hour, AEMO's `ROOFTOP_PV_ACTUAL` estimate **kept as published**: the current folder, the monthly MMSDM archive 2018-01 → 2026-08 and the weekly archives after it. The monthly files from 2024-08 swap `QI` and `LASTCHANGED`; the model reads each file's `I` row to tell |

**Rooftop solar is a table of its own, `fct_rooftop`, never units.** AEMO's `MEASUREMENT`
estimate per region and half hour, as published (it starts 2018-03-06); a blank (`QI = 0`)
is missing, not zero. Nothing held, carried forward or interpolated is stored: the model's
`[Rooftop MW]` draws the straight line between two consecutive half hours (nothing across a
missing one), and the page carries the newest half hour forward where it draws (the next
estimate lands 30 to 60 minutes late). On the generation chart the dashed Demand line is
operational demand **plus** the rooftop in the stack. AEMO's data model 5.6 report says
`ROOFTOP_PV_ACTUAL` will be removed in a later release in favour of
`ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute), neither published yet: when the current folder
stops updating, that is the replacement to move to.

`dim_duid`'s insert-only merge means attribute changes (region/fuel/geo) never update in
place. **Rebuilding a table = dispatch `process_data.yml` with `rebuild=<table>`**: it runs
`scripts/rebuild_table.py` (DROP, names checked against `scripts/iceberg_tables.py`) and the
dbt run that follows recreates the table with a plain CTAS, refilling at `process_limit`
files per run (for a landing fact the script also appends the reset row to
`processed_files`, which is what makes its files pending again; a mart table refills from
the oldest date it holds, see Architecture point 3). It also works on a table the catalog
can no longer serve (the pre-drop count is best-effort). Do not use `dbt run --full-refresh`: dbt-duckdb builds `<table>__dbt_tmp` and
RENAMEs it into place, and RENAME has never been probed against this catalog. A model change
that adds a column to an existing table goes out together with its rebuild, not ahead of it:
the semantic model would name a column the catalog doesn't have, and dbt would try an ALTER TABLE
that has never been probed either.

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
  then vanish. Before the port the dashboard showed them for its last 5 days (about 450 MW
  on the default view, 2026-10-05). `fct_scada_today` drops the 0 MW rows at load,
  `fct_scada` keeps them and `fct_summary` leaves them out.
- **What the `mart` models apply to the raw facts** (it was the export's, and a reader of
  the `landing` tables has to redo it): `INTERVENTION = 0` only (the pricing run); 0 MW rows
  left out; one row per key, because `file` is part of every merge key in `landing` and an
  interval can be there from two files; interconnector `mw` is the dispatch target `MWFLOW`,
  not `METEREDMWFLOW`; energy is `SUM(mw) / 12`; `date` is the calendar date of the
  interval's end and `time` its HHMM; daily price and demand are plain averages of the
  intervals.
- Pre-hooks set DuckDB VARIABLEs with the file paths to process, read from the log table
- **Every file a model reads is a dbt source** (`models/sources.yml`, dbt-duckdb
  `external_location`), so the lineage graph shows it. `aemo.*` compiles to the fact model's
  `getvariable('…_paths')`, `duid_reference.*` to the file's path under `Files/csv/duid/`.
  They are not tables — the variable only exists inside its model, so no tests or freshness
  on them. The variable is there because DuckDB has no manifest: `read_csv` takes a constant
  list or a glob, not a subquery, and a glob lists the whole folder whatever the `filename`
  filter (measured on the 2.0 pin). Asked upstream in duckdb/duckdb-aws-glue#37 (`hive_scan`
  over a symlink manifest)
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
  pin `duckdb==2.0.0.dev2609250715`** (dbt via `requirements.txt`, which also pins
  `dbt-core`/`dbt-duckdb` exactly — the insert-only merges lean on adapter internals). The
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
  `attachCached` (`dashboard/github/storage/history.js`) read the OPFS-cached files in place
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
