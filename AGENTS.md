# AGENTS.md — iceberg_as_code

## Quick Reference
- **Stack:** dbt-duckdb, **OneLake Iceberg REST catalog** (Microsoft Fabric workspace `power`,
  lakehouse `nem` — its own lakehouse, deliberately separate from the sibling repo's
  `data`, because both repos write identically-named tables in `landing`/`mart`)
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

## The dbt project descends from the sibling repo
The sibling is now [`dbt-fabric`](https://github.com/djouallah/dbt-fabric) (it replaced
`dbt_fabric_python_iceberg`, which no longer exists). It runs the same AEMO models on other
engines. As of 2026-10-01 it has only `models/aemo/dwh/` (Fabric Warehouse) and
`models/aemo/spark/` — the DuckDB/Iceberg variant this repo matched is gone, so ports are now
by idea, not by file (`macros/new_source_files.sql` there is the counterpart of
`macros/pending_archive_files.sql` here). This repo was copied from the old sibling minus `fct_summary`
(the dashboard joins facts to `dim_duid`/prices client-side in DuckDB-WASM;
`scripts/cache_catalog.py` exports, pre-aggregates and adds the rooftop pseudo-units).
**Look there first for fixes, and port them rather than diverging.** Ideas worth knowing:
- There, downloading lives outside dbt and the log is read straight from parquet, not from an
  Iceberg table — which would remove the log table this repo had to rebuild on 2026-09-18.
- `ORDER BY archive_path DESC` before `LIMIT process_limit` (ported here 2026-10-01).
Three deliberate local differences, all of which must survive a port:
- No `relationships → dim_duid` tests on `fct_scada`/`fct_scada_today` — `dim_duid` holds the
  registered DUIDs plus the unlisted ones that generated, while the facts go back to 2018 and
  also carry units only ever dispatched at 0 MW, so the test could never be 0. `tests/assert_recent_scada_duids_registered.sql` is the meaningful
  version and is this repo's own.
- `tests/assert_all_*_files_processed_*.sql` use `NOT EXISTS` and are untagged; the sibling's
  use `NOT IN` (a single NULL `file` makes them permanently green) and are tagged `heavy`.
- `profiles.yml` keeps a `ci` target (plain DuckDB, no Iceberg; `build.yml` gives it a file,
  `ci.duckdb`) for `build.yml`, and
  `dbt_project.yml`'s `on-run-start` hooks are guarded with `target.name != 'ci'` — the
  sibling's are unconditional and would break that target.

