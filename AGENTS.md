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
- **Schemas:** `mart` (dim_calendar, dim_duid) / `landing` (facts, staging)
- **Writes are insert-only merges** (`WHEN MATCHED DO NOTHING`): the OneLake catalog accepts
  one add-snapshot per commit and rejects commits mixing delete files + data files
  (BadRequest 400). Same pattern as the sibling repo (dbt-fabric). `dim_calendar` is a plain
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
Three deliberate local differences, all of which must survive a port:
- No `relationships → dim_duid` tests on `fct_scada`/`fct_scada_today` — `dim_duid` holds the
  registered DUIDs plus the unlisted ones that generated, while the facts go back to 2018 and
  also carry units only ever dispatched at 0 MW, so the test could never be 0.
  `tests/assert_recent_scada_duids_registered.sql` is the meaningful version and is this
  repo's own.
- `tests/assert_all_*_files_processed_*.sql` use `NOT EXISTS` and are untagged; the sibling's
  use `NOT IN` (a single NULL `file` makes them permanently green) and are tagged `heavy`.
- `profiles.yml` keeps a `ci` target (plain DuckDB, no Iceberg; `build.yml` gives it a file,
  `ci.duckdb`), and `dbt_project.yml`'s `on-run-start` hooks are guarded with
  `target.name != 'ci'` — the sibling's are unconditional and would break that target.

