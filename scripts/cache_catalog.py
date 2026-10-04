"""Import Iceberg catalog tables into a local .duckdb file for the dashboard.

Usage:
    python cache_catalog.py export_scada
    python cache_catalog.py export_price
    python cache_catalog.py export_scada_today
    python cache_catalog.py export_price_today
    python cache_catalog.py export_interconnector_today
    python cache_catalog.py export_interconnector
    python cache_catalog.py export_curtailment
    python cache_catalog.py export_dim_duid
    python cache_catalog.py export_dim_calendar
    python cache_catalog.py build_dim
    python cache_catalog.py build_daily
    python cache_catalog.py build_daily_agg
    python cache_catalog.py build_today

MAX_FILE_MB (env, default 100) is the largest file the host takes: 100 for GitHub Pages,
"unlimited" for OneLake.
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

# The largest file the host takes, in MB. GitHub refuses a file over 100 MB, hence the
# half-year files of the 5-minute history (import_data.yml). "unlimited" is OneLake
# (import_onelake.yml): the history is one file, and every run exports all of it.
MAX_FILE_MB = os.environ.get("MAX_FILE_MB", "100")
MAX_FILE_MB = None if MAX_FILE_MB == "unlimited" else int(MAX_FILE_MB)


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
    a rebuild=<fact> backfill of old data. So does MAX_FILE_MB=unlimited: one history file
    has no older files to leave alone."""
    if MAX_FILE_MB is None or os.environ.get("ALL_PERIODS", "").lower() == "true":
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


ROOFTOP = "catalog.landing.fct_rooftop_pv"
ROOFTOP_REGIONS = "('NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1')"

# A table the catalog doesn't have fails the export, on purpose: the files built from an
# export that went out without it (no rooftop, no demand, no flows) would be deployed over
# good ones. That can only happen between the DROP and the CREATE of a rebuild=<table> run.


def rooftop_units(date_filter, scada_table):
    """UNION ALL branch that adds rooftop solar to a scada export as one pseudo-unit per
    region (QLD_PV, NSW_PV, VIC_PV, SA_PV, TAS_PV), so every chart built on units shows it.

    AEMO publishes an estimate per region and half hour (MW at the end of the interval).
    Taken here: the MEASUREMENT estimate, the latest version of it, and never a blank one
    (QI 0 means AEMO had none - that half hour is missing, not zero). Then, to sit on the
    5-minute grid of the units:
      - between two consecutive half hours, a straight line;
      - across a missing half hour, nothing: the point alone, no line through the hole;
      - after the newest half hour, its value held for up to 55 minutes, because the next
        estimate lands 30 to 60 minutes late and the stack would otherwise end in a cliff.
        It never runs past the newest interval of the units themselves."""
    # Bounded by the units on both sides, in SQL (fetching a TIMESTAMPTZ into Python needs
    # pytz, which the import job's venv doesn't have; that broke the import on 2026-10-02):
    # not before the calendar's first day, which is where the units' history starts (AEMO's
    # estimate starts 2018-03-06 and alone made March 2018 a "100% renewable" month on the
    # History page), and not past the units' newest interval.
    cap = f"""AND ts >= (SELECT CAST(min(date) AS TIMESTAMPTZ) FROM catalog.mart.dim_calendar)
              AND ts <= COALESCE((SELECT max(SETTLEMENTDATE) FROM {scada_table}
                                  WHERE DATE >= CURRENT_DATE - INTERVAL 7 DAY), 'infinity'::TIMESTAMPTZ)"""
    return f"""
        UNION ALL
        SELECT DUID, CAST(ts AS DATE) AS date, CAST(strftime(ts, '%H%M') AS SMALLINT) AS time,
            CAST(mw AS REAL) AS mw
        FROM (
            WITH half_hours AS (
                SELECT REGIONID, INTERVAL_DATETIME AS ts, arg_max(POWER, LASTCHANGED) AS mw
                FROM {ROOFTOP}
                WHERE TYPE = 'MEASUREMENT' AND POWER IS NOT NULL AND QI > 0
                    AND REGIONID IN {ROOFTOP_REGIONS} {date_filter}
                GROUP BY ALL
            ), spans AS (
                SELECT *, lead(ts) OVER w AS next_ts, lead(mw) OVER w AS next_mw
                FROM half_hours WINDOW w AS (PARTITION BY REGIONID ORDER BY ts)
            )
            SELECT replace(REGIONID, '1', '') || '_PV' AS DUID, ts + to_minutes(5 * step) AS ts,
                CASE WHEN next_ts = ts + INTERVAL 30 MINUTE THEN mw + (next_mw - mw) * step / 6.0
                     ELSE mw END AS mw
            FROM spans, range(12) AS steps(step)
            WHERE step = 0 OR (step < 6 AND next_ts = ts + INTERVAL 30 MINUTE) OR next_ts IS NULL
        )
        WHERE mw <> 0 {cap}
    """


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
            {rooftop_units(cutoff_filter(), "catalog.landing.fct_scada")}
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