## Architecture
1. `stg_csv_archive_log.py` (Python model) downloads AEMO + GitHub data and archives the
   gzipped CSVs **to OneLake Files** (`FILES_PATH`, i.e. the `nem` lakehouse's `Files/csv/`),
   alongside a durable `Files/csv_archive_log.parquet`. This is the whole point of the 2026-08
   rewrite: the archive used to live on the runner's `/tmp`, which is wiped every run, and the
   pile of reconciliation machinery that existed to paper over that (`confirm_log_entries`,
   `heal_orphaned_daily_files`, `report_unprocessed_files`, `force_download.txt`,
   `pending_log_entries.csv`) is **deleted** — a durable archive needs none of it.
2. **No daily/intraday split.** Every 30-minute pass does every feed (the daily files,
   intraday SCADA, intraday DispatchIS, the monthly interconnector archive, rooftop current /
   weekly / monthly) plus the DUID reference, self-gated on data rather than on a schedule:
   each DUID reference file is downloaded when its log row is 24h old, and the backfills (the
   GitHub historical listing, the monthly archives, the weekly rooftop archives) only run when
   AEMO returned fewer than `download_limit` new daily files. `download_limit` is per feed.
   There is no `daily_refresh` env var.
   **A source that fails skips itself, not the run** (since 2026-10-04): a nemweb folder that
   can't be listed, or a reference file that can't be fetched, prints a `::warning::` and that
   feed downloads nothing this pass; the previous reference file and its log row stay. The
   model must not raise for it: every fact `ref`s this model, so one unreachable site (the WA
   one, or `ROOFTOP_PV/ACTUAL` once AEMO removes it) would skip all seven facts. A failed
   write to OneLake still raises.
   The DUID refresh also saves the generator sheet of AEMO's **NEM Registration and Exemption
   List** (the newest copy archived weekly in `djouallah/aemo_data/data/duid/registration/`) as
   `Files/csv/duid/registration.csv`. `dim_duid` takes its NEM units from two files only: that
   list, and `duid_unregistered.csv` (`djouallah/aemo_data`), the units in the data that the
   list doesn't have (closed plant, replaced DUIDs, non-scheduled units; 99 on 2026-10-03).
   That file is generated, not typed, from AEMO's MMSDM registration history
   (`DUDETAILSUMMARY`, `DUALLOC`, `GENUNITS`, `STATION`, `PARTICIPANT`); its commits say how,
   and 36 small loads AEMO gives no energy source for have a region and no fuel. It is a
   snapshot: a unit that leaves the list later stays in `dim_duid` (insert-only), but a
   `rebuild=dim_duid` would lose it until the file is regenerated. **Missing units are fixed
   in that file, never in dbt** — `dim_duid` has no fallback: `duid_data.csv`, a 2026-07 CSV
   copy of the list, is no longer read here (the sibling still reads it).
3. Work is discovered from the **log table**, not a filesystem glob: each fact model's pre-hook
   (`macros/pending_archive_files.sql`) builds its path list from
   `SELECT DISTINCT stg_csv_archive_log.archive_path` filtered by `NOT EXISTS` against
   `{{ this }}.file` (not `NOT IN`: one NULL `file` would stop every load), newest first
   (`ORDER BY archive_path DESC LIMIT process_limit`; that is path order, so newest first
   within a source folder, and for a model that reads several folders one folder after the
   other). A file counts as loaded once the fact holds a row of it: one that yields no row
   stays pending and is read again every run. The DISTINCT is load-bearing: the
   log table is append-only and can hold a file more than once (until 2026-09-18 the staging
   model re-appended the *whole* log every run, so a file that waited K runs had K rows), and
   MERGE only dedupes against the target, never within a batch. Without it a single
   fact-model failure (fct_scada, 2026-08-25 09:43 UTC, network error) turned into 74.9M
   duplicate keys as the backlog was read 2-N times per batch.
   The staging model now appends only the rows the Iceberg table is missing (anti-join on
   source_type/source_filename/csv_filename against `dbt.this`). The whole-log version grew
   the table by its own size 48 times a day; on 2026-09-17 15:34 UTC the OneLake catalog
   started answering HTTP 500 to every load and commit of `landing.stg_csv_archive_log`
   (dbt, compaction and pyiceberg alike, every other table fine) and the pipeline was down
   until the table was dropped and rebuilt from `Files/csv_archive_log.parquet`, which is
   the durable log and the only source of truth — the Iceberg table is a materialization.
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
   get faster but storage doesn't shrink. **First run (2026-08-25) expired nothing** — every
   table held 16-18 snapshots, none older than a day, so something on the OneLake side is
   already trimming them; treat this step as a bounded safety net, and if a table is ever seen
   above ~48 snapshots that assumption has changed. The job takes a job-level `process-data` concurrency group — both operations
   commit optimistically, so an overlap with a load could fail one side. It is
   `continue-on-error` and both scripts always exit 0: maintenance must never fail its
   workflow (a red run there means a dbt test failed). The price of that is that a compaction
   that has stopped working only shows in the job's log. Both scripts read their table list from
   `scripts/iceberg_tables.py`; a new model gets added there once.

## Don't design anything that needs DELETE
Every write is an append. On OneLake a commit may carry only one add-snapshot, so anything
that mixes delete files with data files is rejected outright (`BadRequest 400`) — hence the
insert-only merges. On the previous (R2-backed) catalog `DELETE` had a nastier failure mode:
it **succeeded without applying** whenever the predicate contained subqueries over *other*
Iceberg tables, silently no-op'ing for weeks. Both histories point the same way: design the
path so it needs no `DELETE`, and never assume one landed — re-count and log the delta.

The catalog capability probe (CREATE/INSERT/DELETE/UPDATE/MERGE/DROP against a freshly
created table) lives in the user's **separate repo**, not here (removed 2026-10-01). Its
matrix is the standing evidence for what this catalog actually does; ask for it before
relying on any claim here, and ask for a re-run after the catalog or the duckdb pin moves.

## Auth (GitHub Actions) — no secrets
OIDC only: `azure/login@v2` with a federated credential, then each job mints a short-lived
`ONELAKE_TOKEN` via `az account get-access-token --resource https://storage.azure.com/`.
The ids live in repository **variables** (public identifiers, not secrets):
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` — the tenant + Entra app (named `dbt_fabric_python_iceberg` after the old sibling,
  no client secret; shared with the sibling repo)
- `WS_ID`, `LH_ID` — the Fabric workspace (`power`) and lakehouse (`nem`). The workflows build
  `WAREHOUSE_PATH = {WS_ID}/{LH_ID}` and `FILES_PATH = abfss://{WS_ID}@onelake.dfs.fabric.microsoft.com/{LH_ID}/Files`
  directly from them. **No workflow creates or looks up a lakehouse** — that is infrastructure,
  created once by hand (schema-enabled, since the models write to `landing`/`mart`). If it is
  ever recreated, update `LH_ID`; CI is deliberately not in the provisioning business.
Env contract consumed by profiles.yml, the models and the scripts: `ONELAKE_ENDPOINT`,
`ONELAKE_TOKEN`, `WAREHOUSE_PATH`, `FILES_PATH`, `download_limit`, `process_limit`, plus
`AZURE_TRANSPORT_OPTION_TYPE=curl` + `CURL_CA_INFO` on runners (the azure extension's default
transport fails the OneLake TLS handshake).
`NEMTRACKER_TOKEN` (gh-pages deploy) is the one remaining true secret.

## Dashboard deploy
The dashboard is three files, one job each (since 2026-10-04; before, the page held the joins
and the macros).
- `dashboard/index.html` is the page: charts, and SQL that only picks columns from views,
  filters and groups them. **It joins nothing** and knows no `dim_duid` column, no fuel
  naming rule, no region names (they are `v_unit.state`). Which fuels are renewable is not in
  the dashboard at all: `dim_duid.Renewable` says, and `v_unit.renewable` passes it on. It
  names a fuel only to colour it, to label `Grid` "Battery" in a legend, and to pick the
  solar and wind records of the History page. A new chart that needs a join or a rule gets a
  view or a macro in `model.js`, not SQL in the page.
- `dashboard/model.js` is the semantic layer (`createModel(dataSource)`: the same members as
  the data source, plus `needs`). Over `data.js`'s views it builds the ones the page reads —
  `v_unit` (a unit's attributes under the page's names), `v_gen`/`v_gen_daily`/`v_gen_hourly`/
  `v_gen_today` (generation with the unit's attributes on every row), `v_gen_price*` (plus the
  price of the unit's region), `v_gen_latest`/`v_price_latest`, `v_region` — and the measures
  as DuckDB macros (`generated`, `renewable_share`, `capture_price`, `capacity_factor`). The
  list at its top is the page's contract. It reads only `data.js`'s views, so it is the same
  file for every host. Its views are created once, in one query: DuckDB binds a view again on
  every read, so they follow `data.js` rebuilding the views under them (checked on the pinned
  wasm build); only `v_gen_hourly` waits for agg. Creating them costs ~30 ms at startup and
  ~50 ms with history attached (each is bound at creation), which is why they are not rebuilt
  after every attach.
- `dashboard/data.js` is how the `.duckdb` files are fetched, cached, attached and merged into
  the base views (`createDataSource`: `init`, `attachAgg`, `ensureHistory`, `has`, `query`;
  the list at its top is its contract with `model.js`), and it is the only part that knows
  about `data/`, the half-year files, the `dim`/`today`/`agg` databases and OPFS. A host that
  stores the files differently (the Fabric app) keeps the page and `model.js` and ships its
  own `data.js` with the same members and the same views. `ensureHistory` attaches nothing
  for a range that starts inside the last 5 days: `today` covers it, so the default view
  downloads no half-year file (it did until 2026-10-04, 44 MB before first paint). It sets
  the session to Brisbane time, on purpose: the files carry `date` and `time`, no
  TIMESTAMPTZ, and the only thing the zone decides is that `CURRENT_DATE` is the NEM's day.

Four things in that design are there for speed and must survive an edit. The last two were
measured regressions in the first cut (2026-10-04), found by reading `EXPLAIN` and by timing
every query of the page old against new:
- A query that needs nothing about the unit (previous-period generation with no filter, the
  Flows generators, the cutoff) reads the plain fact view, not `v_gen*`: no join to pay for.
- `v_gen_latest` takes its newest interval from `v_scada_today`, not from the joined view.
- A rule about the fuel is never an IN list inside a view: an IN list becomes a hash join,
  and a join in a view runs for every query whether it reads the column or not. (`renewable`
  was one, then a `list_contains`; it is now a column of `dim_duid`, read off the unit.)
- The charts that leave storage out filter on `generator` (`fuel <> 'Grid'`), never on
  `NOT storage`: with the fuel filter on Grid the optimizer then sees
  `fuel = 'Grid' AND fuel <> 'Grid'` and reads nothing (18 ms); through
  `NOT (fuel = 'Grid')` it does not (65 ms). This is why "storage" stays a rule on the fuel
  in `model.js` and did not become a column like `Renewable`.

`v_gen_price*` is a LEFT join: capture price and the battery chart add `price IS NOT NULL`
(the INNER join they had), Analyze's generation + price keeps the rows without a price.

How the move was checked (2026-10-04, headless Chrome, the page at the previous commit against
the new one on one snapshot of the deployed files, plus two altered copies: 50 units and some
prices removed; the pre-October schema): 756 page states, 2,770 query results. 2,713 were
identical bit for bit, 48 equal to within 2e-13 (sums taken in another order: without the
calendar join the planner reads the facts first), 9 had a NULL column typed DOUBLE instead of
REAL; page text, KPIs, sparklines and chart options were identical, the map's points in
another order in 53 snapshots (its query has no ORDER BY). Timed old against new SQL
alternately in one page, 1,297 queries: 7.5% less in total, none slower by more than 10% and
10 ms; a query over the model's views plans ~0.5 ms longer (more view to expand), which shows
only on the sub-10 ms ones. Data-ready to first render: 787 ms against 823 ms. A change to
`model.js` deserves the same checks: the page's query results old against new, `EXPLAIN` for
a join that was not there, and old against new timings taken alternately in the same page
(two separate sessions differ by more than the change does). Speed is tracked every time:
the total, and any query clearly slower. A difference of some 10 ms on one query is not
worth chasing: on a second run as many go the other way.

`build.yml` (index.html, data.js, model.js, dbt docs) and `import_data.yml` (the .duckdb files) publish into
`NemTracker/nemtracker.github.io` with `scripts/deploy_pages.sh`: a blobless depth-1 clone, the
published paths added with `-f`, push retried on a race. It replaced peaceiris/actions-gh-pages,
whose full-history clone (~900 MB, ~2.5 min) made concurrent deploys collide, and whose
`git add --all` skipped new files matching the deploy repo's `.gitignore` (`*.duckdb` was in it
until 2026-10-01 — that is why `energy_data_2026_h2.duckdb` never deployed). The daily run
exports from Iceberg, rebuilds and redeploys only the latest two half-years: older half-year
files stay as deployed, and `energy_daily_agg.duckdb` keeps the deployed rows before the
cutoff (downloaded, sanity-checked, spliced — `cache_catalog.export_cutoff`). Dispatch
`import_data.yml` with `all_periods=true` after a backfill that touched older data.
`squash_deploy_repo.yml` (weekly, Sunday 17:00 UTC, also dispatchable) replaces the deploy
repo's history with one commit of its current tree (`scripts/squash_deploy_repo.sh`,
force-with-lease): `energy_today.duckdb` is redeployed every 30 min, and the kept copies had
grown the repo to ~16 GB by 2026-10-01. The site is unchanged; GitHub reclaims the space on
its own schedule.

