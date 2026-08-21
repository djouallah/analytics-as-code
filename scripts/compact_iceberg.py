"""Compact the Iceberg REST catalog's data files (daily maintenance).

process_data commits to the catalog every 30 minutes, so the small tables end up
with ~48 tiny data files a day and nothing ever folds them back together. This
runs iceberg_rewrite_data_files() over each table, consolidating files below the
target size into ~128MiB files.

iceberg_rewrite_data_files landed in duckdb/duckdb-iceberg#1035 (merged
2026-07-09) and is not in a stable duckdb release yet -- the workflow pins
duckdb==1.6.0.dev365, and the iceberg extension comes from core_nightly (the
extension binary is keyed to the duckdb build, so pinning duckdb pins it too).

Exactly one iceberg_metadata() call, in prime(). Do not add more. It enumerates every manifest, which on
a fragmented table is the whole problem we're here to fix -- scripts/iceberg_stats.py
was deleted (a46c55f) for exactly that. The table list is hardcoded rather than
discovered, and the only per-table read is the one in prime(). The function
reports its own rewritten/added counts; that is the report.

Known limitations of the upstream function:
  - manifest-level column statistics are not populated for rewritten files
  - V3 tables and partition spec evolution are unsupported
  - there is no snapshot expiry, so the pre-compaction data files stay in object
    storage until something expires them. Reads get faster immediately; storage
    does not shrink.

Never fails the pipeline: every table is best-effort and errors are printed, not
raised, so a moved nightly just means the tables stay fragmented until tomorrow.

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

# Files smaller than this get folded together; the rest are left alone.
TARGET_FILE_SIZE = "128MiB"
# Don't bother rewriting a table that only has a handful of files. Also what
# keeps already-tidy tables (dim_calendar, anything compacted yesterday) cheap.
MIN_INPUT_FILES = 5
# Stop starting new tables past this much wall clock, so the job reports what it
# did instead of being killed by the runner's timeout mid-rewrite. Keep it well
# under the workflow's timeout-minutes. Whatever gets skipped is picked up by
# tomorrow's run -- compaction is incremental by nature.
BUDGET_MINUTES = float(os.environ.get("COMPACT_BUDGET_MINUTES", "70"))

# Hand-ordered smallest to largest. We know the tables; discovering them costs a
# metadata scan each and buys nothing. A new model just gets added here.
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
    con = duckdb.connect(":memory:")
    # Plain install first. duckdb 1.6.0.dev365 identifies itself as v2.0.0-alpha*,
    # and nightly-extensions.duckdb.org has no iceberg build under that version --
    # asking core_nightly first just buys a 404 and a scary log line. The core
    # extension for this build does carry iceberg_rewrite_data_files.
    try:
        con.install_extension("iceberg")
    except Exception as e:
        print(f"  (core install failed, trying core_nightly: {e})", flush=True)
        con.execute("FORCE INSTALL iceberg FROM core_nightly")
    con.load_extension("iceberg")
    con.execute(f"CREATE SECRET (TYPE ICEBERG, TOKEN '{TOKEN}');")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog (TYPE ICEBERG, ENDPOINT '{ENDPOINT}');")
    return con


def has_rewrite_function(con):
    return (
        con.execute(
            "SELECT count(*) FROM duckdb_functions() "
            "WHERE function_name = 'iceberg_rewrite_data_files'"
        ).fetchone()[0]
        > 0
    )


def prime(con, fq):
    """Make the catalog vend this table's storage credentials.

    iceberg_rewrite_data_files doesn't fetch them itself -- called cold it dies
    with 403 "No credentials are provided" (duckdb/duckdb-iceberg#1349).

    This is the only query known to work. Both cheaper options were tried against
    the real catalog and both still 403'd on the rewrite: LIMIT 0 (planned without
    opening a file) and LIMIT 1 (reads a data file, but not the manifests). The
    403 is on the manifest avro, and iceberg_metadata() is what reads those.

    It is expensive -- it enumerates every manifest -- so it is the one and only
    metadata call here. Don't add more, and don't "optimise" this one away.
    """
    con.execute(f"SELECT count(*) FROM iceberg_metadata('{fq}')")


def compact(con, table, say):
    """Compact one table. Returns (table, status) for the report."""
    fq = f"catalog.{table}"

    say("priming credentials")
    try:
        prime(con, fq)
    except Exception as e:
        return (table, f"ERROR priming: {type(e).__name__}: {e}")

    say("rewriting")
    try:
        row = con.execute(
            f"SELECT rewritten_data_files, added_data_files, rewritten_bytes "
            f"FROM iceberg_rewrite_data_files('{fq}', "
            f"target_file_size_bytes => '{TARGET_FILE_SIZE}', "
            f"min_input_files => {MIN_INPUT_FILES})"
        ).fetchone()
    except Exception as e:
        return (table, f"ERROR: {type(e).__name__}: {e}")

    # No row means nothing was eligible -- not an error.
    rewritten, added, rewritten_bytes = row if row else (0, 0, 0)
    if not rewritten:
        return (table, f"skipped (<{MIN_INPUT_FILES} eligible files)")

    mb = (rewritten_bytes or 0) / 1048576.0
    return (table, f"OK ({rewritten} -> {added} files, {mb:.1f} MB rewritten)")


def report(lines, duckdb_version):
    out = ["=" * 100, f"Iceberg compaction (duckdb {duckdb_version})", "-" * 100]
    for table, status in lines:
        out.append(f"{table:<32}{status}")
    out.append("=" * 100)
    print("\n".join(out))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Iceberg compaction (duckdb {duckdb_version})\n\n")
            f.write("| table | result |\n|---|---|\n")
            for table, status in lines:
                f.write(f"| `{table}` | {status} |\n")
            f.write("\n")


def main():
    version = duckdb.__version__
    print(f"duckdb {version} -- compacting {len(TABLES)} table(s) at {TARGET_FILE_SIZE}, "
          f"min_input_files={MIN_INPUT_FILES}, budget={BUDGET_MINUTES:g}min, in order:")
    for t in TABLES:
        print(f"  - catalog.{t}")
    print(flush=True)

    con = connect()
    if not has_rewrite_function(con):
        print(
            f"iceberg_rewrite_data_files() not available in duckdb {version} -- "
            "the pinned nightly or its core_nightly iceberg extension has moved. "
            "Nothing compacted."
        )
        return

    started = time.monotonic()
    total = len(TABLES)
    lines = []
    for i, table in enumerate(TABLES, 1):
        elapsed = (time.monotonic() - started) / 60.0
        if elapsed >= BUDGET_MINUTES:
            # Never drop tables silently -- say which ones and why.
            for skipped in TABLES[i - 1:]:
                lines.append((skipped,
                              f"not attempted ({BUDGET_MINUTES:g}min budget spent)"))
            print(f"time budget spent after {elapsed:.1f}min -- not attempting: "
                  f"{', '.join(TABLES[i - 1:])}", flush=True)
            break

        prefix = f"[{i}/{total}] catalog.{table}"

        def say(phase, _prefix=prefix):
            # Which step it's on, so a slow table can't be mistaken for a hang.
            print(f"{_prefix} ... {phase}", flush=True)

        print(f"{prefix} ... ({elapsed:.1f}min elapsed)", flush=True)
        _, status = compact(con, table, say)
        took = (time.monotonic() - started) / 60.0 - elapsed
        print(f"{prefix}: {status}  [{took:.1f}min]\n", flush=True)
        lines.append((table, status))

    report(lines, version)
    con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"compact_iceberg failed (non-fatal): {e}", file=sys.stderr)
