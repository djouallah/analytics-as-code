"""The dashboard's .duckdb files as a copy of the mart tables.

    python copy_catalog.py export <dim|agg|today|history>     (the read venv: catalog -> parquet)
    python copy_catalog.py build  <dim|agg|today|history>     (the write venv: parquet -> .duckdb)

No rule of its own (the owner, 2026-10-05: the import "is a simple import and has zero logic
to it beside maybe splitting per size"). Every table is `SELECT *` of a table of the semantic
model, under its own name, with its own types. What this file decides is only which file a
table goes into, so that a browser downloads what a page needs and no file outgrows what the
host takes:
  mart_dim.duckdb              the dimensions
  mart_agg.duckdb              the per-day and per-month tables, whole
  mart_today.duckdb            the newest RECENT_DAYS days of the tables in SPLIT
  mart_<YYYY>_h<N>.duckdb      the same tables, by half-year of `date`
Rows are written in key order: it is what makes a file small and a range scan cheap.

Not deployed yet: copy_mart.yml builds these as a workflow artifact, for the port of the
dashboard to these tables. cache_catalog.py still builds the files the dashboard reads; the
catalog connection and the export cutoff are its own, shared until it goes.
"""

import json
import os
import sys

import duckdb

from cache_catalog import MAX_FILE_MB, connect_iceberg, export_cutoff

OUT = os.path.join(os.path.dirname(__file__), "..", "mart_data")
os.makedirs(OUT, exist_ok=True)
RECENT_DAYS = 14

# Table -> the order its rows are written in.
DIM = {"dim_duid": "DUID", "dim_calendar": "date", "dim_region": "Region", "dim_time": "time",
       "dim_month": "month"}
AGG = {"fct_summary_daily": "DUID, date", "fct_region_daily": "REGIONID, date",
       "fct_summary_hourly": "DUID, month, hour", "fct_region_hourly": "REGIONID, month, hour",
       "fct_curtailment": "DUID, date"}
SPLIT = {"fct_summary": "DUID, date, time", "fct_region": "REGIONID, date, time",
         "fct_interconnector": "interconnector, date, time", "fct_rooftop": "REGIONID, date, time"}
GROUPS = {"dim": DIM, "agg": AGG, "today": SPLIT, "history": SPLIT}


def parquet(group, table):
    return os.path.join(OUT, f"{group}_{table}.parquet").replace("\\", "/")


def export(group):
    where = ""
    if group == "today":
        where = f"WHERE date >= CURRENT_DATE - INTERVAL {RECENT_DAYS} DAY"
    elif group == "history" and export_cutoff():
        where = f"WHERE date >= DATE '{export_cutoff()}'"
    con = connect_iceberg()
    for table in GROUPS[group]:
        con.execute(f"COPY (SELECT * FROM catalog.mart.{table} {where}) TO '{parquet(group, table)}' (FORMAT PARQUET)")
        rows = con.execute(f"SELECT count(*) FROM '{parquet(group, table)}'").fetchone()[0]
        print(f"exported {table}: {rows:,} rows")
    con.close()


def write(path, group, where=""):
    """One .duckdb holding the group's tables (the rows of `where`); its size in MB."""
    if os.path.exists(path):
        os.remove(path)
    con = duckdb.connect(path)
    for table, order in GROUPS[group].items():
        con.execute(f"CREATE TABLE {table} AS SELECT * FROM '{parquet(group, table)}' {where} ORDER BY {order}")
    con.close()
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"built {os.path.basename(path)} ({size_mb:.1f} MB)")
    return size_mb


def build(group):
    if group != "history":
        write(os.path.join(OUT, f"mart_{group}.duckdb"), group)
    else:
        con = duckdb.connect()
        periods = con.execute(f"""
            SELECT DISTINCT year(date), CASE WHEN month(date) <= 6 THEN 1 ELSE 2 END
            FROM '{parquet(group, "fct_summary")}' ORDER BY ALL""").fetchall()
        con.close()
        for year, half in periods:
            months = "BETWEEN 1 AND 6" if half == 1 else "BETWEEN 7 AND 12"
            size_mb = write(os.path.join(OUT, f"mart_{year}_h{half}.duckdb"), group,
                            f"WHERE year(date) = {year} AND month(date) {months}")
            if size_mb > MAX_FILE_MB:
                print(f"::warning::mart_{year}_h{half}.duckdb is {size_mb:.1f} MB, over the "
                      f"{MAX_FILE_MB} MB the host takes: the history needs a finer split")
        with open(os.path.join(OUT, "mart_manifest.json"), "w") as f:
            json.dump({"periods": [f"{y}_h{h}" for y, h in periods]}, f)
    for table in GROUPS[group]:
        os.remove(parquet(group, table))


if __name__ == "__main__":
    commands = {"export": export, "build": build}
    if len(sys.argv) != 3 or sys.argv[1] not in commands or sys.argv[2] not in GROUPS:
        print(f"Usage: python {sys.argv[0]} <export|build> <{'|'.join(GROUPS)}>")
        sys.exit(1)
    commands[sys.argv[1]](sys.argv[2])
