# CLAUDE.md — iceberg_as_code

## Quick Reference
- **Stack:** dbt-duckdb, **OneLake Iceberg REST catalog** (Microsoft Fabric workspace `power`,
  lakehouse `nem` — its own lakehouse, deliberately separate from dbt_fabric_python_iceberg's
  `data`, because both repos write identically-named tables in `landing`/`mart`)
- **Run:** `dbt build --target ci --profiles-dir .` (test, in-memory)
- **Run:** `dbt build --target dev --profiles-dir .` (writes to Iceberg; needs the OneLake env vars below)
- **Schemas:** `mart` (dim_calendar, dim_duid) / `landing` (facts, staging)
- **Writes are insert-only merges** (`WHEN MATCHED DO NOTHING`): the OneLake catalog accepts
  one add-snapshot per commit and rejects commits mixing delete files + data files
  (BadRequest 400). Same pattern as dbt_fabric_python_iceberg. `dim_calendar` keeps
  `delete+insert` — its NOT-IN filter means incoming rows never match, so commits stay pure
  appends.

## The dbt project is a subset copy of the sibling repo
`models/`, `macros/` and the `assert_fct_*_grain` tests are copied verbatim from
[`dbt_fabric_python_iceberg`](https://github.com/djouallah/dbt_fabric_python_iceberg)'s `dbt/`
directory, minus `fct_summary` / `fct_summary_daily` (this repo's dashboard computes that join
client-side in `scripts/cache_catalog.py`). **Port fixes from there rather than diverging.**
Three deliberate local differences, all of which must survive a re-copy:
- No `relationships → dim_duid` tests on `fct_scada`/`fct_scada_today` — `dim_duid` holds only
  currently-registered DUIDs while the facts go back to 2018 and are full of retired ones, so
  the test could never be 0. `tests/assert_recent_scada_duids_registered.sql` is the meaningful
  version and is this repo's own.
- `tests/assert_all_*_files_processed_*.sql` use `NOT EXISTS` and are untagged; the sibling's
  use `NOT IN` (a single NULL `file` makes them permanently green) and are tagged `heavy`.
- `profiles.yml` keeps a `ci` target (in-memory, no Iceberg) for `build.yml`, and
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
2. **No daily/intraday split.** Every 30-minute pass does all three feeds plus the DUID
   reference, self-gated on data rather than on a schedule: the DUID download is skipped while
   the last one is < 24h old, and the GitHub historical backfill listing only runs when AEMO
   returned fewer than `download_limit` new files. There is no `daily_refresh` env var.
3. Work is discovered from the **log table**, not a filesystem glob: each fact model's pre-hook
   builds its path list from `stg_csv_archive_log.archive_path` filtered by
   `csv_filename NOT IN (SELECT file FROM {{ this }})`.
4. `process_data.yml` runs `dbt run` (tests live in `test.yml`), writing straight to the
   OneLake Iceberg catalog. No `dbt run-operation` anywhere — there are no operation macros.
5. **Compaction:** the `compact` job in `test.yml` runs `scripts/compact_iceberg.py`, folding
   each table's small data files together via `iceberg_rewrite_data_files()`. It lives in
   *that* workflow but takes a job-level `process-data` concurrency group — compaction commits
   optimistically, so an overlap with a load could fail one side. It is `continue-on-error` and
   the script always exits 0: maintenance must never fail the pipeline or block
   `import_data.yml`'s `workflow_run` gate. There is no snapshot expiry, so reads get faster
   but storage doesn't shrink.

## Don't design anything that needs DELETE
Every write is an append. On OneLake a commit may carry only one add-snapshot, so anything
that mixes delete files with data files is rejected outright (`BadRequest 400`) — hence the
insert-only merges. On the previous (R2-backed) catalog `DELETE` had a nastier failure mode:
it **succeeded without applying** whenever the predicate contained subqueries over *other*
Iceberg tables, silently no-op'ing for weeks. Both histories point the same way: design the
path so it needs no `DELETE`, and never assume one landed — re-count and log the delta.

`scripts/catalog_capabilities.py` probes CREATE/INSERT/DELETE/UPDATE/MERGE/DROP against a
freshly created table each night. That matrix is the standing evidence for what this catalog
actually does; check it before relying on any claim here.

## Auth (GitHub Actions) — no secrets
OIDC only: `azure/login@v2` with a federated credential, then each job mints a short-lived
`ONELAKE_TOKEN` via `az account get-access-token --resource https://storage.azure.com/`.
The ids live in repository **variables** (public identifiers, not secrets):
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` — the tenant + Entra app (`dbt_fabric_python_iceberg`,
  no client secret; shared with the sibling repo)
- `WS_ID` — the Fabric workspace (`power`). **The lakehouse id is deliberately NOT a
  variable**: every OneLake-touching job has a "Resolve lakehouse" step that calls
  `duckrun.workspace(WS_ID).create_lakehouse('nem')` (idempotent create-if-missing) and
  exports `WAREHOUSE_PATH` + `FILES_PATH` to `$GITHUB_ENV`. A pinned id goes stale the moment
  the lakehouse is recreated — which is exactly what happened. `$GITHUB_ENV` doesn't cross
  jobs, so each job resolves it again.
Env contract consumed by profiles.yml, the models and the scripts: `ONELAKE_ENDPOINT`,
`ONELAKE_TOKEN`, `WAREHOUSE_PATH`, `FILES_PATH`, `download_limit`, `process_limit`, plus
`AZURE_TRANSPORT_OPTION_TYPE=curl` + `CURL_CA_INFO` on runners (the azure extension's default
transport fails the OneLake TLS handshake).
`NEMTRACKER_TOKEN` (gh-pages deploy) is the one remaining true secret.

## Models (7)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental append (Python) |
| dim_calendar | mart | incremental delete+insert (pure append in practice — the NOT-IN filter means incoming rows never match) |
| dim_duid | mart | incremental insert-only merge on DUID |
| fct_scada, fct_price | landing | incremental insert-only merge (by file) |
| fct_scada_today, fct_price_today | landing | incremental insert-only merge (by file) |

`dim_duid`'s insert-only merge means attribute changes (region/fuel/geo) never update in
place; `dbt run --full-refresh -s dim_duid` is the reconciliation lever.

## Profiles: ci (in-memory, no Iceberg), dev/prod (OneLake Iceberg REST catalog)

## Key Patterns
- Pre-hooks set DuckDB VARIABLEs with the file paths to process, read from the log table
- CSVs read from gzipped archives in OneLake Files via `read_csv()` with `ignore_errors=true`
- CI target uses plain DuckDB (no Iceberg) for SQL validation; `FILES_PATH` is unset there so
  the archive falls back to `/tmp`
- Dev/prod targets attach the OneLake Iceberg REST catalog via `database: iceberg_catalog`

## DuckDB version policy
Everything is pinned — no workflow floats on "latest".
- **`process_data.yml`, `build.yml`, `test.yml` pin `duckdb==1.6.0.dev365`.** That nightly is
  required, not incidental: `iceberg_rewrite_data_files()` (duckdb-iceberg#1035, merged
  2026-07-09) isn't in a stable release yet, and the compaction job needs it. Pinning the
  same build everywhere means the catalog is only ever touched by one known duckdb. The
  `iceberg` extension comes from `core_nightly` and its binary is keyed to the duckdb build,
  so pinning duckdb pins the extension too. Collapse all three back to a stable release once
  1.6.0 ships.
- **`import_data.yml` stays on `duckdb==1.5.1`.** Different reason, deliberately unchanged: it
  builds the `.duckdb` files deployed to the NemTracker dashboard, read client-side by
  DuckDB-WASM, so the on-disk file format must stay stable for the *already deployed* reader.
