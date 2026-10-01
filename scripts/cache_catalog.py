"""Import Iceberg catalog tables into a local .duckdb file for the dashboard.

Usage:
    python cache_catalog.py export_scada
    python cache_catalog.py export_price
    python cache_catalog.py export_scada_today
    python cache_catalog.py export_price_today
    python cache_catalog.py export_interconnector_today
    python cache_catalog.py export_dim_duid
    python cache_catalog.py export_dim_calendar
    python cache_catalog.py build_dim
    python cache_catalog.py build_daily
    python cache_catalog.py build_today
"""

import json
import os
import sys
import tempfile
import urllib.request
from datetime import date, datetime, timezone

import duckdb

ENDPOINT = os.environ["ONELAKE_ENDPOINT"]
TOKEN = os.environ["ONELAKE_TOKEN"]
WAREHOUSE = os.environ["WAREHOUSE_PATH"]      # "{workspace_id}/{lakehouse_id}"
# The azure extension's default transport fails the OneLake TLS handshake on GitHub
# runners; the workflows set this to curl.
AZURE_TRANSPORT = os.environ.get("AZURE_TRANSPORT_OPTION_TYPE", "default")

DASHBOARD_DIR = os.path.join(os.path.dirname(__file__), "..", "dashboard")
DB_DIM_PATH = os.path.join(DASHBOARD_DIR, "energy_dim.duckdb")
DB_TODAY_PATH = os.path.join(DASHBOARD_DIR, "energy_today.duckdb")
os.makedirs(DASHBOARD_DIR, exist_ok=True)


def connect_iceberg():
    con = duckdb.connect(":memory:")
    con.install_extension("iceberg")
    con.load_extension("iceberg")
    con.execute(f"SET GLOBAL azure_transport_option_type = '{AZURE_TRANSPORT}'")
    # OneLake is attached with access_delegation_mode 'none' — the catalog vends no
    # storage credentials, so the azure secret is what authorises the data-file reads.
    con.execute(
        f"CREATE SECRET onelake_storage "
        f"(TYPE azure, PROVIDER access_token, ACCESS_TOKEN '{TOKEN}')"
    )
    con.execute(
        f"ATTACH '{WAREHOUSE}' AS catalog "
        f"(TYPE ICEBERG, ENDPOINT '{ENDPOINT}', TOKEN '{TOKEN}', "
        f"ACCESS_DELEGATION_MODE 'none')"
    )
    # UTC, deliberately. The fact tables' SETTLEMENTDATE is TIMESTAMPTZ, but the value in
    # it is AEMO's AEST wall clock labelled as UTC: the models CAST the CSV string to
    # TIMESTAMPTZ in a dbt session that runs in UTC on the runners. Reading it back in UTC
    # returns that wall clock unchanged, which is what the dashboard's `date`/`time` mean.
    # This was 'Australia/Brisbane' until 2026-09-25, which shifted every date and time
    # on the dashboard by +10h (14:05 on the 25th displayed as 00:05 on the 26th); it was
    # harmless while SETTLEMENTDATE was a naive TIMESTAMP, before the 2026-08-25 refactor.
    con.execute("SET TimeZone = 'UTC';")
    return con


def export_cutoff():
    """First day of the previous half-year, or None for a full export (#2).

    Only the current and previous half-year change from one day to the next (late daily
    files land in the previous half for a while after a boundary). Everything older is
    already deployed -- its energy_data_<half>.duckdb files and its rows in
    energy_daily_agg.duckdb -- so the daily run neither re-exports it from Iceberg nor
    rebuilds or redeploys it. ALL_PERIODS=true exports and rebuilds everything, e.g. after
    a rebuild=<fact> backfill of old data."""
    if os.environ.get("ALL_PERIODS", "").lower() == "true":
        return None
    today = datetime.now(timezone.utc).date()
    current_half = date(today.year, 1 if today.month <= 6 else 7, 1)
    previous_half = (date(current_half.year - 1, 7, 1) if current_half.month == 1
                     else date(current_half.year, 1, 1))
    return previous_half.isoformat()


def cutoff_filter():
    """WHERE fragment for the facts' DATE column (cast from the AEMO string, so the right
    calendar day, and prunable from file statistics)."""
    cutoff = export_cutoff()
    return f"AND DATE >= DATE '{cutoff}'" if cutoff else ""


