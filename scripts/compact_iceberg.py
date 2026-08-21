"""Compact the Iceberg REST catalog's data files (daily maintenance).

process_data commits to the catalog every 30 minutes, so the small tables end up
with ~48 tiny data files a day and nothing ever folds them back together. This
runs iceberg_rewrite_data_files() over each table, consolidating files below the
target size into ~128MiB files.

iceberg_rewrite_data_files landed in duckdb/duckdb-iceberg#1035 (merged
2026-07-09) and is not in a stable duckdb release yet -- the workflow pins
duckdb==1.6.0.dev365, and the iceberg extension comes from core_nightly (the
extension binary is keyed to the duckdb build, so pinning duckdb pins it too).

iceberg_metadata() is EXPENSIVE: it enumerates every manifest, which on a
fragmented table is the whole problem we're here to fix. scripts/iceberg_stats.py
was deleted (a46c55f) for exactly this. So: the table list is hardcoded rather
than discovered, ordered smallest-first by hand, and each table's stats come from
a single pass, taken once before and once after. Don't add a query per metric.

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
    try:
        con.execute("FORCE INSTALL iceberg FROM core_nightly")
    except Exception as e:
        print(f"  (core_nightly install failed, falling back to core: {e})")
        con.install_extension("iceberg")
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


def try_row(con, sql):
    """Return the first row, or None if the query can't run. Never raises."""
    try:
        return con.execute(sql).fetchone()
    except Exception:
        return None


def stats(con, fq):
    """(data_files, size_mb, rows, delete_files) in ONE pass over the manifests.

    The `content` column has been spelled both as a label ('DATA') and as the
    Iceberg spec's integer code (0), so try both spellings -- but only ever one
    scan per attempt, never one scan per metric.
    """
    for data in ("'DATA'", "0"):
        row = try_row(
            con,
            f"SELECT count(*) FILTER (WHERE content IN ({data})), "
            f"       round(coalesce(sum(file_size_in_bytes), 0) / 1048576.0, 1), "
            f"       coalesce(sum(record_count) FILTER (WHERE content IN ({data})), 0), "
            f"       count(*) FILTER (WHERE content NOT IN ({data})) "
            f"FROM iceberg_metadata('{fq}')",
        )
        if row is not None:
            return row
    # content unusable -- fall back to a plain file count so the report still says
    # something useful about whether compaction moved the needle.
    row = try_row(con, f"SELECT count(*), NULL, NULL, NULL FROM iceberg_metadata('{fq}')")
    return row if row is not None else (None, None, None, None)


def compact(con, table):
    """Compact one table. Returns a result row for the report."""
    fq = f"catalog.{table}"
    files_before, mb_before, rows_before, deletes_before = stats(con, fq)

    try:
        row = con.execute(
            f"SELECT rewritten_data_files, added_data_files, rewritten_bytes "
            f"FROM iceberg_rewrite_data_files('{fq}', "
            f"target_file_size_bytes => '{TARGET_FILE_SIZE}', "
            f"min_input_files => {MIN_INPUT_FILES})"
        ).fetchone()
    except Exception as e:
        return (table, files_before, files_before, mb_before,
                "ERROR: " + str(e).splitlines()[0][:100])

    # No row means nothing was eligible -- not an error.
    rewritten, added, rewritten_bytes = row if row else (0, 0, 0)

    if not rewritten:
        # Nothing changed, so don't pay for a second manifest scan.
        return (table, files_before, files_before, mb_before,
                f"skipped (<{MIN_INPUT_FILES} eligible files)")

    files_after, mb_after, rows_after, _ = stats(con, fq)
    mb = (rewritten_bytes or 0) / 1048576.0
    status = f"OK ({rewritten} -> {added} files, {mb:.1f} MB rewritten)"

    # Compaction applies pending merge-on-read deletes as it rewrites, so a table
    # that had delete files legitimately loses rows here. Only flag what can never
    # be legitimate: rows appearing, or rows vanishing with nothing to delete them.
    if rows_before is not None and rows_after is not None and rows_before != rows_after:
        delta = f"rows {rows_before:,} -> {rows_after:,}"
        if rows_after > rows_before or deletes_before == 0:
            status = f"ROW COUNT CHANGED {delta} !! " + status
        else:
            status = f"{status}; {delta} ({deletes_before} delete files applied)"

    return (table, files_before, files_after, mb_after, status)


def fmt(v):
    if v is None:
        return "?"
    return f"{v:,}" if isinstance(v, int) else str(v)


def report(lines, duckdb_version):
    header = f"{'table':<32}{'files_before':>14}{'files_after':>13}{'MB':>10}  status"
    out = ["=" * 110, f"Iceberg compaction (duckdb {duckdb_version})", header, "-" * 110]
    for table, before, after, mb, status in lines:
        out.append(
            f"{table:<32}{fmt(before):>14}{fmt(after):>13}{fmt(mb):>10}  {status}"
        )
    out.append("=" * 110)
    print("\n".join(out))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Iceberg compaction (duckdb {duckdb_version})\n\n")
            f.write("| table | files before | files after | MB | status |\n")
            f.write("|---|--:|--:|--:|---|\n")
            for table, before, after, mb, status in lines:
                f.write(
                    f"| `{table}` | {fmt(before)} | {fmt(after)} | {fmt(mb)} | {status} |\n"
                )
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
                lines.append((skipped, None, None, None,
                              f"not attempted ({BUDGET_MINUTES:g}min budget spent)"))
            print(f"time budget spent after {elapsed:.1f}min -- not attempting: "
                  f"{', '.join(TABLES[i - 1:])}", flush=True)
            break

        print(f"[{i}/{total}] catalog.{table} ... ({elapsed:.1f}min elapsed)", flush=True)
        line = compact(con, table)
        took = (time.monotonic() - started) / 60.0 - elapsed
        print(f"[{i}/{total}] catalog.{table}: {fmt(line[1])} -> {fmt(line[2])} files  "
              f"{line[4]}  [{took:.1f}min]\n", flush=True)
        lines.append(line)

    report(lines, version)
    con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"compact_iceberg failed (non-fatal): {e}", file=sys.stderr)