A daily run refuses to splice when the deployed aggregate's tables or columns differ from what
`build_daily_agg` now builds, so a change to them needs one `all_periods=true` dispatch. The
page itself reads any column or table a deployed file lacks as "no data"
(`data.js` `loadColumns`/`colOrNull`, the NULL columns of `model.js`'s `v_unit`, and `data.has`
in the page), so a new page can go out before the data does.
`energy_daily_agg.duckdb` holds, besides the per-day tables, hour-of-day × month tables
(`scada_hourly`, `price_hourly`, `month_days`) that the daily-profile and price heatmap read
for ranges over 30 days, and `curtailment_daily` (since 2026-10-04): per semi-scheduled unit
and day, `curtailed_mwh` = Σ max(AVAILABILITY − TOTALCLEARED, 0) / 12 and `available_mwh`,
from `fct_scada` (`cache_catalog.export_curtailment`). It is built in the export because a
fully curtailed unit sits at 0 MW and the scada export drops 0 MW rows. Checked on 2026-10-03
against AEMO's REGIONSUM `SS_WIND`/`SS_SOLAR` availability less cleared MW: the units add up
to it. It ends with the newest complete next-day file (the export leaves out the newest
date, which only has 00:05–04:00); the intraday files carry no availability, so there is no
"today" part. The Insights page reads it for any range (`v_curtailment` in `model.js`).

