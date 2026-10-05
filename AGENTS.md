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
is the counterpart of `macros/pending_archive_files.sql` here). This repo has no
`fct_summary`: the dashboard joins facts to `dim_duid`/prices client-side in DuckDB-WASM, and
`scripts/cache_catalog.py` exports, pre-aggregates and adds the rooftop pseudo-units.
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
  and measures (`scada[mw]`, `unit[fuel]`, `[Renewable share]`). **It joins nothing**,
  names no view (outside Analyze and `data.has('v_...')`) and knows no `dim_duid` column, no
  fuel naming rule, no region names (they are `unit[state]`). Which fuels are renewable is not
  in the dashboard at all: `dim_duid.Renewable` says, and `unit[renewable]` passes it on. It
  names a fuel only to colour it, to label `Grid` "Battery" in a legend, to pick the solar
  and wind records of the History page, and to limit the curtailment charts to wind and
  solar. A new chart that needs a join or a rule gets a table, a relationship or a function
  in `model.bim`, not a rule in the page. The filters are DAX too (`dax.whereGen`,
  `dax.unitFilters`, `dax.wherePrice`, `dax.priceFilters`: the arguments of a
  `CALCULATETABLE`); the `sql` ones next to them are Analyze's.
- `dashboard/semantic/model.bim` is the semantic model, and the only place a view or a
  measure is defined. It is TMSL, the JSON of a Tabular model (compatibility level 1604):
  `expressions` (the constants, as parameters), `tables` with their `measures`,
  `relationships`, each with its `description`, and the glossary and
  the stitching rules as model `annotations`. What TMSL has no property for is an annotation,
  its own extension point. A table is one view, `v_<table>`, of four kinds, told by its
  partitions:
  - one entity partition with a schema (`today`.`scada_today`): that attached table as it
    is; a table a deployed file lacks gets no view.
  - two partitions, `history` and `recent`, stitched at the cut (`recent_days`, 5): the last
    5 days from `today`, older days from the half-year databases (schema `p*`) or `agg`. The
    table's `stitch` annotation picks one of the three rules. A column with the `optional`
    annotation reads NULL from a file that lacks it (typed by `sourceProviderType`); `rollup`
    is a column's expression on the recent side.
  - one entity partition without a schema: columns picked from another table of the model
    (`sourceColumn`, or the `sql` annotation), plus the calculated columns, in DAX (`unit`:
    a unit's attributes under the page's names).
  - a query partition: SQL over other views (`region`, `gen_latest`/`price_latest`,
    `curtailment_recent`); `when` names a column that must exist.
  A relationship is a view too, under its `name`, the from side LEFT JOIN the to side:
  `v_gen`/`v_gen_daily`/`v_gen_hourly`/`v_gen_today` and `v_curtailment` (a fact with the
  unit's attributes on every row), and `v_gen_price*` (plus the price of the unit's region).
  A TMSL relationship is one column to one column, so the price ones, which join on date,
  time and the unit's region, carry the rest in `from`, `on` and `columns`. The calculated
  columns of `unit` are worked out again on the joined row, which is how a unit missing from
  `dim_duid` gets the fuel "Unregistered". The logic is **measures, not DAX user-defined
  functions** (the owner's call, 2026-10-05: a measure is what every Tabular consumer
  reads): generation, renewable share and capture price. A measure belongs to one table, so
  there is one per grain the page reads (`[Renewable share]` on `scada`,
  `[Renewable share daily]` on `scada_daily`, `[Renewable share latest]` on `gen_latest`).
  Capacity factor is not one: it is worked out in the page, over its own one-row-per-unit
  table. **The page's DAX must be DAX that VertiPaq accepts with the same meaning**, not
  only DAX the compiler accepts: the model is headed for a Direct Lake deployment, where
  the same queries will be run and compared.
  It is JSON, so a browser reads it with no library: there are no comments, so the why goes
  in a `description`, and a long expression is an array of lines.
