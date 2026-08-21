"""Compact the Iceberg REST catalog's data files (daily maintenance).

process_data commits to the catalog every 30 minutes, so the small tables end up
with ~48 tiny data files a day and nothing ever folds them back together. This
runs iceberg_rewrite_data_files() over every table in the catalog, consolidating
files below the target size into ~128MiB files.

iceberg_rewrite_data_files landed in duckdb/duckdb-iceberg#1035 (merged
2026-07-09) and is not in a stable duckdb release yet -- the workflow pins
duckdb==1.6.0.dev365, and the iceberg extension comes from core_nightly (the
extension binary is keyed to the duckdb build, so pinning duckdb pins it too).

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

import duckdb

ENDPOINT = os.environ["ICEBERG_REST_ENDPOINT"]
TOKEN = os.environ["ICEBERG_TOKEN"]
WAREHOUSE = os.environ["ICEBERG_WAREHOUSE"]

# Files smaller than this get folded together; the rest are left alone.
TARGET_FILE_SIZE = "128MiB"
# Don't bother rewriting a table that only has a handful of files. Also what
# keeps already-tidy tables (dim_calendar, anything compacted yesterday) cheap.
MIN_INPUT_FILES = 5

# Fallback list if catalog discovery fails (schema.table).
KNOWN_TABLES = [
    "landing.stg_csv_archive_log",
    "landing.fct_scada",
    "landing.fct_price",
    "landing.fct_scada_today",
    "landing.fct_price_today",
    "mart.dim_calendar",
    "mart.dim_duid",
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
    """Return the scalar, or None if the query can't run. Never raises."""
    try:
        return con.execute(sql).fetchone()[0]
    except Exception:
        return None


def by_content(con, fq, agg, labels, codes):
    """Aggregate iceberg_metadata rows of a given content kind.

    The `content` column has been spelled both as a label ('DATA') and as the
    Iceberg spec's integer code (0), so try both and give up (None) rather than
    silently aggregating over the wrong set of files.
    """
    for pred in (f"content IN ({labels})", f"content IN ({codes})"):
        v = try_scalar(con, f"SELECT {agg} FROM iceberg_metadata('{fq}') WHERE {pred}")
        if v is not None:
            return v
    return None


def stats(con, fq):
    """(data_files, size_mb, snapshots, rows, delete_files) -- metadata only, never scans data."""
    data_files = by_content(con, fq, "count(*)", "'DATA'", "0")
    if data_files is None:  # content column unusable; fall back to every manifest entry
        data_files = try_scalar(con, f"SELECT count(*) FROM iceberg_metadata('{fq}')")
    return (
        data_files,
        try_scalar(
            con,
            f"SELECT round(coalesce(sum(file_size_in_bytes), 0) / 1024.0 / 1024.0, 1) "
            f"FROM iceberg_metadata('{fq}')",
        ),
        try_scalar(con, f"SELECT count(*) FROM iceberg_snapshots('{fq}')"),
        by_content(con, fq, "coalesce(sum(record_count), 0)", "'DATA'", "0"),
        by_content(con, fq, "count(*)", "'POSITION_DELETES','EQUALITY_DELETES'", "1,2"),
    )


def compact(con, table):
    """Compact one table. Returns a result row for the report."""
    fq = f"catalog.{table}"
    files_before, mb_before, snaps_before, rows_before, deletes_before = stats(con, fq)

    try:
        row = con.execute(
            f"SELECT rewritten_data_files, added_data_files, rewritten_bytes "
            f"FROM iceberg_rewrite_data_files('{fq}', "
            f"target_file_size_bytes => '{TARGET_FILE_SIZE}', "
            f"min_input_files => {MIN_INPUT_FILES})"
        ).fetchone()
    except Exception as e:
        return (table, files_before, files_before, mb_before, snaps_before,
                "ERROR: " + str(e).splitlines()[0][:100])

    # No row means nothing was eligible -- not an error.
    rewritten, added, rewritten_bytes = row if row else (0, 0, 0)
    files_after, mb_after, snaps_after, rows_after, _ = stats(con, fq)

    if not rewritten:
        status = f"skipped (<{MIN_INPUT_FILES} eligible files)"
    else:
        mb = (rewritten_bytes or 0) / 1024.0 / 1024.0
        status = f"OK ({rewritten} -> {added} files, {mb:.1f} MB)"

    # Compaction applies pending merge-on-read deletes as it rewrites, so a table
    # that had delete files legitimately loses rows here. Only flag what can never
    # be legitimate: rows appearing, or rows vanishing with nothing to delete them.
    if rows_before is not None and rows_after is not None and rows_before != rows_after:
        delta = f"rows {rows_before:,} -> {rows_after:,}"
        if rows_after > rows_before or deletes_before == 0:
            status = f"ROW COUNT CHANGED {delta} !! " + status
        else:
            status = f"{status}; {delta} ({deletes_before} delete files applied)"

    return (table, files_before, files_after, mb_after, snaps_after, status)


def fmt(v):
    if v is None:
        return "?"
    return f"{v:,}" if isinstance(v, int) else str(v)


def report(lines, duckdb_version):
    header = (
        f"{'table':<32}{'files_before':>14}{'files_after':>13}"
        f"{'MB':>10}{'snapshots':>11}  status"
    )
    out = ["=" * 110, f"Iceberg compaction (duckdb {duckdb_version})", header, "-" * 110]
    for table, before, after, mb, snaps, status in lines:
        out.append(
            f"{table:<32}{fmt(before):>14}{fmt(after):>13}"
            f"{fmt(mb):>10}{fmt(snaps):>11}  {status}"
        )
    out.append("=" * 110)
    print("\n".join(out))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Iceberg compaction (duckdb {duckdb_version})\n\n")
            f.write("| table | files before | files after | MB | snapshots | status |\n")
            f.write("|---|--:|--:|--:|--:|---|\n")
            for table, before, after, mb, snaps, status in lines:
                f.write(
                    f"| `{table}` | {fmt(before)} | {fmt(after)} | "
                    f"{fmt(mb)} | {fmt(snaps)} | {status} |\n"
                )
            f.write("\n")


def main():
    con = connect()
    version = duckdb.__version__

    if not has_rewrite_function(con):
        print(
            f"iceberg_rewrite_data_files() not available in duckdb {version} -- "
            "the pinned nightly or its core_nightly iceberg extension has moved. "
            "Nothing compacted."
        )
        return

    tables = discover_tables(con)
    total = len(tables)
    print(f"duckdb {version} -- compacting {total} table(s) at {TARGET_FILE_SIZE}, "
          f"min_input_files={MIN_INPUT_FILES}")
    for t in tables:
        print(f"  - catalog.{t}")
    print(flush=True)

    # Print each table as it finishes rather than only in the summary, so a long
    # rewrite is visible live in the CI log instead of looking hung.
    lines = []
    for i, table in enumerate(tables, 1):
        print(f"[{i}/{total}] catalog.{table} ...", flush=True)
        line = compact(con, table)
        _, before, after, _, _, status = line
        print(f"[{i}/{total}] catalog.{table}: "
              f"{fmt(before)} -> {fmt(after)} files  {status}\n", flush=True)
        lines.append(line)

    report(lines, version)
    con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"compact_iceberg failed (non-fatal): {e}", file=sys.stderr)