## Models (10)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) — only rows missing from the target; the durable log is `Files/csv_archive_log.parquet` |
| dim_calendar | mart | incremental append (the NOT-IN filter keeps existing dates out; runs 2 years ahead) |
| dim_duid | mart | incremental insert-only merge on DUID; NEM units from the registration list, then `duid_unregistered.csv`; carries registered capacity (RegCapMW etc.) since 2026-10-01 and `Renewable` since 2026-10-04: **the list of renewable fuels lives in this model** (an inline CTE next to `states`), nowhere else; changing it reaches the existing rows with a `rebuild=dim_duid`. Also since 2026-10-04 `Classification` from the list (Scheduled / Semi-Scheduled / Non-Scheduled, stars stripped; NULL off the list): curtailment is measured on Semi-Scheduled, not on a fuel, because HPR1 (a battery) is registered with fuel "Wind" |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |
| fct_interconnector_today | landing | incremental insert-only merge (by file) — the INTERCONNECTORRES rows of the same archived DispatchIS files as fct_price_today (added 2026-10-01) **and, despite the name, the whole history**: AEMO's monthly MMSDM archive of the same record, 2018-01 → 2026-08 (source_type `interconnector_monthly`, a finite backfill added 2026-10-02; read with `strict_mode = false`, which the files from 2024-08 need). August 2026 is in both sources, so readers take `ANY_VALUE … GROUP BY`. Exported as `interconnector` in the half-year files; the Flows page plays any range ≤ 30 days |
| fct_regionsum_today | landing | incremental insert-only merge (by file) — the REGIONSUM rows (v9) of the same files: demand, net interchange (positive = export), regional semi-scheduled UIGF/cleared MW (added 2026-10-01, filled from the archive). History's demand/net interchange come from fct_price's DREGION rows |
| fct_rooftop_pv | landing | incremental insert-only merge (by file) — rooftop solar per region and half hour, AEMO's `ROOFTOP_PV_ACTUAL` estimate **kept as published** (added 2026-10-02): the current folder, the monthly MMSDM archive 2018-01 → 2026-08 and the weekly archives after it. The monthly files from 2024-08 swap `QI` and `LASTCHANGED`; the model reads each file's `I` row to tell |