def export_scada():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(INITIALMW) AS REAL) AS mw
            FROM catalog.landing.fct_scada
            WHERE INTERVENTION = 0 AND INITIALMW <> 0 {cutoff_filter()}
            GROUP BY DUID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_scada.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_price():
    """Price, operational demand and net interchange (positive = the region exports), all
    from the DREGION rows of the next-day files."""
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT REGIONID, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(RRP) AS REAL) AS price,
                CAST(ANY_VALUE(TOTALDEMAND) AS REAL) AS demand,
                CAST(ANY_VALUE(NETINTERCHANGE) AS REAL) AS net_interchange
            FROM catalog.landing.fct_price
            WHERE INTERVENTION = 0 {cutoff_filter()}
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
            WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY
                AND INITIALMW <> 0
            GROUP BY DUID, CAST(SETTLEMENTDATE AS DATE), strftime(SETTLEMENTDATE, '%H%M')
        ) TO '{DASHBOARD_DIR}/fct_scada_today.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_price_today():
    """Price from the PRICE rows, demand and net interchange from the REGIONSUM rows of the
    same DispatchIS files (fct_regionsum_today), last 14 days. fct_regionsum_today is new
    (2026-10-01) and fills from the archive newest first: intervals it doesn't have yet keep
    a NULL demand, and until the pipeline has created it the columns are all NULL."""
    con = connect_iceberg()
    price = """
        SELECT REGIONID, SETTLEMENTDATE, CAST(ANY_VALUE(RRP) AS REAL) AS price
        FROM catalog.landing.fct_price_today
        WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY AND INTERVENTION = 0
        GROUP BY ALL
    """
    regionsum = """
        SELECT REGIONID, SETTLEMENTDATE,
            CAST(ANY_VALUE(TOTALDEMAND) AS REAL) AS demand,
            CAST(ANY_VALUE(NETINTERCHANGE) AS REAL) AS net_interchange
        FROM catalog.landing.fct_regionsum_today
        WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY AND INTERVENTION = 0
        GROUP BY ALL
    """
    query = f"""
        WITH p AS ({price}), r AS ({{regionsum}})
        SELECT p.REGIONID, CAST(p.SETTLEMENTDATE AS DATE) AS date,
            CAST(strftime(p.SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
            p.price, r.demand, r.net_interchange
        FROM p LEFT JOIN r ON r.REGIONID = p.REGIONID AND r.SETTLEMENTDATE = p.SETTLEMENTDATE
    """
    target = f"'{DASHBOARD_DIR}/fct_price_today.parquet' (FORMAT PARQUET)"
    try:
        con.execute(f"COPY ({query.format(regionsum=regionsum)}) TO {target}")
    except duckdb.CatalogException as e:
        print(f"  fct_regionsum_today not there yet ({e}); exporting price with NULL demand")
        empty = ("SELECT NULL::VARCHAR AS REGIONID, NULL::TIMESTAMPTZ AS SETTLEMENTDATE, "
                 "NULL::REAL AS demand, NULL::REAL AS net_interchange LIMIT 0")
        con.execute(f"COPY ({query.format(regionsum=empty)}) TO {target}")
    con.close()


def export_interconnector_today():
    """Interconnector flows (MW, positive from the first region in the ID to the second) and
    limits, last 14 days. The table is new (2026-10-01): until the pipeline has created it, an
    empty file with the same columns keeps build_today and the dashboard working."""
    con = connect_iceberg()
    query = """
        SELECT INTERCONNECTORID AS interconnector, CAST(SETTLEMENTDATE AS DATE) AS date,
            CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
            CAST(ANY_VALUE(MWFLOW) AS REAL) AS mw,
            CAST(ANY_VALUE(EXPORTLIMIT) AS REAL) AS export_limit,
            CAST(ANY_VALUE(IMPORTLIMIT) AS REAL) AS import_limit
        FROM catalog.landing.fct_interconnector_today
        WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY AND INTERVENTION = 0
        GROUP BY ALL
    """
    try:
        con.execute(f"COPY ({query}) TO '{DASHBOARD_DIR}/fct_interconnector_today.parquet' (FORMAT PARQUET)")
    except duckdb.CatalogException as e:
        print(f"  fct_interconnector_today not there yet ({e}); exporting an empty table")
        con.execute(f"""COPY (SELECT ''::VARCHAR AS interconnector, NULL::DATE AS date, 0::SMALLINT AS time,
            0::REAL AS mw, 0::REAL AS export_limit, 0::REAL AS import_limit LIMIT 0)
            TO '{DASHBOARD_DIR}/fct_interconnector_today.parquet' (FORMAT PARQUET)""")
    con.close()


