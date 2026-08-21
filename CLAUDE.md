# CLAUDE.md — iceberg_as_code

## Quick Reference
- **Stack:** dbt-duckdb, Iceberg REST catalog
- **Run:** `dbt build --target ci --profiles-dir .` (test, in-memory)
- **Run:** `dbt build --target dev --profiles-dir .` (writes to Iceberg)
- **Schemas:** `mart` (dim_calendar, dim_duid) / `landing` (facts, staging)

## Architecture
1. `stg_csv_archive_log.py` (Python model) downloads data from AEMO + GitHub, stores as gzipped CSVs locally
2. **Daily pass vs intraday cycle:** `process_data` runs every 30 min (intraday) and once at 19:00 UTC (daily). The daily run sets `daily_refresh=true`, which gates the slow / rarely-changing work — GitHub historical backfill *and* the DUID reference download + `dim_duid` rebuild. The 30-min intraday runs skip all of that and reuse the already-materialized Iceberg `dim_duid`. (Ephemeral CI wipes local files each run, so the old "skip DUID if < 24h" guard could never fire — `dim_duid` reads the raw CSVs from local disk, so they must be re-downloaded whenever it rebuilds.)
3. Fact models read from local CSV archives incrementally (file-based), dimensions are smart-refresh
4. CI/CD runs `dbt build` to write directly to Iceberg catalog
5. **Daily compaction:** the `compact` job in `process_data.yml` runs `scripts/compact_iceberg.py`
   after a daily pass (or on a `force_compact=true` dispatch), folding each table's small data
   files into ~128MiB ones via `iceberg_rewrite_data_files()`. It lives in *that* workflow so the
   workflow-level `process-data` concurrency group covers it — compaction commits optimistically
   and the `delete+insert` models remove data files, so an overlap with an intraday run would fail
   one side. It is `continue-on-error` and the script always exits 0: maintenance must never fail
   the pipeline or block `import_data.yml`'s `workflow_run` gate. Note there is no snapshot
   expiry, so reads get faster but storage doesn't shrink.

## Required Secrets (GitHub Actions)
- `ICEBERG_REST_ENDPOINT` — REST catalog URL (e.g. `https://polaris.example.com/api/catalog`)
- `ICEBERG_TOKEN` — Bearer token for catalog auth
- `ICEBERG_WAREHOUSE` — Warehouse path in the catalog

## Models (7)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental (Python) |
| dim_calendar | mart | incremental (one-time) |
| dim_duid | mart | incremental (smart refresh) |
| fct_scada, fct_price | landing | incremental (by file) |
| fct_scada_today, fct_price_today | landing | incremental (by file) |

## Profiles: ci (in-memory, no Iceberg), dev/prod (Iceberg REST catalog)

## Key Patterns
- Pre-hooks set DuckDB VARIABLEs with file paths for incremental processing
- CSVs read from gzipped archives via `read_csv()` with `ignore_errors=true`
- CI target uses plain DuckDB (no Iceberg) for SQL validation
- Dev/prod targets attach Iceberg REST catalog via `database: iceberg_catalog`

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