**Rooftop solar reaches the dashboard as pseudo-units, built in the export, not in Iceberg.**
`scripts/cache_catalog.py rooftop_units` adds `QLD_PV`, `NSW_PV`, `VIC_PV`, `SA_PV`, `TAS_PV` to
the scada exports and `export_dim_duid` adds them to the units with fuel `Rooftop solar`,
`Renewable` true (no coordinates, no capacity), so every unit-based chart shows rooftop with
no special case. The
rules, all in that function: the `MEASUREMENT` estimate only (it starts 2018-03-06); a blank
(`QI = 0`) is missing, not zero; a straight line between two consecutive half hours, nothing
across a missing one; the newest half hour held for up to 55 minutes (the next estimate lands
30–60 minutes late), never past the newest SCADA interval. On the generation chart the dashed
Demand line is operational demand **plus** the rooftop in the stack. AEMO's data model 5.6
report says `ROOFTOP_PV_ACTUAL` will be removed in a later release in favour of
`ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute); neither was published on 2026-10-02 — when the
current folder stops updating, that is the replacement to move to.

`dim_duid`'s insert-only merge means attribute changes (region/fuel/geo) never update in
place. **Rebuilding a table = dispatch `process_data.yml` with `rebuild=<table>`**: it runs
`scripts/rebuild_table.py` (DROP, names checked against `scripts/iceberg_tables.py`) and the
dbt run that follows recreates the table with a plain CTAS, refilling at `process_limit`
files per run. It also works on a table the catalog can no longer serve (the pre-drop count
is best-effort). Do not use `dbt run --full-refresh`: dbt-duckdb builds `<table>__dbt_tmp` and
RENAMEs it into place, and RENAME has never been probed against this catalog.

## Profiles: ci (plain DuckDB, no Iceberg), dev/prod (OneLake Iceberg REST catalog, the same one)

## Key Patterns
- **SETTLEMENTDATE is AEST wall clock stored as TIMESTAMPTZ labelled UTC.** The models cast
  the CSV string to TIMESTAMPTZ in a session whose zone is UTC, so the instant in the column
  is 10h early; the `DATE`/`YEAR` columns next to it are cast from the string and are right.
  `profiles.yml` sets `TimeZone: UTC` on every target (since 2026-10-04; before, it was UTC
  only because the runners are, and a run from a laptop in Brisbane would have written other
  instants into the same tables). Every reader of the Iceberg tables must run with
  `TimeZone = 'UTC'` too (as `scripts/cache_catalog.py` does) — a Brisbane session shifts
  every date and time by +10h, which is what the dashboard showed from the 2026-08-25
  refactor until 2026-09-25. The browser is not such a reader: the exported files hold
  `date` and `time`, and `data.js` runs in Brisbane time for `CURRENT_DATE` alone. Fixing it
  at the writer would change the column's values and mean rebuilding all seven facts.
- **The dashboard's MW changes source at the 5-day mark.** History (`fct_scada`) is
  `INITIALMW` from the `DUNIT` rows of AEMO's next-day `PUBLIC_DAILY` files; the last 5 days
  are `SCADAVALUE` from the intraday `Dispatch_SCADA` files (`fct_scada_today`), renamed to
  `INITIALMW` in the model so the exports treat both alike. They are different AEMO columns
  from different reports, so a small step where the two meet in a chart is expected, not a
  bug. `fct_scada_today` has no `INTERVENTION` column, so its export can't filter on it.
  Unifying them would mean rebuilding a fact; not worth it. Three numbers are involved, in
  three places: the `_today` tables keep every row they ever loaded (insert-only, never
  trimmed), the export takes their last 14 days, and `data.js` reads the last 5 from them
  (`RECENT_CUT`) and the rest from history. And one asymmetry: `fct_scada_today` drops the
  0 MW rows at load, `fct_scada` keeps them and the export drops them.
- **What the export applies, which a reader of the Iceberg tables has to redo**
  (`scripts/cache_catalog.py`): `INTERVENTION = 0` only (the pricing run); 0 MW rows left
  out; one row per key with `ANY_VALUE … GROUP BY`, because `file` is part of every merge key
  and an interval can be there from two files; interconnector `mw` is the dispatch target
  `MWFLOW`, not `METEREDMWFLOW`; energy is `SUM(mw) / 12`; `date` is the calendar date of the
  interval's end and `time` its HHMM; daily price and demand are plain averages of the
  intervals; rooftop as described under Models. A table the catalog doesn't have fails the
  export (since 2026-10-04): the three "not there yet" fallbacks would have deployed files
  without rooftop, demand or flows over good ones.
- Pre-hooks set DuckDB VARIABLEs with the file paths to process, read from the log table
- **Every file a model reads is a dbt source** (`models/sources.yml`, dbt-duckdb
  `external_location`), so the lineage graph shows it. `aemo.*` compiles to the fact model's
  `getvariable('…_paths')`, `duid_reference.*` to the file's path under `Files/csv/duid/`: the
  compiled SQL is the same as before the sources existed (2026-10-03). They are not tables —
  the variable only exists inside its model, so no tests or freshness on them. The variable
  is there because DuckDB has no manifest: `read_csv` takes a constant list or a glob, not a
  subquery, and a glob lists the whole folder whatever the `filename` filter (measured on the
  2.0 pin). Asked upstream in duckdb/duckdb-aws-glue#37 (`hive_scan` over a symlink manifest)
- CSVs read from gzipped archives in OneLake Files via `read_csv()` with `ignore_errors=true`
- CI target uses plain DuckDB (no Iceberg) for SQL validation; `FILES_PATH` is unset there so
  the archive falls back to `/tmp`. It runs the download for real (two files per feed)
- Dev/prod targets attach the OneLake Iceberg REST catalog via `database: iceberg_catalog`

## DuckDB version policy
Every duckdb, dbt, pyiceberg and duckdb-wasm version is pinned exactly — none floats on
"latest". Not pinned: the GitHub actions (by major tag), the runner image, and the packages
those pins pull in.
- **`process_data.yml`, `build.yml`, `table_maintenance.yml` and `import_data.yml`'s read venv
  pin `duckdb==2.0.0.dev2609250715`** (dbt via `requirements.txt`, which also pins `dbt-core`/`dbt-duckdb`
  exactly — the insert-only merges lean on adapter internals). 1.6.0 never shipped as stable:
  the line became **DuckDB 2.0.0** (stable due 2026-10-21), and from 2026-09 its pre-releases are
  published as `2.0.0.devYYMMDDHHMM` (the old `1.6.0.dev365` pin was the same line). The
  pre-release is required, not incidental: `iceberg_rewrite_data_files()` (duckdb-iceberg#1035,
  merged 2026-07-09) isn't in a stable release yet, and the compaction job needs it. Pinning the same build everywhere means the
  catalog is only ever touched by one known duckdb. The `iceberg` extension is installed from
  `core` first (`compact_iceberg.py` falls back to `core_nightly`) and its binary is keyed to
  the duckdb build, so pinning duckdb pins the extension too. Move every pin to `duckdb==2.0.0`
  once it ships. duckdb-iceberg has no `expire_snapshots` yet (duckdb-iceberg#1341 is open), so
  pyiceberg stays until that merges.
- **`pyiceberg==0.11.1`** (snapshot expiry, `table_maintenance.yml` only) is pinned on its own
  schedule — it never touches the duckdb file format, only the REST catalog, and the script
  reaches into `RestCatalog._supported_endpoints`, which is exactly the kind of internal a
  floating version breaks. That poke is a fallback: pyiceberg refuses to `commit_table` unless
  `GET /v1/config` advertises the update-table endpoint, and Microsoft's docs show a
  GET/HEAD-only config. The live catalog advertises 13 endpoints including
  `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}` (checked 2026-08-25), so the
  override doesn't fire — the script logs the list each run, which is the evidence.
- **`import_data.yml`'s write venv stays on the 1.5 line (`duckdb==1.5.6`).** Different reason: it
  builds the `.duckdb` files deployed to the NemTracker dashboard, read client-side by
  DuckDB-WASM (1.5.x), so the on-disk file format must stay stable for the *already deployed*
  reader. Patch releases within 1.5 keep the format; don't move it to 2.0 until a duckdb-wasm
  build on 2.0 is pinned in the dashboard.
- **The dashboard pins `@duckdb/duckdb-wasm@1.33.1-dev65.0`** (DuckDB 1.5.x line), a dev build
  because nothing stable has shipped since 1.33.0 (Dec 2025). Don't take npm's `latest` tag:
  it points at `1.33.1-dev57.0`, which the DuckDB blog says breaks OPFS. The dev build lets
  `attachCached` (`dashboard/data.js`) read the OPFS-cached files in place (`registerFileHandle` + `BROWSER_FSACCESS`)
  instead of copying each one into the WASM heap. Register the plain filename, not `opfs://`:
  an `opfs://` ATTACH also opens `<file>.wal`, which is never registered, so the ATTACH fails.
  The handle is exclusive, so a second tab falls back to in-memory. Checked 2026-09-29 in
  headless Chrome against the deployed 1.5.1-written files: renders, 132 → 112 MB.
  It runs **single-threaded on purpose**. The `coi` (threads) build loads, but it can't load
  ICU (`SET TimeZone` fails with a shared-memory LinkError), it can't pass the OPFS handle to
  its pthreads, and it only gained ~1.4x on 4 threads (2026-09-30). The page is therefore not
  cross-origin isolated. The `coi-serviceworker.js` still deployed on the site is a
  self-unregistering kill switch for browsers that installed the old one; it left this repo on
  2026-10-03 and stays published because deploys only add files. Don't delete it from the
  deploy repo: a browser that still has the old worker would keep it.
