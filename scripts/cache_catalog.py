"""The dashboard's .duckdb files: a copy of the mart tables.

    python cache_catalog.py export <dim|agg|today|history>     (the read venv: catalog -> parquet)
    python cache_catalog.py build  <dim|agg|today|history>     (the write venv: parquet -> .duckdb)

No rule of its own (the owner, 2026-10-05: the import "is a simple import and has zero logic
to it beside maybe splitting per size"). Every table is `SELECT *` of a table of the semantic
model (semantic_model/model.bim), under its own name, with its own types: what a chart
needs that the tables do not hold is a dbt model first. What this file decides is only which
file a table goes into, so that a browser downloads what a page needs and no file outgrows
what the host takes:
  mart_dim.duckdb              the dimensions
  mart_agg.duckdb              the per-day and per-month tables, whole, and fct_rooftop whole:
                               it is small, and the daily charts read it over any range, with
                               no half-year attached (it is in the split files too, so that a
                               5-minute range does not wait for this file)
  mart_today.duckdb            the newest RECENT_DAYS days of the tables in SPLIT
  mart_<YYYY>_h<N>.duckdb      the same tables, by half-year of `date`
Rows are written in an order that makes a file small and a range scan cheap: key order, but
fct_summary by date, time, price, DUID. Its price is the price of the unit's region, so at
one time there are five of them: in that order the column is runs and costs nothing, where
in key order it made a half-year 60% larger (93 MB against 58; 56 MB in this order,
measured on 2026 H1) and pushed it past what the host takes.

Two duckdbs, hence the two commands: the catalog is read with the build that writes it
(requirements.txt's pin), and the .duckdb files are written by the 1.5 line, the format the
dashboard's DuckDB-WASM opens. Parquet is the handoff.
"""

import json
import os
import sys
from datetime import date, datetime, timezone

import duckdb

OUT = os.path.join(os.path.dirname(__file__), "..", "mart_data")
os.makedirs(OUT, exist_ok=True)
RECENT_DAYS = 14
# The largest history file, in MB. GitHub refuses a file over 100 MB, hence the half-year
# files of the 5-minute history. OneLake takes the same files: the Fabric app downloads them
# whole too, because reading one big file in place costs a ~700 ms round trip per block.
MAX_FILE_MB = 100

# Table -> the order its rows are written in.
DIM = {"dim_duid": "DUID", "dim_calendar": "date", "dim_region": "Region", "dim_time": "time",
       "dim_month": "month"}
AGG = {"fct_summary_daily": "DUID, date", "fct_region_daily": "REGIONID, date",
       "fct_summary_hourly": "DUID, month, hour", "fct_region_hourly": "REGIONID, month, hour",
       "fct_curtailment": "DUID, date", "fct_rooftop": "REGIONID, date, time"}
SPLIT = {"fct_summary": "date, time, price, DUID", "fct_region": "REGIONID, date, time",
         "fct_interconnector": "interconnector, date, time", "fct_rooftop": "REGIONID, date, time"}
GROUPS = {"dim": DIM, "agg": AGG, "today": SPLIT, "history": SPLIT}


def connect_iceberg():
    con = duckdb.connect(":memory:")
    con.install_extension("iceberg")
    con.load_extension("iceberg")
    # The azure extension's default transport fails the OneLake TLS handshake on GitHub
    # runners; the workflows set this to curl.
    transport = os.environ.get("AZURE_TRANSPORT_OPTION_TYPE", "default")
    con.execute(f"SET GLOBAL azure_transport_option_type = '{transport}'")
    # OneLake is attached with access_delegation_mode 'none': the catalog vends no storage
    # credentials, so the azure secret is what authorises the data-file reads.
    token = os.environ["ONELAKE_TOKEN"]
    con.execute(f"CREATE SECRET onelake_storage (TYPE azure, PROVIDER access_token, ACCESS_TOKEN '{token}')")
    con.execute(
        f"ATTACH '{os.environ['WAREHOUSE_PATH']}' AS catalog "
        f"(TYPE ICEBERG, ENDPOINT '{os.environ['ONELAKE_ENDPOINT']}', TOKEN '{token}', "
        f"ACCESS_DELEGATION_MODE 'none')"
    )
    # UTC, like every reader of these tables: the timestamps in them are AEMO's AEST wall
    # clock labelled as UTC (AGENTS.md, Key Patterns). `date` and `time` are not timestamps.
    con.execute("SET TimeZone = 'UTC';")
    return con


def export_cutoff():
    """First day of the previous half-year, or None for a full copy.

    Only the current and previous half-year change from one day to the next (late daily
    files land in the previous half for a while after a boundary). Everything older is
    already deployed, so the daily run neither reads it from the catalog nor rebuilds or
    redeploys its files. ALL_PERIODS=true copies everything, e.g. after a rebuild=<table>
    backfill of old data; import_onelake.yml always sets it, as OneLake keeps two whole
    imports and has no deployed copy to add to."""
    if os.environ.get("ALL_PERIODS", "").lower() == "true":
        return None
    today = datetime.now(timezone.utc).date()
    current_half = date(today.year, 1 if today.month <= 6 else 7, 1)
    previous_half = (date(current_half.year - 1, 7, 1) if current_half.month == 1
                     else date(current_half.year, 1, 1))
    return previous_half.isoformat()


def parquet(group, table):
    return os.path.join(OUT, f"{group}_{table}.parquet").replace("\\", "/")


def export(group):
    """A table the catalog does not have fails here, on purpose: files built without it
    would be deployed over good ones. That can only happen between the DROP and the CREATE
    of a rebuild=<table> run."""
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
            name = f"mart_{year}_h{half}.duckdb"
            size_mb = write(os.path.join(OUT, name), group, f"WHERE year(date) = {year} AND month(date) {months}")
            if size_mb > MAX_FILE_MB:
                raise SystemExit(f"{name} is {size_mb:.1f} MB, over the {MAX_FILE_MB} MB the host "
                                 f"takes; the history needs a finer split than half-years.")
        # For a local run only. The deployed manifests are rebuilt from the period files
        # actually published: import_data.yml from the deploy repo, so it can never advertise
        # a .duckdb that failed to land, deploy_onelake.py from the files it uploaded.
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
