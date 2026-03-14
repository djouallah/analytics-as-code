"""Import Iceberg catalog tables into a local .duckdb file for the dashboard.

Usage:
    python cache_catalog.py export_scada
    python cache_catalog.py export_price
    python cache_catalog.py export_scada_today
    python cache_catalog.py export_price_today
    python cache_catalog.py export_dim_duid
    python cache_catalog.py export_dim_calendar
    python cache_catalog.py build_daily
    python cache_catalog.py build_today
"""

import json
import os
import sys
from datetime import datetime, timezone

import duckdb

ENDPOINT = os.environ["ICEBERG_REST_ENDPOINT"]
TOKEN = os.environ["ICEBERG_TOKEN"]
WAREHOUSE = os.environ["ICEBERG_WAREHOUSE"]

DASHBOARD_DIR = os.path.join(os.path.dirname(__file__), "..", "dashboard")
DB_DIM_PATH = os.path.join(DASHBOARD_DIR, "energy_dim.duckdb")
DB_TODAY_PATH = os.path.join(DASHBOARD_DIR, "energy_today.duckdb")
os.makedirs(DASHBOARD_DIR, exist_ok=True)


def connect_iceberg():
    con = duckdb.connect(":memory:")
    con.install_extension("iceberg")
    con.load_extension("iceberg")
    con.execute(f"CREATE SECRET (TYPE ICEBERG, TOKEN '{TOKEN}');")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog (TYPE ICEBERG, ENDPOINT '{ENDPOINT}');")
    con.execute("SET TimeZone = 'Australia/Brisbane';")
    return con


def export_scada():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(INITIALMW) AS REAL) AS mw
            FROM catalog.landing.fct_scada
            WHERE INTERVENTION = 0 AND INITIALMW <> 0
            GROUP BY DUID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_scada.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_price():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT REGIONID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(RRP) AS REAL) AS price
            FROM catalog.landing.fct_price
            WHERE INTERVENTION = 0
            GROUP BY REGIONID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_price.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_scada_today():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(INITIALMW) AS REAL) AS mw
            FROM catalog.landing.fct_scada_today
            WHERE CAST(SETTLEMENTDATE AS DATE) >= CURRENT_DATE - INTERVAL 7 DAY
                AND INITIALMW <> 0
            GROUP BY DUID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_scada_today.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_price_today():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT REGIONID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(RRP) AS REAL) AS price
            FROM catalog.landing.fct_price_today
            WHERE CAST(SETTLEMENTDATE AS DATE) >= CURRENT_DATE - INTERVAL 7 DAY
                AND INTERVENTION = 0
            GROUP BY REGIONID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_price_today.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_dim_duid():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, Region, FuelSourceDescriptor, Participant, State, latitude, longitude
            FROM catalog.mart.dim_duid
        ) TO '{DASHBOARD_DIR}/dim_duid.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_dim_calendar():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT date, year, month
            FROM catalog.mart.dim_calendar
        ) TO '{DASHBOARD_DIR}/dim_calendar.parquet' (FORMAT PARQUET);
    """)
    con.close()


def build_daily():
    # Clean old files
    for f in os.listdir(DASHBOARD_DIR):
        if f.startswith("energy_data_") or f in ("energy_daily.duckdb", "energy_dim.duckdb"):
            os.remove(os.path.join(DASHBOARD_DIR, f))

    con = duckdb.connect(":memory:")

    # Get distinct year-half periods from scada data
    periods = [
        (r[0], r[1])
        for r in con.execute(
            f"""SELECT DISTINCT EXTRACT(YEAR FROM date)::INTEGER AS year,
                       CASE WHEN EXTRACT(MONTH FROM date) <= 6 THEN 1 ELSE 2 END AS half
                FROM '{DASHBOARD_DIR}/fct_scada.parquet'
                ORDER BY year, half"""
        ).fetchall()
    ]

    # Build per-half-year files with scada + price
    for year, half in periods:
        tag = f"{year}_h{half}"
        month_lo = 1 if half == 1 else 7
        month_hi = 6 if half == 1 else 12
        path = os.path.join(DASHBOARD_DIR, f"energy_data_{tag}.duckdb")
        ycon = duckdb.connect(path)
        ycon.execute(f"""
            CREATE TABLE scada AS
            SELECT * FROM '{DASHBOARD_DIR}/fct_scada.parquet'
            WHERE EXTRACT(YEAR FROM date) = {year}
              AND EXTRACT(MONTH FROM date) BETWEEN {month_lo} AND {month_hi}
            ORDER BY DUID, date, time
        """)
        ycon.execute(f"""
            CREATE TABLE price AS
            SELECT * FROM '{DASHBOARD_DIR}/fct_price.parquet'
            WHERE EXTRACT(YEAR FROM date) = {year}
              AND EXTRACT(MONTH FROM date) BETWEEN {month_lo} AND {month_hi}
            ORDER BY REGIONID, date, time
        """)
        ycon.close()
        size_mb = os.path.getsize(path) / 1024 / 1024
        print(f"Built {path} ({size_mb:.1f} MB)")

    # Build dim file
    dcon = duckdb.connect(DB_DIM_PATH)
    dcon.execute(f"CREATE TABLE dim_duid AS SELECT * FROM '{DASHBOARD_DIR}/dim_duid.parquet'")
    dcon.execute(f"CREATE TABLE dim_calendar AS SELECT * FROM '{DASHBOARD_DIR}/dim_calendar.parquet'")
    dcon.close()
    print(f"Built {DB_DIM_PATH}")

    # Write manifest
    tags = [f"{y}_h{h}" for y, h in periods]
    with open(os.path.join(DASHBOARD_DIR, "daily_manifest.json"), "w") as f:
        json.dump({"periods": tags}, f)
    print(f"Manifest: {tags}")

    # Clean up parquet intermediates
    for f in ["fct_scada.parquet", "fct_price.parquet", "dim_duid.parquet", "dim_calendar.parquet"]:
        path = os.path.join(DASHBOARD_DIR, f)
        if os.path.exists(path):
            os.remove(path)

    con.close()


def build_today():
    if os.path.exists(DB_TODAY_PATH):
        os.remove(DB_TODAY_PATH)

    con = duckdb.connect(DB_TODAY_PATH)
    con.execute(f"CREATE TABLE scada_today AS SELECT * FROM '{DASHBOARD_DIR}/fct_scada_today.parquet' ORDER BY DUID, date, time")
    con.execute(f"CREATE TABLE price_today AS SELECT * FROM '{DASHBOARD_DIR}/fct_price_today.parquet' ORDER BY REGIONID, date, time")
    con.close()

    for f in ["fct_scada_today.parquet", "fct_price_today.parquet"]:
        path = os.path.join(DASHBOARD_DIR, f)
        if os.path.exists(path):
            os.remove(path)

    # metadata
    with open(os.path.join(DASHBOARD_DIR, "metadata.json"), "w") as f:
        json.dump({"exported_at": datetime.now(timezone.utc).isoformat()}, f)

    print(f"Built {DB_TODAY_PATH}")


COMMANDS = {
    "export_scada": export_scada,
    "export_price": export_price,
    "export_scada_today": export_scada_today,
    "export_price_today": export_price_today,
    "export_dim_duid": export_dim_duid,
    "export_dim_calendar": export_dim_calendar,
    "build_daily": build_daily,
    "build_today": build_today,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd not in COMMANDS:
        print(f"Usage: python {sys.argv[0]} <{'|'.join(COMMANDS)}>")
        sys.exit(1)
    COMMANDS[cmd]()