- `dashboard/semantic/compiler.js` has two parts (`createModel(dataSource)`: the data
  source's members plus `has`, `needs` and `toSQL`).
  The model: it turns `model.bim` into those views. It compiles after every
  attach: one query reads what is attached from the engine's catalog (`information_schema`),
  and one runs the statements that are new or changed. A view is created once: DuckDB binds
  a view again on every read, so the ones over a rebuilt view follow it. At startup the
  catalog read costs ~100 ms and the statements ~40 ms; an attach after that ~20 ms in all
  (2026-10-05). `needs(sql)` is worked out from what each table reads. `ensureHistory`
  attaches nothing for a range that starts inside the last 5 days: `today` covers it, so the
  default view fetches no history. It knows the attached databases by name only (`dim`,
  `today`, `agg`, `p<YYYY>_h<N>`), so it and `model.bim` are the same files for every host.
  The queries: `toSQL(dax)` turns a DAX query into one SELECT over those views, the same
  text once (a Map). The header of the file lists what each DAX construct becomes. Three
  things to know:
  - It picks the view from the tables a query names: `scada` alone reads `v_scada`, with
    `unit` it reads `v_gen`, with `price` `v_gen_price`. A query never says which.
  - The result is cast by the column's `dataType` for the browser: a date as VARCHAR, a
    whole number as INTEGER, a number as DOUBLE. A subquery or a CTE is left as it is.
  - A `[Name]` that is not a column of the table being built is a measure, and its
    expression is written out in its place: there are no macros. Under `CALCULATE` its
    aggregates take the `FILTER (WHERE ...)`.
- `storage/data.js` is the host: how the `.duckdb` files are fetched, cached and attached
  (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `query`). It attaches `dim`,
  `today`, `agg` and the 5-minute history, and builds no view. On both the files are
  downloaded whole into OPFS, and the history is the half-year files (`p2026_h1`, ...), the
  ones a range needs. There are two, with the same members:
  - `dashboard/storage/data.js`, GitHub Pages: the files sit in `data/`, with
    `daily_manifest.json` listing the half-years.
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

Four things in that design are there for speed and must survive an edit:
- A query that needs nothing about the unit (previous-period generation with no filter, the
  Flows generators, the cutoff) reads the plain fact view, not `v_gen*`: no join to pay for.
  The compiler does this, from the tables the DAX names: so a query that needs nothing of
  the unit must not name `unit`, and a unit pick is a filter on the fact's own `DUID`.
- `v_gen_latest` takes its newest interval from `v_scada_today`, not from the joined view.
- A rule about the fuel is never an IN list inside a view: an IN list becomes a hash join,
  and a join in a view runs for every query whether it reads the column or not. Attributes
  like `renewable` are columns of `dim_duid`, read off the unit.
- The charts that leave storage out filter on `generator` (`fuel <> 'Grid'`), never on
  `NOT storage`: with the fuel filter on Grid the optimizer then sees
  `fuel = 'Grid' AND fuel <> 'Grid'` and reads nothing (18 ms); through
  `NOT (fuel = 'Grid')` it does not (65 ms). This is why "storage" stays a rule on the fuel
  in `model.bim` and is not a column like `Renewable`. In DAX the filter is the bare column,
  `unit[generator]`: the compiler writes it as it is, not as `= TRUE`.

`v_gen_price*` is a LEFT join: capture price and the battery chart add `price IS NOT NULL`,
Analyze's generation + price keeps the rows without a price.

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
  `v_gen_latest` and `v_price_latest`, two queries, following the region filter only.

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
skip a file), push retried on a race. The daily run exports from Iceberg, rebuilds and
redeploys only the latest two half-years: older half-year files stay as deployed, and
`energy_daily_agg.duckdb` keeps the deployed rows before the cutoff (downloaded,
sanity-checked, spliced — `cache_catalog.export_cutoff`). Dispatch `import_data.yml` with
`all_periods=true` after a backfill that touched older data. The manifest of half-year files
is built last, from the files actually in the deploy repo; an empty listing fails the step
instead of publishing an empty manifest. `squash_deploy_repo.yml` (weekly, Sunday 17:00 UTC,
also dispatchable) replaces the deploy repo's history with one commit of its current tree
(`scripts/squash_deploy_repo.sh`, force-with-lease): `energy_today.duckdb` is redeployed every
30 min, and the kept copies would otherwise grow the repo by gigabytes a week. The site is
unchanged; GitHub reclaims the space on its own schedule.

**The same files also go to OneLake**, for the Fabric app (the same page, hosted in Fabric,
reading a lakehouse in another tenant — workspace `app`, lakehouse `data`).
`import_onelake.yml` (daily, 22:30 UTC) runs the same `cache_catalog.py` steps and publishes
with `scripts/deploy_onelake.py`. It builds the same files, with one difference: it sets
`ALL_PERIODS=true`, so every run exports and rebuilds all the history, with no splice (OneLake
has no deployed copy to splice onto). `build_daily` fails on both if a half-year file
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

A daily run refuses to splice when the deployed aggregate's tables or columns differ from what
`build_daily_agg` now builds, so a change to them needs one `all_periods=true` dispatch. The
page itself reads any column or table a deployed file lacks as "no data"
(an `optional` column of `model.bim` reads NULL, a table whose source is missing gets no
view, and `data.has` in the page), so a new page can go out before the data does.
`energy_daily_agg.duckdb` holds, besides the per-day tables, hour-of-day × month tables
(`scada_hourly`, `price_hourly`, `month_days`) that the daily-profile and price heatmap read
for ranges over 30 days — `scada_hourly` and `month_days` leave out the newest date of the
export, which only has 00:05–04:00 until the next file lands — and `curtailment_daily`: per semi-scheduled unit and day,
`curtailed_mwh` = Σ max(AVAILABILITY − TOTALCLEARED, 0) / 12 and `available_mwh`, from
`fct_scada` (`cache_catalog.export_curtailment`). It is built in the export because a fully
curtailed unit sits at 0 MW and the scada export drops 0 MW rows. The units add up to AEMO's
REGIONSUM `SS_WIND`/`SS_SOLAR` availability less cleared MW. It ends with the newest complete
next-day file (the export leaves out the newest date, which only has 00:05–04:00); the
intraday files carry no per-unit availability. The days after it come from AEMO's regional
figures: `energy_today.duckdb`'s `price_today` carries `wind_available`, `wind_curtailed`,
`solar_available`, `solar_curtailed` (MW, the region's semi-scheduled, from
`fct_regionsum_today`), which `model.bim` turns into `v_curtailment_recent`; the chart draws
those days lighter and leaves them out when units are picked. Only units on the current
registration list have a classification, so semi-scheduled farms that have left the list are
not counted. The Insights page reads both for any range.