def export_dim_duid():
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, Region, FuelSourceDescriptor, Participant, State, latitude, longitude,
                StationName, TechnologyType, RegCapMW, MaxCapMW, StorageMWh
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
        if f.startswith("energy_data_") or f == "energy_daily.duckdb":
            os.remove(os.path.join(DASHBOARD_DIR, f))

    con = duckdb.connect(":memory:")

    # Year-half periods present in the scada export -- by default only the latest two,
    # because that is all export_scada exported (see export_cutoff).
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

    # Write manifest (local/dev parity only). The DEPLOYED manifest is rebuilt in
    # import_data.yml from the period files actually committed to the deploy repo,
    # so it can never advertise a .duckdb that failed to land in the gh-pages push.
    tags = [f"{y}_h{h}" for y, h in periods]
    with open(os.path.join(DASHBOARD_DIR, "daily_manifest.json"), "w") as f:
        json.dump({"periods": tags}, f)
    print(f"Manifest: {tags}")

    con.close()


DEPLOYED_DATA_URL = os.environ.get("DEPLOYED_DATA_URL", "https://nemtracker.github.io/data")


def build_daily_agg():
    agg_path = os.path.join(DASHBOARD_DIR, "energy_daily_agg.duckdb")
    if os.path.exists(agg_path):
        os.remove(agg_path)

    scada = f"'{DASHBOARD_DIR}/fct_scada.parquet'"
    price = f"'{DASHBOARD_DIR}/fct_price.parquet'"
    # Each table: (date column, its query over the parquet exports).
    # - scada_daily / price_daily: one row per unit (region) and day, for ranges over 30 days.
    # - scada_hourly / price_hourly / month_days: hour of day x month, so the daily-profile and
    #   price-by-hour charts work on long ranges. scada_hourly keeps the positive output only
    #   (the profile leaves charging out); a range's average MW at hour h is SUM(mwh) over its
    #   months / SUM(days) over the same months. hour = time // 100, like the 5-minute charts.
    tables = {
        "scada_daily": ("date", f"""
            SELECT DUID, date, CAST(SUM(mw) / 12.0 AS REAL) AS mwh
            FROM {scada} GROUP BY ALL ORDER BY DUID, date"""),
        "price_daily": ("date", f"""
            SELECT REGIONID, date, CAST(AVG(price) AS REAL) AS price,
                CAST(AVG(demand) AS REAL) AS demand,
                CAST(AVG(net_interchange) AS REAL) AS net_interchange
            FROM {price} GROUP BY ALL ORDER BY REGIONID, date"""),
        "scada_hourly": ("month", f"""
            SELECT DUID, CAST(date_trunc('month', date) AS DATE) AS month,
                CAST(time // 100 AS TINYINT) AS hour, CAST(SUM(mw) / 12.0 AS REAL) AS mwh
            FROM {scada} WHERE mw > 0 GROUP BY ALL ORDER BY DUID, month, hour"""),
        "price_hourly": ("month", f"""
            SELECT REGIONID, CAST(date_trunc('month', date) AS DATE) AS month,
                CAST(time // 100 AS TINYINT) AS hour, CAST(AVG(price) AS REAL) AS price,
                CAST(COUNT(*) AS INTEGER) AS n
            FROM {price} GROUP BY ALL ORDER BY REGIONID, month, hour"""),
        "month_days": ("month", f"""
            SELECT CAST(date_trunc('month', date) AS DATE) AS month,
                CAST(COUNT(DISTINCT date) AS SMALLINT) AS days
            FROM {scada} GROUP BY ALL ORDER BY month"""),
    }

    # With a cutoff the parquet exports only start there, so the rows before it come from
    # the currently deployed aggregate. Any doubt about that file fails the step: a
    # silently truncated history would be deployed over the good one. The cutoff is the
    # first day of a half-year, so the monthly tables split cleanly on it too.
    cutoff = export_cutoff()
    keep_old = {t: "" for t in tables}
    tmp = None
    if cutoff:
        tmp = tempfile.NamedTemporaryFile(suffix=".duckdb", delete=False).name
        urllib.request.urlretrieve(f"{DEPLOYED_DATA_URL}/energy_daily_agg.duckdb", tmp)
        check = duckdb.connect(tmp, read_only=True)
        for table, (col, query) in tables.items():
            want = [d[0] for d in check.execute(f"DESCRIBE {query}").fetchall()]
            try:
                have = [d[0] for d in check.execute(f"DESCRIBE {table}").fetchall()]
                first, last = check.execute(f"SELECT min({col}), max({col}) FROM {table}").fetchone()
            except duckdb.CatalogException:
                have, first, last = [], None, None
            if have != want:
                raise SystemExit(f"Deployed {table} has columns {have}, not {want}; refusing to "
                                 f"splice. Dispatch with all_periods=true.")
            if first is None or str(first) >= cutoff or str(last) < cutoff:
                raise SystemExit(f"Deployed {table} covers {first}..{last}, which doesn't reach "
                                 f"{cutoff}; refusing to splice. Dispatch with all_periods=true.")
        check.close()
        keep_old = {t: f"SELECT * FROM old.{t} WHERE {col} < DATE '{cutoff}' UNION ALL "
                    for t, (col, _) in tables.items()}

    con = duckdb.connect(agg_path)
    if cutoff:
        con.execute(f"ATTACH '{tmp}' AS old (READ_ONLY)")
    for table, (_, query) in tables.items():
        con.execute(f"CREATE TABLE {table} AS {keep_old[table]} {query}")
    rows = {t: con.execute(f"SELECT count(*), min({col}), max({col}) FROM {t}").fetchone()
            for t, (col, _) in tables.items()}
    con.close()
    if tmp:
        os.remove(tmp)
    print(f"Daily aggregate (kept deployed rows before {cutoff or 'nothing'}): {rows}")

    # Clean up parquet intermediates (shared with build_daily)
    for f in ["fct_scada.parquet", "fct_price.parquet"]:
        path = os.path.join(DASHBOARD_DIR, f)
        if os.path.exists(path):
            os.remove(path)

    size_mb = os.path.getsize(agg_path) / 1024 / 1024
    print(f"Built {agg_path} ({size_mb:.1f} MB)")