## Architecture
1. `stg_csv_archive_log.py` (Python model) downloads AEMO + GitHub data and archives the
   gzipped CSVs **to OneLake Files** (`FILES_PATH`, i.e. the `nem` lakehouse's `Files/csv/`),
   alongside a durable `Files/csv_archive_log.parquet`. The archive is durable, so there is no
   reconciliation code: an interrupted run is picked up by the next one.
2. **No daily/intraday split.** Every 30-minute pass does every feed (the daily files,
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
3. Work is discovered from the **log table**, not a filesystem glob: each fact model's pre-hook
   (`macros/pending_archive_files.sql`) builds its path list from
   `SELECT DISTINCT stg_csv_archive_log.archive_path` filtered by `NOT EXISTS` against
   `{{ this }}.file` (not `NOT IN`: one NULL `file` would stop every load), newest first
   (`ORDER BY archive_path DESC LIMIT process_limit`; that is path order, so newest first
   within a source folder, and for a model that reads several folders one folder after the
   other). A file counts as loaded once the fact holds a row of it: one that yields no row
   stays pending and is read again every run. The DISTINCT is load-bearing: the log table is
   append-only and can hold a file more than once, and MERGE only dedupes against the target,
   never within a batch — without it a backlog is read 2-N times per batch and turns into
   duplicate keys.
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
   optimistically, so an overlap with a load could fail one side. It is `continue-on-error`
   and both scripts always exit 0: maintenance must never fail its workflow (a red run there
   means a dbt test failed). The price of that is that a compaction that has stopped working
   only shows in the job's log. Both scripts read their table list from
   `scripts/iceberg_tables.py`; a new model gets added there once.

## Don't design anything that needs DELETE
Every write is an append. On OneLake a commit may carry only one add-snapshot, so anything
that mixes delete files with data files is rejected outright (`BadRequest 400`) — hence the
insert-only merges. Design the path so it needs no `DELETE`, and never assume one landed —
re-count and log the delta.

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
The dashboard has the layers of a BI stack, each in its own place under `dashboard/` (the
table of what stands in each place in a real product is in `ARCHITECTURE.md`), and two hosts:
GitHub Pages and a Fabric app. Everything is the same file on both except `storage/data.js`.
- consumer: `index.html`
- query language: DAX, written in the page
- semantic model: `semantic/model.bim`, a Tabular model in TMSL
- compiler: `semantic/compiler.js`, the model to views and the DAX to SQL
- engine: DuckDB-WASM
- storage: `storage/data.js`, `storage/history.js`
- and the Logs tab, `frontend/`

**It is a proof of concept (2026-10-05); the point is that the layers are there, in the
formats of a real product.** The compiler is not a DAX engine. It knows the constructs the
page uses and throws on anything else (`DAX: X is not supported`), and where DAX and SQL
differ the result is SQL's: a blank is a NULL, a group whose measures are all blank is kept,
and there is no filter context (a filter is a boolean argument of `CALCULATETABLE` or
`CALCULATE`). A chart that needs a new construct gets it in `compiler.js`, as one more case;
don't grow it into a general engine. Of the rules a query compiler applies on its own, it
applies one, when a join is needed (below); which grain to read and MW to MWh are still the
page's.

**The Analyze tab is SQL, and only SQL**: its box, the two builders that fill it
(`buildAnalyzeSQL`, `buildGenPriceSQL`) and the `sql` filter helpers they use. It reads the
same views. The compiler never sees text a user typed: `query()` translates what
starts with `EVALUATE`, and only the page's own queries do. Don't make the box accept DAX.

`index.html` is the one file at the top of `dashboard/`: it is the site's URL, and `data.js`
finds `data/` from the page's URL. The deployed tree is the repo tree, so a relative import
resolves the same locally and deployed.
- `dashboard/index.html` is the page: charts, and DAX that names the model's tables, columns
  and measures (`fct_summary[mw]`, `dim_duid[FuelSourceDescriptor]`, `[Capture price]`). **It
  joins nothing** and names no view (outside Analyze and `data.has('v_...')`). Which fuels
  are renewable is not in the dashboard at all: `dim_duid[Renewable]` says. The rules it does
  hold are written once, at the top of its section 5: storage is the fuel "Grid", a
  generator is anything else (a blank fuel included, which DAX and SQL disagree on, so it is
  spelled out), and which grain a date range reads (`grain()`: the 5-minute tables up to 30
  days, the daily ones beyond, as columns of `fct_summary_daily` and `fct_region_daily`).
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
- `dashboard/semantic/model.bim` is the semantic model, **the same file Power BI runs**
  (see "The Power BI model"): TMSL, compatibility level 1604, every table one Direct Lake
  partition on a `mart` table, single-column relationships, and the measures. It holds DAX
  only: nothing in it is written for DuckDB, and no SQL goes into it, as an annotation or
  otherwise. `.platform` and `definition.pbism` next to it make the folder a Fabric item.
  It is JSON, so a browser reads it with no library: there are no comments, so the why goes
  in a `description`, and a long expression is an array of lines.
- `dashboard/semantic/compiler.js` has two parts (`createModel(dataSource)`: the data
  source's members plus `has`, `needs` and `toSQL`). **It is a toy on purpose** (the owner,
  2026-10-05): the example of the one layer of the stack with no open-source equivalent. It
  translates what this page asks, by fixed cases; it does not plan, and a construct it cannot
  translate gets its equivalent SQL written here, never a general mechanism.
  The model: a view `v_<table>` per table of the model, over the files that are attached
  (the table whole in `dim` or `agg`, or split by date over `today` and the half-years:
  `today` has the days it holds, cut at a literal date), and a view per relationship under
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
  - Its fixed cases for this model: `[Rooftop MW]` is `SUM(mw)` over `v_fct_rooftop_5min`,
    a view whose SQL is in the file (a half hour and the five times after it on the line
    to the next half hour); and a measure that picks its table,
    `IF([Reads 5 minutes], a, b)`, is `a`: the page filters the fact's own date column,
    which is what makes it true in DAX too, and names the daily table itself.
- `storage/data.js` is the host: how the `.duckdb` files are fetched, cached and attached
  (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `query`). It attaches `dim`,
  `today`, `agg` and the 5-minute history, and builds no view. On both the files are
  downloaded whole into OPFS, and the history is the half-year files (`p2026_h1`, ...), the
  ones a range needs. There are two, with the same members:
  - `dashboard/storage/data.js`, GitHub Pages: the files sit in `data/` (`mart_dim`, `mart_today`,
    `mart_agg`, `mart_<YYYY>_h<N>`), with `mart_manifest.json` listing the half-years.
  - `fabric/site/storage/data.js`, the Fabric app: the files are in a lakehouse behind a
    Fabric sign-in, read with a short-lived read-only SAS, and downloaded as 2 MB Range
    requests, 6 at a time. Its own, and unknown to the page: the sign-in gate (`auth.js`,
    next to it).
  The history is never read in place over HTTP: duckdb-wasm reads a remote file one block
  at a time, three round trips each, and OneLake answers one in ~700 ms whatever its size
  (one 2024 day took 38 s that way, 2026-10-04).
  Both set the session to Brisbane time, on purpose: the files carry `date` and `time`, no
  TIMESTAMPTZ, and the only thing the zone decides is that `CURRENT_DATE` is the NEM's day.
- `dashboard/storage/history.js` is what both `data.js` share about the half-year history
  files: `periodsForRange` (which ones a date range needs) and `attachCached` (ATTACH from
  OPFS in place, into memory if a second tab holds the file).
- `dashboard/frontend/perflog.js` and `dashboard/frontend/logs.js` are the Logs tab, on both
  hosts: a table of what this session fetched, attached and ran, with timings, and the build
  stamp. This session only: it lives in the page's memory, nothing is stored, written to a
  file or uploaded, and the Copy button is the one way out. A host's `data.js` does the
  logging (`perf.log`, `perf.time`, and `perf.query` around every query, the compiler's
  included); the page has the tab and its panel, and `logs.js` fills it.

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

How the page looks is decided in four places of `index.html`, and a chart goes through them
rather than round them:
- The chrome is monochrome: surfaces, ink and hairlines are CSS tokens on `:root` (light under
  `[data-theme="light"]`, set by the `<head>` script before first paint: the stored choice,
  else the system's). Colour is for the data and for status, and status comes with an arrow
  or a label. The CSS stays inline: a separate file next to `index.html` would need both
  deploy copy lists (`build.yml`, `fabric/build.mjs`).
- `chartTheme()` builds one ECharts theme per scheme from those tokens (font, label size,
  tooltip, legend, zoom slider, colour scale) and `plot()` is every chart's plot area, with
  measured axis labels. A chart sets no margin, font or tooltip style of its own.
- A colour of the data is a pair, `[dark, light]`: `FUEL_COLORS`, `REGION_COLORS`, `PALETTES`.
  The eight fuels that carry the stack were checked pair by pair for colour-blind and normal
  vision; black coal (a neutral) and rooftop solar (a lighter solar) are off the checker's
  bands on purpose. A region keeps its colour on every chart.
- The Dashboard tab leads with "Right now" (`renderNow`): the newest interval from
  `fct_summary` and `fct_region`, with rooftop's newest half hour carried forward, following
  the region filter only.

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
skip a file), push retried on a race; `DEPLOY_REMOVE` is the one way a file leaves the site.
**The files are a copy of the `mart` tables, with no rule of their own**
(`scripts/copy_catalog.py`: `SELECT *` per table, into `mart_dim`, `mart_agg`, `mart_today`
and `mart_<YYYY>_h<N>`). Every run copies the newest 14 days; the daily run also copies the
dimensions, the aggregates whole, and the latest two half-years: older half-year files stay
as deployed. Dispatch `import_data.yml` with `all_periods=true` after a backfill that
touched older data. The manifest of half-year files is built last, from the files actually
in the deploy repo; an empty listing fails the step instead of publishing an empty manifest.
`squash_deploy_repo.yml` (weekly, Sunday 17:00 UTC, also dispatchable) replaces the deploy
repo's history with one commit of its current tree (`scripts/squash_deploy_repo.sh`,
force-with-lease): `mart_today.duckdb` is redeployed every 30 min, and the kept copies would
otherwise grow the repo by gigabytes a week. The site is unchanged; GitHub reclaims the
space on its own schedule.
A half-year must stay under 100 MB (GitHub's limit for a file; the build fails over it) and
the whole site near 1 GB (GitHub Pages' limit): the copy is about 880 MB, 2026-10-05. That
is why `fct_summary` is written by date, time, price, DUID: its price is the region's, so
in that order the column is runs and costs nothing, where in key order the files were 60%
larger than the ones before the port.

**The same files also go to OneLake**, for the Fabric app (the same page, hosted in Fabric,
reading a lakehouse in another tenant — workspace `app`, lakehouse `data`).
`import_onelake.yml` (daily, 22:30 UTC) runs the same `copy_catalog.py` steps and publishes
with `scripts/deploy_onelake.py`. It builds the same files, with one difference: it sets
`ALL_PERIODS=true`, so every run copies all the history (OneLake keeps two whole imports and
has no deployed copy to add to). The build fails on both if a half-year file
outgrows 100 MB, GitHub's limit for a file.
On OneLake the files are `dim_`/`today_`/`agg_<ts>.duckdb` and `<YYYY>_h<N>_<ts>.duckdb`;
`latest.json` (`{"ts", "periods"}`), written last, names the current import, and the files
of two imports are kept so that an open page keeps reading the one it attached. The page's
OPFS cache keeps one import, so each daily import downloads a half-year again the first time
it is viewed.

**The Fabric app is `fabric/`**, a Rayfin project: static hosting, Fabric sign-in, and one
function, `getDataSas` (`fabric/rayfin/functions`), which signs a read-only SAS on the data
folder so that the browser never holds a storage token. `fabric/build.mjs` assembles
`fabric/dist`: `index.html`, the three folders and `dag/` from `dashboard/`, with
`fabric/site/` copied over them (`storage/data.js`, its own, and `storage/auth.js`), and
`?v=<build>` added to every relative import; `compiler.js` passes its own on to `model.bim`.

**It is deployed from the owner's laptop**, under their own login:
```
cd fabric
npm ci && npm ci --prefix rayfin/functions
export RAYFIN_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
npx rayfin up --yes --output json
```
The item is `wasm` in workspace `app`, created that way on 2026-10-04;
`fabric/rayfin/.deployments.json` (untracked) records it, and its URL is in
`fabric/rayfin/rayfin.yml` (`allowedRedirectUris`; the deploy adds it). On a machine without
that record, add `--workspace-id <app>`. A new item needs its secret once, then one more
deploy: `echo <Files URL> | npx rayfin secret set ONELAKE_FILES_URL --stdin`.

**Rayfin lets only the owner of an app item deploy to it**, and the owner is whoever created
it; the owner is also the identity `getDataSas` reads the lakehouse as. That is why the
laptop and CI cannot share an item: a deploy to someone else's fails with
`403 Only AppBackend artifact owner can perform this operation`.

**`deploy_fabric.yml` is parked** (dispatch only), waiting for a fix upstream. It runs the
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
- `fabric/rayfin/functions/host.json` is committed: the deploy refuses without it, and the
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

A table or a column the page asks for and a deployed file lacks reads as "no data" where
the page checks (`data.has`), so a new page can go out before its data; a new table goes
into `copy_catalog.py`'s lists once it is a dbt model and a table of `model.bim`.
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
The core of the project is the Iceberg catalog and a semantic model. Three consumers are
meant to read it: the two DuckDB-WASM hosts above, and Power BI in Direct Lake. The owner's
order: keep the existing tables and the dashboard as they are, add the tables Power BI needs
next to them, deploy the model and check it, and only then port `compiler.js` and the cache
to it (the import ends as a copy with no rule of its own). **All of it is done
(2026-10-05)**: the dashboard reads these tables, through this model, and
`scripts/copy_catalog.py` is the import, a plain copy. The old facts in `landing` stay:
they are what these tables are built from.
- **The tables** are dbt models in schema `mart`, tagged `powerbi`: `fct_summary`,
  `fct_region`, `fct_rooftop`, `fct_interconnector`, `fct_curtailment`, `dim_region`,
  `dim_time`, the aggregates `fct_summary_daily`, `fct_region_daily`, `fct_summary_hourly`,
  `fct_region_hourly` and `dim_month` (and the existing `dim_duid`, `dim_calendar`). Each of
  the new ones is a query that
  the old export (`cache_catalog.py`, gone) ran, written as a model: the raw facts cannot be read by
  Direct Lake as they are (both dispatch runs, an interval under two `file`s, regional data
  split over three tables, no curtailment table at all), and Direct Lake has no view to fix
  that in. `process_data.yml` builds them in a second step, after the tables the dashboard
  reads; that step cannot fail the job, **and it stays in that workflow**: DuckDB will read
  these tables too, so the import has to find them built (the owner refused a workflow of
  its own for them, 2026-10-05).
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
- `dashboard/semantic/` is the model, a Fabric item (`model.bim`, `definition.pbism`,
  `.platform`; fabric-cicd finds an item by its `.platform`, whatever the folder is called,
  and `deploy_model.py` publishes a copy of those three files only): fourteen tables, each one Direct Lake partition on a `mart`
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
  `fct_summary` alone when one is; `[Average price]`, `[Demand MWh]` and
  `[Net interchange MW]` do the same over `fct_region_daily` (a day there is 288 intervals).
  "A time of day is asked for" is written once per fact, in a hidden measure
  (`[Reads 5 minutes]`, `[Reads 5 minutes regional]`): any column of `dim_time` filtered or
  grouped, or a column of the fact itself filtered. So filters go through the dimensions.
  For the number to be the same from either table, the daily table stores the day's sums of
  what the 5-minute measure sums: `output_mwh`, `charging_mwh`, `revenue`. Its `mwh` (net)
  and `price` (the day's average) are the dashboard's long-range figures, which are not the
  same numbers (a battery's day nets out, a day is priced at its average) and are not
  measures of this model. The hour-of-day tables are not switched to: `[Output MWh hourly]`,
  `[Average MW at hour]` and `[Price at hour]` name them.
- **Rooftop at 5 minutes is a measure**, `[Rooftop MW]`: only the half-hourly estimate is
  stored, and the measure draws the straight line between two consecutive half hours
  (nothing across a missing one). The newest value is not held forward: that is the chart's.
- `deploy_model.yml` (dispatch only) publishes it into the catalog's workspace with
  `scripts/deploy_model.py` (fabric-cicd; the owner asked for it, not duckrun) and runs
  `scripts/check_model.py`: a refresh, then a row count per table and each measure per day
  for the newest week. A table or a column the model
  names has to exist before a deploy: the refresh fails on it and leaves the deployed model
  broken until the next good one. And a dispatched `process_data.yml` can be cancelled by
  the next scheduled run queueing behind it (one concurrency group), so read its conclusion
  and its Power BI step before deploying on the strength of it.
- **The check asks its DAX over XMLA** (ADOMD.NET under pythonnet), not the REST
  `executeQueries` call: that one answers 401 `PowerBINotAuthorizedException` to a service
  principal on this model, as Contributor and as Admin. Its reference page says service
  principals are not supported on a model with single sign-on. The same token is accepted
  over XMLA.
- **`scripts/parity_model.py` held the model to the dashboard's deployed files, before the
  port** (it is no longer a step of the deploy: those files were the old export's and left
  the site with it; the script is kept as the record of how it was compared), at the
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

## Models (22)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) — only rows missing from the target; the durable log is `Files/csv_archive_log.parquet` |
| dim_calendar | mart | incremental append (the NOT-IN filter keeps existing dates out; runs 2 years ahead) |
| dim_duid | mart | incremental insert-only merge on DUID; NEM units from the registration list, then `duid_unregistered.csv`; registered capacity (RegCapMW etc.); `Renewable` — **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind". A new column or a changed rule reaches the existing rows with a `rebuild=dim_duid` |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so readers take `ANY_VALUE … GROUP BY`. Exported as `interconnector` in the half-year files; the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/availability/cleared MW. History's demand/net interchange come from fct_price's DREGION rows |
| fct_summary | mart | incremental insert-only merge on (date, time, DUID) — the Power BI fact: `fct_scada` joined to `dim_duid` and `fct_price` (inner joins), then the intraday feed after the newest daily interval, for the units the daily files know (`dispatch_duids`). Every run recomputes the dates still in flux; missing keys are added, a stored value is never revised. Dates it has never seen are taken newest first, `process_limit` per run (the one difference from the example's file: uncapped, the first build ran the runner out of memory). `rebuild=fct_summary` resets it |
| fct_region | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: price, demand, net interchange and the regional semi-scheduled wind and solar. The intraday record where `fct_price_today` and `fct_regionsum_today` both have the interval, else `fct_price`'s. Recomputed whole every run (4.5M rows); the merge adds what is missing |
| fct_rooftop | mart | incremental insert-only merge on (REGIONID, date, time) — for Power BI: the `MEASUREMENT` estimate per region and half hour as published (zeros kept, blanks out), with the half hour's average price from `fct_region`; written once its six prices exist |
| fct_interconnector | mart | incremental insert-only merge on (interconnector, date, time) — for Power BI: `MWFLOW` and the two limits, the pricing run, one row per interval |
| fct_curtailment | mart | incremental insert-only merge on (DUID, date) — for Power BI: curtailed and available MWh per semi-scheduled unit and day. A day is written once `fct_scada` holds its 288 intervals, `process_limit` days per run, newest first |
| dim_region | mart | incremental insert-only merge on Region — for Power BI: the regions of `dim_duid`, the one filter that reaches units, regional data and rooftop |
| dim_time | mart | incremental insert-only merge on time — the 288 5-minute times of a day (`time` HHMM, `minute`, `hour`): the time axis of the 5-minute facts, and what the measures look at to choose a table |
| fct_region_daily | mart | incremental insert-only merge on (REGIONID, date) — the plain average of a day's 288 intervals of `fct_region` (price, demand, net interchange); a day is written once it has all 288 |
| fct_summary_daily | mart | incremental insert-only merge on (DUID, date) — `fct_summary` per unit and day, written once `fct_scada` holds the day whole (`macros/whole_days.sql`), `process_limit` days per run, newest first: `output_mwh`, `charging_mwh`, `revenue` (the sums the measures switch to) and `mwh` net with the region's daily `price` (the dashboard's long-range figures). Inner join to `fct_region_daily` |
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
files per run. It also works on a table the catalog can no longer serve (the pre-drop count
is best-effort). Do not use `dbt run --full-refresh`: dbt-duckdb builds `<table>__dbt_tmp` and
RENAMEs it into place, and RENAME has never been probed against this catalog. A model change
that adds a column to an existing table goes out together with its rebuild, not ahead of it:
the export would ask for a column the catalog doesn't have, and dbt would try an ALTER TABLE
that has never been probed either.

## Profiles: ci (plain DuckDB, no Iceberg), dev/prod (OneLake Iceberg REST catalog, the same one)

## Key Patterns
- **SETTLEMENTDATE is AEST wall clock stored as TIMESTAMPTZ labelled UTC.** The models cast
  the CSV string to TIMESTAMPTZ in a session whose zone is UTC, so the instant in the column
  is 10h early; the `DATE`/`YEAR` columns next to it are cast from the string and are right.
  `profiles.yml` sets `TimeZone: UTC` on every target, so a run from any machine writes the
  same values. Every reader of the Iceberg tables must run with `TimeZone = 'UTC'` too (as
  `scripts/copy_catalog.py` does) — a Brisbane session shifts every date and time by +10h.
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
  `attachCached` (`dashboard/storage/history.js`) read the OPFS-cached files in place
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