## Models (10)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) — only rows missing from the target; the durable log is `Files/csv_archive_log.parquet` |
| dim_calendar | mart | incremental append (the NOT-IN filter keeps existing dates out; runs 2 years ahead) |
| dim_duid | mart | incremental insert-only merge on DUID; NEM units from the registration list, then `duid_unregistered.csv`; registered capacity (RegCapMW etc.); `Renewable` — **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind". A new column or a changed rule reaches the existing rows with a `rebuild=dim_duid` |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so readers take `ANY_VALUE … GROUP BY`. Exported as `interconnector` in the half-year files; the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/availability/cleared MW. History's demand/net interchange come from fct_price's DREGION rows |
| fct_rooftop_pv | landing | incremental insert-only merge (by file) — rooftop solar per region and half hour, AEMO's `ROOFTOP_PV_ACTUAL` estimate **kept as published**: the current folder, the monthly MMSDM archive 2018-01 → 2026-08 and the weekly archives after it. The monthly files from 2024-08 swap `QI` and `LASTCHANGED`; the model reads each file's `I` row to tell |

**Rooftop solar reaches the dashboard as pseudo-units, built in the export, not in Iceberg.**
`scripts/cache_catalog.py rooftop_units` adds `QLD_PV`, `NSW_PV`, `VIC_PV`, `SA_PV`, `TAS_PV` to
the scada exports and `export_dim_duid` adds them to the units with fuel `Rooftop solar`,
`Renewable` true (no coordinates, no capacity), so every unit-based chart shows rooftop with
no special case. The rules, all in that function: the `MEASUREMENT` estimate only (it starts
2018-03-06); a blank (`QI = 0`) is missing, not zero; a straight line between two consecutive
half hours, nothing across a missing one; the newest half hour held for up to 55 minutes (the
next estimate lands 30–60 minutes late), never past the newest SCADA interval. On the
generation chart the dashed Demand line is operational demand **plus** the rooftop in the
stack. AEMO's data model 5.6 report says `ROOFTOP_PV_ACTUAL` will be removed in a later
release in favour of `ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute), neither published yet — when
the current folder stops updating, that is the replacement to move to.

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
  `scripts/cache_catalog.py` does) — a Brisbane session shifts every date and time by +10h.
  The browser is not such a reader: the exported files hold `date` and `time`, and `data.js`
  runs in Brisbane time for `CURRENT_DATE` alone. Fixing it at the writer would change the
  column's values and mean rebuilding all seven facts.
- **The dashboard's MW changes source at the 5-day mark.** History (`fct_scada`) is
  `INITIALMW` from the `DUNIT` rows of AEMO's next-day `PUBLIC_DAILY` files; the last 5 days
  are `SCADAVALUE` from the intraday `Dispatch_SCADA` files (`fct_scada_today`), renamed to
  `INITIALMW` in the model so the exports treat both alike. They are different AEMO columns
  from different reports, so a small step where the two meet in a chart is expected, not a
  bug. `fct_scada_today` has no `INTERVENTION` column, so its export can't filter on it.
  Unifying them would mean rebuilding a fact; not worth it. Three numbers are involved, in
  three places: the `_today` tables keep every row they ever loaded (insert-only, never
  trimmed), the export takes their last 14 days, and the model reads the last 5 from them
  (`recent_days` in `model.bim`) and the rest from history. And one asymmetry: `fct_scada_today` drops the
  0 MW rows at load, `fct_scada` keeps them and the export drops them.
- **What the export applies, which a reader of the Iceberg tables has to redo**
  (`scripts/cache_catalog.py`): `INTERVENTION = 0` only (the pricing run); 0 MW rows left
  out; one row per key with `ANY_VALUE … GROUP BY`, because `file` is part of every merge key
  and an interval can be there from two files; interconnector `mw` is the dispatch target
  `MWFLOW`, not `METEREDMWFLOW`; energy is `SUM(mw) / 12`; `date` is the calendar date of the
  interval's end and `time` its HHMM; daily price and demand are plain averages of the
  intervals; rooftop and curtailment as described above. A table the catalog doesn't have
  fails the export rather than deploying files without it.
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
