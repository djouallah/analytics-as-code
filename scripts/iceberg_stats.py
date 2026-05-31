"""Print per-table stats for the Iceberg REST catalog (diagnostic only).

Shows row count, data-file count, snapshot count, and total size for every
table in the catalog. Useful for spotting tables that aren't being compacted
(high file/snapshot count relative to rows).

Never fails the pipeline: every metric is best-effort and errors are printed,
not raised. Run as the last step of a workflow.

Usage:
    python scripts/iceberg_stats.py
"""

import os
import sys

import duckdb

ENDPOINT = os.environ["ICEBERG_REST_ENDPOINT"]
TOKEN = os.environ["ICEBERG_TOKEN"]
WAREHOUSE = os.environ["ICEBERG_WAREHOUSE"]

# Fallback list if catalog discovery fails (schema.table).
KNOWN_TABLES = [
    "landing.stg_csv_archive_log",
    "landing.fct_scada",
    "landing.fct_price",
    "landing.fct_scada_today",
    "landing.fct_price_today",
    "mart.dim_calendar",
    "mart.dim_duid",
    "mart.fct_summary",
]


def connect():
    con = duckdb.connect(":memory:")
    con.install_extension("iceberg")
    con.load_extension("iceberg")
    con.execute(f"CREATE SECRET (TYPE ICEBERG, TOKEN '{TOKEN}');")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog (TYPE ICEBERG, ENDPOINT '{ENDPOINT}');")
    return con


def discover_tables(con):
    try:
        rows = con.execute(
            "SELECT table_schema || '.' || table_name "
            "FROM information_schema.tables "
            "WHERE table_catalog = 'catalog' "
            "ORDER BY table_schema, table_name"
        ).fetchall()
        found = [r[0] for r in rows]
        if found:
            return found
    except Exception as e:
        print(f"  (table discovery failed, using hardcoded list: {e})")
    return KNOWN_TABLES


def try_scalar(con, sql):
    try:
        return con.execute(sql).fetchone()[0]
    except Exception as e:
        return f"err: {str(e).splitlines()[0][:40]}"


def main():
    con = connect()
    tables = discover_tables(con)

    print("=" * 96)
    print("Iceberg table stats")
    print(f"{'table':<36}{'rows':>14}{'data_files':>12}{'snapshots':>12}{'size_MB':>12}")
    print("-" * 96)

    for t in tables:
        fq = f"catalog.{t}"
        rows = try_scalar(con, f"SELECT count(*) FROM {fq}")
        files = try_scalar(con, f"SELECT count(*) FROM iceberg_metadata('{fq}')")
        size_mb = try_scalar(
            con,
            f"SELECT round(coalesce(sum(file_size_in_bytes), 0) / 1024.0 / 1024.0, 1) "
            f"FROM iceberg_metadata('{fq}')",
        )
        snaps = try_scalar(con, f"SELECT count(*) FROM iceberg_snapshots('{fq}')")

        def fmt(v):
            return f"{v:,}" if isinstance(v, int) else str(v)

        print(f"{t:<36}{fmt(rows):>14}{fmt(files):>12}{fmt(snaps):>12}{fmt(size_mb):>12}")

    print("=" * 96)
    con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Diagnostic step must never fail the pipeline.
        print(f"iceberg_stats failed (non-fatal): {e}", file=sys.stderr)
