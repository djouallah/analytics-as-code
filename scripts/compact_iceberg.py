"""Compact the Iceberg REST catalog's data files (daily maintenance).

process_data commits to the catalog every 30 minutes, so the tables accumulate
small data files and nothing folds them back together. This runs
iceberg_rewrite_data_files() over each table and prints what it returns.

That function landed in duckdb/duckdb-iceberg#1035 (merged 2026-07-09) and is not
in a stable duckdb release yet, so the workflow pins duckdb==1.6.0.dev365.

Do not add metadata queries here. iceberg_metadata() enumerates every manifest,
which on a fragmented table costs more than the compaction itself -- it burned 33
minutes before the first table in an earlier version, and scripts/iceberg_stats.py
was deleted (a46c55f) for the same reason. The function reports its own numbers;
that is the report.

Never fails the pipeline: each table is best-effort and errors are printed, not
raised.

Usage:
    python scripts/compact_iceberg.py
"""

import os
import sys
import time

import duckdb

ENDPOINT = os.environ["ICEBERG_REST_ENDPOINT"]
TOKEN = os.environ["ICEBERG_TOKEN"]
WAREHOUSE = os.environ["ICEBERG_WAREHOUSE"]

TARGET_FILE_SIZE = "128MiB"
MIN_INPUT_FILES = 5

# Hand-ordered smallest to largest. A new model just gets added here.
TABLES = [
    "mart.dim_calendar",
    "mart.dim_duid",
    "landing.stg_csv_archive_log",
    "landing.fct_price_today",
    "landing.fct_scada_today",
    "landing.fct_price",
    "landing.fct_scada",
]


def connect():
    # No install/load: duckdb autoloads iceberg from core when it sees the
    # ICEBERG secret type.
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE SECRET (TYPE ICEBERG, TOKEN '{TOKEN}');")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog (TYPE ICEBERG, ENDPOINT '{ENDPOINT}');")
    return con


def main():
    print(f"duckdb {duckdb.__version__} -- compacting {len(TABLES)} table(s) "
          f"at {TARGET_FILE_SIZE}, min_input_files={MIN_INPUT_FILES}, in order:")
    for t in TABLES:
        print(f"  - catalog.{t}")
    print(flush=True)

    con = connect()
    results = []

    for i, table in enumerate(TABLES, 1):
        print(f"[{i}/{len(TABLES)}] catalog.{table} ...", flush=True)
        started = time.monotonic()
        try:
            rewritten, added, rewritten_bytes = con.execute(
                f"SELECT rewritten_data_files, added_data_files, rewritten_bytes "
                f"FROM iceberg_rewrite_data_files('catalog.{table}', "
                f"target_file_size_bytes => '{TARGET_FILE_SIZE}', "
                f"min_input_files => {MIN_INPUT_FILES})"
            ).fetchone()
            outcome = (f"{rewritten} rewritten -> {added} added, "
                       f"{rewritten_bytes / 1048576.0:.1f} MB")
        except Exception as e:
            outcome = "ERROR: " + str(e).splitlines()[0][:120]

        mins = (time.monotonic() - started) / 60.0
        print(f"[{i}/{len(TABLES)}] catalog.{table}: {outcome}  [{mins:.1f}min]\n",
              flush=True)
        results.append((table, outcome, mins))

    print("=" * 88)
    print(f"Iceberg compaction (duckdb {duckdb.__version__})")
    print("-" * 88)
    for table, outcome, mins in results:
        print(f"{table:<32}{mins:>7.1f}min  {outcome}")
    print("=" * 88)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Iceberg compaction (duckdb {duckdb.__version__})\n\n")
            f.write("| table | minutes | result |\n|---|--:|---|\n")
            for table, outcome, mins in results:
                f.write(f"| `{table}` | {mins:.1f} | {outcome} |\n")
            f.write("\n")

    con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"compact_iceberg failed (non-fatal): {e}", file=sys.stderr)
