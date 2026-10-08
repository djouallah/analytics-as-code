"""The throwaway table of the iceberg-go expiry trial (scripts/iceberg_gc).

    python dummy_table.py setup   three one-row inserts, then a compaction: the three
                                  original data files are left to the older snapshots only
    python dummy_table.py check   the table still reads its three rows
    python dummy_table.py drop

Same connection as the compaction job (compact_iceberg.connect).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from compact_iceberg import connect  # noqa: E402

TABLE = "catalog.landing.zz_gc_trial"


def main(step):
    con = connect()
    if step == "setup":
        con.execute(f"DROP TABLE IF EXISTS {TABLE}")
        con.execute(f"CREATE TABLE {TABLE} (id INTEGER, v VARCHAR)")
        for i in range(3):
            con.execute(f"INSERT INTO {TABLE} VALUES ({i}, 'row {i}')")
        print(con.execute(
            f"SELECT rewritten_data_files, added_data_files FROM "
            f"iceberg_rewrite_data_files('{TABLE}', min_input_files => 2)").fetchall())
    elif step == "check":
        n = con.execute(f"SELECT count(*) FROM {TABLE}").fetchone()[0]
        print(f"{TABLE}: {n} rows")
        if n != 3:
            sys.exit(f"expected 3 rows, read {n}")
    elif step == "drop":
        con.execute(f"DROP TABLE IF EXISTS {TABLE}")
        print(f"dropped {TABLE}")


if __name__ == "__main__":
    main(sys.argv[1])