def export_curtailment():
    """Curtailed energy per unit and day: what a wind or solar farm could have made and was
    not dispatched for. Per 5 minutes it is AVAILABILITY - TOTALCLEARED (the unit's available
    MW against its dispatch target), never below 0, over the units AEMO classes as
    Semi-Scheduled (dim_duid.Classification): those are the ones a target caps. For any other
    unit the same subtraction is just headroom. Checked on 2026-10-03 against AEMO's own
    regional figures (the REGIONSUM record's SS_WIND/SS_SOLAR availability less cleared MW):
    the units add up to them at every interval tried.

    It has to be worked out here, from the catalog: a fully curtailed unit is at 0 MW, and
    the scada export leaves the 0 MW rows out. From the next-day files only, so it ends
    yesterday: the intraday files carry no availability. The newest date is left out: a daily
    file runs 04:05 to 04:00, so that date only has its first four hours until the next file
    lands. available_mwh is the denominator of a curtailment rate. A unit that is no longer
    on the registration list has no classification and is left out."""
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, date,
                CAST(SUM(GREATEST(available - target, 0)) / 12.0 AS REAL) AS curtailed_mwh,
                CAST(SUM(available) / 12.0 AS REAL) AS available_mwh
            FROM (
                SELECT DUID, CAST(SETTLEMENTDATE AS DATE) AS date,
                    ANY_VALUE(AVAILABILITY) AS available, ANY_VALUE(TOTALCLEARED) AS target
                FROM catalog.landing.fct_scada
                WHERE INTERVENTION = 0 {cutoff_filter()}
                    AND DUID IN (SELECT DUID FROM catalog.mart.dim_duid
                                 WHERE Classification = 'Semi-Scheduled')
                GROUP BY DUID, SETTLEMENTDATE
            )
            WHERE date < (SELECT max(DATE) FROM catalog.landing.fct_scada)
            GROUP BY ALL
            HAVING SUM(available) > 0
        ) TO '{DASHBOARD_DIR}/fct_curtailment.parquet' (FORMAT PARQUET);
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
            {rooftop_units("AND DATE >= CURRENT_DATE - INTERVAL 14 DAY", "catalog.landing.fct_scada_today")}
        ) TO '{DASHBOARD_DIR}/fct_scada_today.parquet' (FORMAT PARQUET);
    """)
    con.close()


def export_price_today():
    """Price from the PRICE rows, demand and net interchange from the REGIONSUM rows of the
    same DispatchIS files (fct_regionsum_today), last 14 days. An interval fct_regionsum_today
    doesn't have keeps a NULL demand.

    Also the region's semi-scheduled wind and solar: available MW and curtailed MW (available
    less the dispatch target, never below 0), AEMO's own regional figures. They are the same
    measure as export_curtailment's per unit (the units add up to them), and they carry the
    curtailment chart past the newest next-day file, right up to now."""
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            WITH p AS (
                SELECT REGIONID, SETTLEMENTDATE, CAST(ANY_VALUE(RRP) AS REAL) AS price
                FROM catalog.landing.fct_price_today
                WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY AND INTERVENTION = 0
                GROUP BY ALL
            ), r AS (
                SELECT REGIONID, SETTLEMENTDATE,
                    CAST(ANY_VALUE(TOTALDEMAND) AS REAL) AS demand,
                    CAST(ANY_VALUE(NETINTERCHANGE) AS REAL) AS net_interchange,
                    CAST(ANY_VALUE(SS_WIND_AVAILABILITY) AS REAL) AS wind_available,
                    CAST(GREATEST(ANY_VALUE(SS_WIND_AVAILABILITY) - ANY_VALUE(SS_WIND_CLEAREDMW), 0) AS REAL) AS wind_curtailed,
                    CAST(ANY_VALUE(SS_SOLAR_AVAILABILITY) AS REAL) AS solar_available,
                    CAST(GREATEST(ANY_VALUE(SS_SOLAR_AVAILABILITY) - ANY_VALUE(SS_SOLAR_CLEAREDMW), 0) AS REAL) AS solar_curtailed
                FROM catalog.landing.fct_regionsum_today
                WHERE DATE >= CURRENT_DATE - INTERVAL 14 DAY AND INTERVENTION = 0
                GROUP BY ALL
            )
            SELECT p.REGIONID, CAST(p.SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(p.SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                p.price, r.demand, r.net_interchange,
                r.wind_available, r.wind_curtailed, r.solar_available, r.solar_curtailed
            FROM p LEFT JOIN r ON r.REGIONID = p.REGIONID AND r.SETTLEMENTDATE = p.SETTLEMENTDATE
        ) TO '{DASHBOARD_DIR}/fct_price_today.parquet' (FORMAT PARQUET);
    """)
    con.close()


