# CLAUDE.md — iceberg_as_code

## Quick Reference
- **Stack:** dbt-duckdb, Iceberg REST catalog
- **Run:** `dbt build --target ci --profiles-dir .` (test, in-memory)
- **Run:** `dbt build --target dev --profiles-dir .` (writes to Iceberg)
- **Schemas:** `mart` (dim_calendar, dim_duid, fct_summary) / `landing` (facts, staging)

## Architecture
1. `stg_csv_archive_log.py` (Python model) downloads data from AEMO + GitHub, stores as gzipped CSVs locally
2. DUID reference data skipped if downloaded < 24 hours ago
3. Fact models read from local CSV archives incrementally (file-based), dimensions are smart-refresh
4. `fct_summary` rolls up daily + intraday SCADA and price data
5. CI/CD runs `dbt build` to write directly to Iceberg catalog

## Required Secrets (GitHub Actions)
- `ICEBERG_REST_ENDPOINT` — REST catalog URL (e.g. `https://polaris.example.com/api/catalog`)
- `ICEBERG_TOKEN` — Bearer token for catalog auth
- `ICEBERG_WAREHOUSE` — Warehouse path in the catalog

## Models (8)
| Model | Schema | Materialization |
|-------|--------|-----------------|
| stg_csv_archive_log | landing | incremental (Python) |
| dim_calendar | mart | incremental (one-time) |
| dim_duid | mart | incremental (smart refresh) |
| fct_scada, fct_price | landing | incremental (by file) |
| fct_scada_today, fct_price_today | landing | incremental (by file) |
| fct_summary | mart | incremental (append) |

## Profiles: ci (in-memory, no Iceberg), dev/prod (Iceberg REST catalog)

## Key Patterns
- Pre-hooks set DuckDB VARIABLEs with file paths for incremental processing
- CSVs read from gzipped archives via `read_csv()` with `ignore_errors=true`
- CI target uses plain DuckDB (no Iceberg) for SQL validation
- Dev/prod targets attach Iceberg REST catalog via `database: iceberg_catalog`