def build_dim():
    if os.path.exists(DB_DIM_PATH):
        os.remove(DB_DIM_PATH)

    dcon = duckdb.connect(DB_DIM_PATH)
    dcon.execute(f"CREATE TABLE dim_duid AS SELECT * FROM '{DASHBOARD_DIR}/dim_duid.parquet'")
    dcon.execute(f"CREATE TABLE dim_calendar AS SELECT * FROM '{DASHBOARD_DIR}/dim_calendar.parquet'")
    dcon.close()

    for f in ["dim_duid.parquet", "dim_calendar.parquet"]:
        path = os.path.join(DASHBOARD_DIR, f)
        if os.path.exists(path):
            os.remove(path)

    print(f"Built {DB_DIM_PATH}")


def build_today():
    if os.path.exists(DB_TODAY_PATH):
        os.remove(DB_TODAY_PATH)

    con = duckdb.connect(DB_TODAY_PATH)
    con.execute(f"CREATE TABLE scada_today AS SELECT * FROM '{DASHBOARD_DIR}/fct_scada_today.parquet' ORDER BY DUID, date, time")
    con.execute(f"CREATE TABLE price_today AS SELECT * FROM '{DASHBOARD_DIR}/fct_price_today.parquet' ORDER BY REGIONID, date, time")
    con.execute(f"CREATE TABLE interconnector_today AS SELECT * FROM '{DASHBOARD_DIR}/fct_interconnector_today.parquet' ORDER BY interconnector, date, time")
    con.close()

    for f in ["fct_scada_today.parquet", "fct_price_today.parquet", "fct_interconnector_today.parquet"]:
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
    "export_interconnector_today": export_interconnector_today,
    "export_dim_duid": export_dim_duid,
    "export_dim_calendar": export_dim_calendar,
    "build_dim": build_dim,
    "build_daily": build_daily,
    "build_daily_agg": build_daily_agg,
    "build_today": build_today,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd not in COMMANDS:
        print(f"Usage: python {sys.argv[0]} <{'|'.join(COMMANDS)}>")
        sys.exit(1)
    COMMANDS[cmd]()
