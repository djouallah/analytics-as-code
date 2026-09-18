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

Three ways to drop, tried in order, stopping at the first that works:
  1. DROP TABLE through duckdb-iceberg — the normal path.
  2. The catalog's own REST dropTable (DELETE .../namespaces/{ns}/tables/{t}).
     duckdb-iceberg loads the table metadata before it issues the DELETE, so a table
     whose loadTable answers HTTP 500 cannot be dropped through it, while the REST
     dropTable needs no metadata.
  3. Delete the table's folder, Tables/{schema}/{table}, with the OneLake DFS API.
     The catalog virtualises that folder; removing it removes the table whatever state
     the catalog's own view of it is in.
This is exactly what landing.stg_csv_archive_log needed from 2026-09-17 15:34 UTC: the
catalog answered 500 to every load, commit and duckdb DROP of it (every other table fine).

The pre-drop row count is best-effort — an unreadable table is precisely the case that
needs a rebuild, so it is reported, not treated as a reason to stop.

Usage (process_data.yml, workflow_dispatch input `rebuild`):
    REBUILD_TABLE=fct_scada python scripts/rebuild_table.py

Exits non-zero on any failure: a rebuild the operator asked for must not silently turn
into an ordinary incremental load.
"""

import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from compact_iceberg import ENDPOINT, TOKEN, WAREHOUSE, connect, oneline
from iceberg_tables import TABLES

DFS_HOST = os.environ.get("ONELAKE_DFS_HOST", "onelake.dfs.fabric.microsoft.com")


def http(method, url, headers, timeout):
    """One request; returns (status, headers). Raises RuntimeError with status + body."""
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers
    except urllib.error.HTTPError as e:
        body = e.read(300).decode("utf-8", "replace").replace("\n", " ")
        raise RuntimeError(f"HTTP {e.code} {e.reason}: {body}") from None


def drop_via_duckdb(con, fq):
    con.execute(f"DROP TABLE {fq}")


def drop_via_rest(schema, tbl):
    url = f"{ENDPOINT}/v1/{WAREHOUSE}/namespaces/{schema}/tables/{tbl}"
    status, _ = http("DELETE", url, {"Authorization": f"Bearer {TOKEN}"}, 120)
    return f"HTTP {status}"


def drop_via_dfs(schema, tbl):
    # WAREHOUSE is "{workspace_id}/{lakehouse_id}"; OneLake's DFS path is the same pair.
    base = f"https://{DFS_HOST}/{WAREHOUSE}/Tables/{schema}/{tbl}"
    headers = {"Authorization": f"Bearer {TOKEN}", "x-ms-version": "2023-11-03"}
    query = {"recursive": "true"}
    calls = 0
    while True:
        calls += 1
        status, resp = http("DELETE", f"{base}?{urllib.parse.urlencode(query)}", headers, 300)
        cont = resp.get("x-ms-continuation")
        if not cont:
            return f"HTTP {status} after {calls} call(s)"
        query["continuation"] = cont


def listed(schema, tbl):
    """Fresh connection, fresh ATTACH: duckdb-iceberg caches the table list, and drops
    done outside it (REST, DFS) would not show through the old connection."""
    con = connect()
    try:
        return con.execute(
            "SELECT count(*) FROM duckdb_tables() "
            "WHERE database_name = 'catalog' AND schema_name = ? AND table_name = ?",
            [schema, tbl],
        ).fetchone()[0] > 0
    finally:
        con.close()


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
    schema, tbl = table.split(".", 1)
    fq = f"catalog.{table}"

    con = connect()
    try:
        before = f"{con.execute(f'SELECT count(*) FROM {fq}').fetchone()[0]:,} rows"
    except Exception as e:
        before = "unreadable"
        print(f"::warning::{fq} cannot be read before the drop: {oneline(e)}")
    print(f"{fq}: {before} — dropping", flush=True)

    attempts = [
        ("duckdb DROP TABLE", lambda: drop_via_duckdb(con, fq)),
        ("catalog REST dropTable", lambda: drop_via_rest(schema, tbl)),
        (f"OneLake DFS delete of Tables/{schema}/{tbl}", lambda: drop_via_dfs(schema, tbl)),
    ]
    how = None
    for label, fn in attempts:
        try:
            detail = fn()
        except Exception as e:
            print(f"  {label}: FAILED — {oneline(e)}", flush=True)
            continue
        how = label
        print(f"  {label}: OK{f' ({detail})' if detail else ''}", flush=True)
        break
    con.close()
    if how is None:
        print(f"::error::{fq} could not be dropped by any of the three paths — see above")
        return 1

    # The catalog list can lag a drop done behind its back; give it a minute.
    for _ in range(6):
        if not listed(schema, tbl):
            print(f"{fq} dropped via {how} ({before}); "
                  "the dbt run that follows recreates it from the archive")
            return 0
        time.sleep(10)
    print(f"::error::{fq} is still listed by the catalog 60s after the drop via {how}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
