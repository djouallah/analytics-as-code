"""Probe what the Iceberg REST catalog actually supports via DuckDB.

We learned the hard way that some catalogs accept a statement without error but
DON'T apply it (row-level DELETE was a silent no-op, which is how dim_duid ended
up with stacked duplicate copies). So this doesn't just check "did it raise" --
it checks "did the data actually change", and reports OK / NO-OP / ERROR.

Usage:
    python scripts/catalog_capabilities.py
"""

import os
import sys

import duckdb

ENDPOINT = os.environ["ICEBERG_REST_ENDPOINT"]
TOKEN = os.environ["ICEBERG_TOKEN"]
WAREHOUSE = os.environ["ICEBERG_WAREHOUSE"]

TABLE = "catalog.mart._capability_probe"


def connect():
    con = duckdb.connect(":memory:")
    con.install_extension("iceberg")
    con.load_extension("iceberg")
    con.execute(f"CREATE SECRET (TYPE ICEBERG, TOKEN '{TOKEN}');")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog (TYPE ICEBERG, ENDPOINT '{ENDPOINT}');")
    return con


def main():
    con = connect()
    print(f"duckdb {duckdb.__version__}")

    def count():
        return con.execute(f"SELECT count(*) FROM {TABLE}").fetchone()[0]

    results = []  # (operation, status)

    def run(op, fn):
        try:
            detail = fn()
            results.append((op, detail or "OK"))
        except Exception as e:
            results.append((op, "ERROR: " + str(e).splitlines()[0][:140]))

    # Start clean
    try:
        con.execute(f"DROP TABLE IF EXISTS {TABLE}")
    except Exception:
        pass

    def create():
        con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM (VALUES (1,'a'),(2,'b'),(3,'c')) t(id,val)")
        return "OK" if count() == 3 else f"NO-OP (rows={count()})"

    def insert():
        before = count()
        con.execute(f"INSERT INTO {TABLE} VALUES (4,'d')")
        after = count()
        return "OK" if after == before + 1 else f"NO-OP ({before}->{after})"

    def delete():
        before = count()
        con.execute(f"DELETE FROM {TABLE} WHERE id = 4")
        after = count()
        if after == before:
            return f"NO-OP (row not removed, still {after})"
        return "OK"

    def update():
        con.execute(f"UPDATE {TABLE} SET val = 'X' WHERE id = 1")
        v = con.execute(f"SELECT val FROM {TABLE} WHERE id = 1").fetchone()[0]
        return "OK" if v == "X" else f"NO-OP (val still '{v}')"

    def merge():
        con.execute("CREATE OR REPLACE TEMP TABLE _src AS SELECT * FROM (VALUES (1,'merged'),(9,'new')) t(id,val)")
        con.execute(
            f"""MERGE INTO {TABLE} t USING _src s ON t.id = s.id
                WHEN MATCHED THEN UPDATE SET val = s.val
                WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val)"""
        )
        matched = con.execute(f"SELECT val FROM {TABLE} WHERE id = 1").fetchone()[0]
        inserted = con.execute(f"SELECT count(*) FROM {TABLE} WHERE id = 9").fetchone()[0]
        if matched == "merged" and inserted == 1:
            return "OK"
        return f"PARTIAL/NO-OP (matched_val='{matched}', inserted={inserted})"

    def create_or_replace():
        con.execute(f"CREATE OR REPLACE TABLE {TABLE} AS SELECT * FROM (VALUES (1,'a')) t(id,val)")
        return "OK" if count() == 1 else f"NO-OP (rows={count()})"

    def drop():
        con.execute(f"DROP TABLE IF EXISTS {TABLE}")
        exists = con.execute(
            "SELECT count(*) FROM information_schema.tables "
            "WHERE table_catalog='catalog' AND table_name='_capability_probe'"
        ).fetchone()[0]
        return "OK" if exists == 0 else "NO-OP (table still present)"

    run("CREATE TABLE AS", create)
    run("INSERT", insert)
    run("DELETE", delete)
    run("UPDATE", update)
    run("MERGE", merge)
    run("CREATE OR REPLACE", create_or_replace)
    run("DROP TABLE", drop)

    # Cleanup safety net
    try:
        con.execute(f"DROP TABLE IF EXISTS {TABLE}")
    except Exception:
        pass

    print("\n=== Iceberg catalog capability matrix ===")
    for op, status in results:
        print(f"  {op:<18} {status}")
    print()
    # Informational probe -- always exit 0 so the matrix is never masked by a
    # failing op (a NO-OP/ERROR here is a finding, not a CI failure).


if __name__ == "__main__":
    main()
