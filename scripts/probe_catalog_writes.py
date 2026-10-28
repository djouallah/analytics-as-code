"""Which row-replacing writes the OneLake catalog accepts from the pinned duckdb.

Each case gets a fresh 3-row table in namespace `_write_probe`, runs one statement, reads the
table back through a fresh ATTACH, and drops it. It prints the snapshots the statement added
and the rows it left; exit 1 if any case was refused or left the wrong rows.
Env: WAREHOUSE_PATH, ONELAKE_ENDPOINT, ONELAKE_TOKEN (as dbt/profiles.yml).

    python scripts/probe_catalog_writes.py
"""
import os
import sys
import time

import duckdb

WAREHOUSE = os.environ["WAREHOUSE_PATH"]
ENDPOINT = os.environ["ONELAKE_ENDPOINT"]
TOKEN = os.environ["ONELAKE_TOKEN"]
NS = "_write_probe"

CASES = {
    "merge_insert_only": (
        """MERGE INTO {t} AS tg USING (VALUES (1::BIGINT, 1::BIGINT), (9, 90)) AS s(id, v)
           ON tg.id = s.id WHEN MATCHED THEN DO NOTHING
           WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.v)""",
        [(1, 10), (2, 20), (3, 30), (9, 90)],
    ),
    "merge_update_insert": (
        """MERGE INTO {t} AS tg USING (VALUES (1::BIGINT, 777::BIGINT), (9, 90)) AS s(id, v)
           ON tg.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v
           WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.v)""",
        [(1, 777), (2, 20), (3, 30), (9, 90)],
    ),
    "merge_update_insert_delete": (
        """MERGE INTO {t} AS tg USING (VALUES (1::BIGINT, 777::BIGINT), (9, 90)) AS s(id, v)
           ON tg.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v
           WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.v)
           WHEN NOT MATCHED BY SOURCE AND tg.id = 3 THEN DELETE""",
        [(1, 777), (2, 20), (9, 90)],
    ),
    "update": ("UPDATE {t} SET v = 999 WHERE id = 1", [(1, 999), (2, 20), (3, 30)]),
    "delete": ("DELETE FROM {t} WHERE id = 1", [(2, 20), (3, 30)]),
    "delete_insert_one_txn": (
        "BEGIN; DELETE FROM {t} WHERE id = 1; INSERT INTO {t} VALUES (1, 555); COMMIT",
        [(1, 555), (2, 20), (3, 30)],
    ),
}


def attach(con):
    con.execute(f"""ATTACH '{WAREHOUSE}' AS cat (TYPE ICEBERG, ENDPOINT '{ENDPOINT}',
        TOKEN '{TOKEN}', ACCESS_DELEGATION_MODE 'none', STAGE_CREATE_TABLES 0,
        SKIP_CREATE_TABLE_METADATA_UPDATES 1, DEFAULT_SCHEMA 'dbo')""")


def one(con, sql):
    return con.execute(sql).fetchall()[0][0]


con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
con.execute("INSTALL iceberg; LOAD iceberg; INSTALL azure; LOAD azure")
transport = os.environ.get("AZURE_TRANSPORT_OPTION_TYPE")
if transport:
    con.execute(f"SET GLOBAL azure_transport_option_type = '{transport}'")
con.execute(f"CREATE SECRET onelake_storage (TYPE azure, PROVIDER access_token, ACCESS_TOKEN '{TOKEN}')")
attach(con)
ext = one(con, "SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'iceberg'")
print(f"duckdb {duckdb.__version__}, iceberg {ext}, warehouse {WAREHOUSE}")
con.execute(f"CREATE SCHEMA IF NOT EXISTS cat.{NS}")

run = f"r{int(time.time())}"
failed = 0
for name, (stmt, expected) in CASES.items():
    t = f"cat.{NS}.{run}_{name}"
    con.execute(f"CREATE TABLE {t} (id BIGINT, v BIGINT)")
    con.execute(f"INSERT INTO {t} VALUES (1, 10), (2, 20), (3, 30)")
    before = one(con, f"SELECT count(*) FROM iceberg_snapshots('{t}')")
    try:
        con.execute(stmt.format(t=t))
        con.execute("DETACH cat")
        attach(con)
        after = one(con, f"SELECT count(*) FROM iceberg_snapshots('{t}')")
        rows = con.execute(f"SELECT id, v FROM {t} ORDER BY id").fetchall()
        ok = rows == expected
        failed += not ok
        print(f"{'OK  ' if ok else 'BAD '} {name:28} snapshots +{after - before}  rows {rows}")
    except Exception as e:
        failed += 1
        try:
            con.execute("ROLLBACK")
        except Exception:
            pass
        print(f"FAIL {name:28} {type(e).__name__}: {' '.join(str(e).split())[:400]}")
    try:
        con.execute(f"DROP TABLE {t}")
    except Exception as e:
        print(f"     could not drop {t}: {' '.join(str(e).split())[:200]}")

sys.exit(1 if failed else 0)