def _export_interconnector(date_filter, parquet):
    """Interconnector flows (MW, positive from the first region in the ID to the second) and
    limits. ANY_VALUE also settles August 2026, which the table holds from two sources."""
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT INTERCONNECTORID AS interconnector, CAST(SETTLEMENTDATE AS DATE) AS date,
                CAST(strftime(SETTLEMENTDATE, '%H%M') AS SMALLINT) AS time,
                CAST(ANY_VALUE(MWFLOW) AS REAL) AS mw,
                CAST(ANY_VALUE(EXPORTLIMIT) AS REAL) AS export_limit,
                CAST(ANY_VALUE(IMPORTLIMIT) AS REAL) AS import_limit
            FROM catalog.landing.fct_interconnector_today
            WHERE INTERVENTION = 0 {date_filter}
            GROUP BY ALL
        ) TO '{DASHBOARD_DIR}/{parquet}' (FORMAT PARQUET);
    """)
    con.close()


def export_interconnector_today():
    """The last 14 days, for energy_today.duckdb."""
    _export_interconnector("AND DATE >= CURRENT_DATE - INTERVAL 14 DAY",
                           "fct_interconnector_today.parquet")


def export_interconnector():
    """The history (2018 on: AEMO's monthly archive, then the DispatchIS files), for the
    half-year files. Same cutoff as scada and price."""
    _export_interconnector(cutoff_filter(), "fct_interconnector.parquet")


def export_dim_duid():
    """The registered units, plus the rooftop pseudo-units of rooftop_units(): one per region
    that has an estimate, fuel 'Rooftop solar', renewable, the state name taken from the
    region's own units. No coordinates and no capacity: neither is published with the
    estimate, so those columns are left out below and BY NAME fills them with NULL."""
    con = connect_iceberg()
    con.execute(f"""
        COPY (
            SELECT DUID, Region, FuelSourceDescriptor, Participant, State, latitude, longitude,
                StationName, TechnologyType, RegCapMW, MaxCapMW, StorageMWh, Renewable,
                Classification
            FROM catalog.mart.dim_duid
            UNION ALL BY NAME
            SELECT replace(r.REGIONID, '1', '') || '_PV' AS DUID, r.REGIONID AS Region,
                'Rooftop solar' AS FuelSourceDescriptor,
                'Rooftop solar (AEMO estimate)' AS Participant, s.State,
                'Rooftop solar ' || replace(r.REGIONID, '1', '') AS StationName,
                'Rooftop PV, estimated' AS TechnologyType, true AS Renewable
            FROM (SELECT DISTINCT REGIONID FROM {ROOFTOP}
                  WHERE TYPE = 'MEASUREMENT' AND REGIONID IN {ROOFTOP_REGIONS}) r
            LEFT JOIN (SELECT Region, ANY_VALUE(State) AS State FROM catalog.mart.dim_duid GROUP BY Region) s
                ON s.Region = r.REGIONID
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


def build_history_file(path, where, order):
    """One .duckdb of the 5-minute history (scada, price, interconnector); its size in MB.
    `order` is the sort, with {key} for the table's unit, region or interconnector column."""
    ycon = duckdb.connect(path)
    for table, key in (("scada", "DUID"), ("price", "REGIONID"), ("interconnector", "interconnector")):
        ycon.execute(f"""
            CREATE TABLE {table} AS
            SELECT * FROM '{DASHBOARD_DIR}/fct_{table}.parquet'
            {where}
            ORDER BY {order.format(key=key)}
        """)
    ycon.close()
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"Built {path} ({size_mb:.1f} MB)")
    return size_mb


def build_daily():
    # Clean old files
    for f in os.listdir(DASHBOARD_DIR):
        if f.startswith("energy_data") or f == "energy_daily.duckdb":
            os.remove(os.path.join(DASHBOARD_DIR, f))

    if MAX_FILE_MB is None:
        # No limit: one file. It is not downloaded: the page reads it in place over HTTP, so
        # it is sorted by date first, which makes a date range a few Range reads.
        build_history_file(os.path.join(DASHBOARD_DIR, "energy_data.duckdb"), "", "date, {key}, time")
        return

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

    # Build per-half-year files with scada + price + interconnector
    for year, half in periods:
        tag = f"{year}_h{half}"
        month_lo = 1 if half == 1 else 7
        month_hi = 6 if half == 1 else 12
        path = os.path.join(DASHBOARD_DIR, f"energy_data_{tag}.duckdb")
        size_mb = build_history_file(
            path,
            f"""WHERE EXTRACT(YEAR FROM date) = {year}
              AND EXTRACT(MONTH FROM date) BETWEEN {month_lo} AND {month_hi}""",
            "{key}, date, time")
        if size_mb > MAX_FILE_MB:
            raise SystemExit(f"{path} is {size_mb:.1f} MB, over the {MAX_FILE_MB} MB the host "
                             f"takes; the history needs a finer split than half-years.")

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
    curtailment = f"'{DASHBOARD_DIR}/fct_curtailment.parquet'"
    # The newest date of the scada export is never a whole day: a next-day file runs 04:05 to
    # 04:00, so that date only has its first four hours until the next file lands. Counted in
    # month_days, it would divide hours 4-23 of the current month by one day too many.
    whole_days = f"date < (SELECT max(date) FROM {scada})"
    # Each table: (date column, its query over the parquet exports).
    # - scada_daily / price_daily: one row per unit (region) and day, for ranges over 30 days.
    # - curtailment_daily: one row per semi-scheduled unit and day (export_curtailment).
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
            FROM {scada} WHERE mw > 0 AND {whole_days} GROUP BY ALL ORDER BY DUID, month, hour"""),
        "price_hourly": ("month", f"""
            SELECT REGIONID, CAST(date_trunc('month', date) AS DATE) AS month,
                CAST(time // 100 AS TINYINT) AS hour, CAST(AVG(price) AS REAL) AS price,
                CAST(COUNT(*) AS INTEGER) AS n
            FROM {price} GROUP BY ALL ORDER BY REGIONID, month, hour"""),
        "month_days": ("month", f"""
            SELECT CAST(date_trunc('month', date) AS DATE) AS month,
                CAST(COUNT(DISTINCT date) AS SMALLINT) AS days
            FROM {scada} WHERE {whole_days} GROUP BY ALL ORDER BY month"""),
        "curtailment_daily": ("date", f"""
            SELECT DUID, date, curtailed_mwh, available_mwh
            FROM {curtailment} ORDER BY DUID, date"""),
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
    for f in ["fct_scada.parquet", "fct_price.parquet", "fct_interconnector.parquet",
              "fct_curtailment.parquet"]:
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
    "export_interconnector": export_interconnector,
    "export_curtailment": export_curtailment,
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
