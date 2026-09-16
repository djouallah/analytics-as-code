"""Drop one catalog table so the next dbt run recreates it from the CSV archive.

This is the only way to get rid of bad rows on this catalog: every write is an append
and DELETE is off the table (see CLAUDE.md). Don't reach for `dbt run --full-refresh`
instead — dbt-duckdb's full-refresh path builds `<table>__dbt_tmp` and then RENAMEs it
into place, and RENAME is not in the probed capability matrix. Dropping the table and
letting the next incremental run find no existing relation takes the plain CTAS path,
the one that built every table on 2026-08-25.

Consequences: the fact is refilled at process_limit files per run, so the dashboard
shows partial history until the backlog drains; the dropped data files stay in OneLake
(nothing here purges storage).

Usage (process_data.yml, workflow_dispatch input `rebuild`):
    REBUILD_TABLE=fct_scada python scripts/rebuild_table.py

Exits non-zero on any failure: a rebuild the operator asked for must not silently turn
into an ordinary incremental load.
"""

import os
import sys

from compact_iceberg import connect, oneline
from iceberg_tables import TABLES


def main():
    name = os.environ.get("REBUILD_TABLE", "").strip()
    if not name:
        print("REBUILD_TABLE not set — nothing to drop")
        return 0

    # Accept "fct_scada" or "landing.fct_scada", but only names from the maintained list.
    matches = [t for t in TABLES if t == name or t.split(".", 1)[1] == name]
    if len(matches) != 1:
        print(f"::error::'{name}' is not one of the maintained tables: {', '.join(TABLES)}")
        return 1
    table = matches[0]
    fq = f"catalog.{table}"

    con = connect()
    try:
        before = con.execute(f"SELECT count(*) FROM {fq}").fetchone()[0]
    except Exception as e:
        print(f"::error::cannot read {fq} before dropping it: {oneline(e)}")
        return 1
    print(f"{fq}: {before:,} rows — dropping", flush=True)

    try:
        con.execute(f"DROP TABLE {fq}")
    except Exception as e:
        print(f"::error::DROP TABLE {fq} failed: {oneline(e)}")
        return 1

    schema, tbl = table.split(".", 1)
    still = con.execute(
        "SELECT count(*) FROM duckdb_tables() "
        "WHERE database_name = 'catalog' AND schema_name = ? AND table_name = ?",
        [schema, tbl],
    ).fetchone()[0]
    if still:
        print(f"::error::{fq} is still listed by the catalog after DROP")
        return 1

    print(f"{fq} dropped ({before:,} rows); the dbt run that follows recreates it from the archive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
