"""Parity: the deployed semantic model against the dashboard's deployed files.

    POWERBI_TOKEN=... WS_ID=... ADOMD_DIR=... PYTHONNET_RUNTIME=coreclr python parity_model.py

Two readers of the same catalog have to say the same thing. One side is the Power BI model
(Direct Lake over the mart tables), asked in DAX over XMLA as check_model.py does. The other
is what the dashboard shows: the .duckdb files published at DEPLOYED_DATA_URL, read here
with DuckDB and the dashboard's own rules (model.bim, compiler.js, the page). Every measure
is compared per day and region, per day and fuel, or per day and link, over the newest
settled days (PARITY_DAYS, 5) that the dashboard's newest history file holds.

The files store REAL and the tables DECIMAL(18,4), so numbers are equal within TOLERANCE.

ONE KNOWN DIFFERENCE OF METHOD, reported and not failed: rooftop's capture price. The model
weights the half-hourly estimate by the half hour's average price (fct_rooftop stores what
AEMO publishes); the dashboard weights its interpolated 5-minute points by the 5-minute
price. The model is held to the half-hourly figure computed from the dashboard's data, and
the distance to the dashboard's 5-minute figure is printed.

Exits 1 on any mismatch, or if there is nothing to compare.
"""

import json
import os
import sys
import tempfile
import urllib.request

import duckdb

import check_model as model

DATA = os.environ.get("DEPLOYED_DATA_URL", "https://nemtracker.github.io/data")
DAYS = int(os.environ.get("PARITY_DAYS", "5"))
TOLERANCE = 2e-4   # relative
ROOFTOP_CAPTURE = "Rooftop capture price"


def dashboard():
    """The dashboard's files, attached as dim, today, agg and h (the newest half-year)."""
    folder = tempfile.mkdtemp()

    def fetch(name):
        path = os.path.join(folder, name)
        urllib.request.urlretrieve(f"{DATA}/{name}", path)
        return path

    with open(fetch("daily_manifest.json"), encoding="utf-8") as f:
        period = sorted(json.load(f)["periods"])[-1]
    con = duckdb.connect()
    for alias, name in (("dim", "energy_dim.duckdb"), ("today", "energy_today.duckdb"),
                        ("agg", "energy_daily_agg.duckdb"), ("h", f"energy_data_{period}.duckdb")):
        con.execute(f"ATTACH '{fetch(name)}' AS {alias} (READ_ONLY)")
    return con, period


# The dashboard's figures. Each query returns its keys first (date, then the slice) and the
# measures under the model's names. `days` is a list of dates as SQL.
UNITS = """
    SELECT s.date, s.DUID, d.Region AS region, d.FuelSourceDescriptor AS fuel, d.Renewable AS renewable,
      d.RegCapMW AS cap, s.time, s.mw, p.price
    FROM h.scada s
    JOIN dim.dim_duid d ON d.DUID = s.DUID
    JOIN h.price p ON p.date = s.date AND p.time = s.time AND p.REGIONID = d.Region
    WHERE NOT suffix(s.DUID, '_PV') AND s.date IN ({days})"""
ROOFTOP = """
    SELECT replace(DUID, '_PV', '') || '1' AS region, date, time, mw
    FROM h.scada WHERE suffix(DUID, '_PV') AND date IN ({days})"""
EXPECTED = {
    "region": [f"""
        WITH units AS ({UNITS}), per_unit AS (
          SELECT date, region, DUID, any_value(cap) AS cap, sum(greatest(mw, 0)) / 12 AS mwh FROM units GROUP BY ALL
        ), hours AS (
          SELECT date, count(DISTINCT time) / 12.0 AS hours FROM h.price WHERE date IN ({{days}}) GROUP BY ALL
        ), cf AS (
          SELECT date, region, 100 * sum(mwh) FILTER (WHERE cap > 0) / (sum(cap) * any_value(hours)) AS cf
          FROM per_unit JOIN hours USING (date) GROUP BY ALL
        ), u AS (
          SELECT date, region,
            sum(greatest(mw, 0)) / 12 AS gen, sum(least(mw, 0)) / 12 AS charging, count(DISTINCT DUID) AS units,
            sum(greatest(mw, 0) * price) / nullif(sum(greatest(mw, 0)), 0) AS capture,
            sum(greatest(mw, 0)) FILTER (WHERE renewable) / 12 AS renewable_gen,
            sum(greatest(mw, 0)) FILTER (WHERE coalesce(fuel, '') <> 'Grid') / 12 AS generator_gen
          FROM units GROUP BY ALL
        ), r AS (
          SELECT date, region, sum(mw) / 12 AS rooftop FROM ({ROOFTOP}) GROUP BY ALL
        )
        SELECT date, region,
          u.gen AS "Generation MWh", u.charging AS "Charging MWh", u.units AS "Units",
          u.capture AS "Capture price", r.rooftop AS "Rooftop MWh",
          coalesce(u.gen, 0) + coalesce(r.rooftop, 0) AS "Total generation MWh",
          100 * (coalesce(u.renewable_gen, 0) + coalesce(r.rooftop, 0))
            / nullif(coalesce(u.generator_gen, 0) + coalesce(r.rooftop, 0), 0) AS "Renewable share",
          cf.cf AS "Capacity factor"
        FROM u FULL JOIN r USING (date, region) LEFT JOIN cf USING (date, region)""", """
        SELECT date, REGIONID AS region, avg(price) AS "Average price", sum(demand) / 12 AS "Demand MWh",
          avg(net_interchange) AS "Net interchange MW"
        FROM h.price WHERE date IN ({days}) GROUP BY ALL""", """
        SELECT date, REGIONID AS region,
          sum(wind_curtailed) / 12 AS "Regional wind curtailed MWh", sum(wind_available) / 12 AS "Regional wind available MWh",
          sum(solar_curtailed) / 12 AS "Regional solar curtailed MWh", sum(solar_available) / 12 AS "Regional solar available MWh"
        FROM today.price_today WHERE date IN ({days}) GROUP BY ALL""", f"""
        -- Rooftop's capture price the model's way: the half-hour points against the average
        -- price of the half hour that ends there.
        SELECT pv.date, pv.region, sum(pv.mw * hp.price) / nullif(sum(pv.mw), 0) AS "{ROOFTOP_CAPTURE}"
        FROM ({ROOFTOP}) pv
        JOIN (
          SELECT REGIONID, ends + to_minutes((30 - minute(ends) % 30) % 30) AS half_hour, avg(price) AS price, count(*) AS n
          FROM (SELECT REGIONID, price, CAST(date AS TIMESTAMP) + to_minutes((time // 100) * 60 + time % 100) AS ends FROM h.price)
          GROUP BY ALL
        ) hp ON hp.REGIONID = pv.region AND hp.n = 6
          AND hp.half_hour = CAST(pv.date AS TIMESTAMP) + to_minutes((pv.time // 100) * 60 + pv.time % 100)
        WHERE pv.time % 100 IN (0, 30) GROUP BY ALL"""],
    "fuel": [f"""
        SELECT date, fuel, sum(greatest(mw, 0)) / 12 AS "Generation MWh", sum(least(mw, 0)) / 12 AS "Charging MWh",
          count(DISTINCT DUID) AS "Units",
          sum(greatest(mw, 0) * price) / nullif(sum(greatest(mw, 0)), 0) AS "Capture price"
        FROM ({UNITS}) GROUP BY ALL""", """
        SELECT c.date, d.FuelSourceDescriptor AS fuel, sum(c.curtailed_mwh) AS "Curtailed MWh",
          sum(c.available_mwh) AS "Available MWh", 100 * sum(c.curtailed_mwh) / sum(c.available_mwh) AS "Curtailment rate"
        FROM agg.curtailment_daily c JOIN dim.dim_duid d ON d.DUID = c.DUID
        WHERE c.date IN ({days}) GROUP BY ALL"""],
    "link": ["""
        SELECT date, interconnector AS link, avg(mw) AS "Flow MW"
        FROM h.interconnector WHERE date IN ({days}) GROUP BY ALL"""],
}
SLICE = {"region": "dim_region[Region]", "fuel": "dim_duid[FuelSourceDescriptor]", "link": "fct_interconnector[interconnector]"}
# The dashboard's 5-minute figure for the one measure that differs by method.
ROOFTOP_CAPTURE_5MIN = f"""
    SELECT pv.date, pv.region, sum(pv.mw * p.price) / nullif(sum(pv.mw), 0) AS capture
    FROM ({ROOFTOP}) pv JOIN h.price p ON p.REGIONID = pv.region AND p.date = pv.date AND p.time = pv.time
    GROUP BY ALL"""


def number(text):
    if text is None or text == "":
        return None
    return float(text)


def main():
    con, period = dashboard()
    # The newest date of a history file only has its first hours: settled days come before it.
    days = [str(r[0]) for r in con.execute(
        f"SELECT DISTINCT date FROM h.scada ORDER BY date DESC LIMIT {DAYS} OFFSET 1").fetchall()]
    if not days:
        print(f"the history file {period} holds no settled day")
        return 1
    days_sql = ", ".join(f"DATE '{d}'" for d in days)
    print(f"dashboard files from {DATA}, history {period}, days {days[-1]} to {days[0]}")

    expected = {}   # (grain, date, slice, measure) -> value
    for grain, queries in EXPECTED.items():
        for sql in queries:
            cur = con.execute(sql.format(days=days_sql))
            names = [d[0] for d in cur.description]
            for row in cur.fetchall():
                for name, value in zip(names[2:], row[2:]):
                    if value is not None:
                        expected[(grain, str(row[0]), row[1] or "", name)] = float(value)

    status, body = model.call("GET", f"/groups?$filter=id%20eq%20'{model.WORKSPACE}'")
    if status != 200 or not body.get("value"):
        print(f"cannot read the workspace's name ({status}): {body}")
        return 1
    conn = model.connect(body["value"][0]["name"])
    first, last = (d.split("-") for d in (days[-1], days[0]))
    dates = (f"dim_calendar[date] >= DATE({int(first[0])}, {int(first[1])}, {int(first[2])}), "
             f"dim_calendar[date] <= DATE({int(last[0])}, {int(last[1])}, {int(last[2])})")
    got = {}
    for grain in EXPECTED:
        for measure in sorted({k[3] for k in expected if k[0] == grain}):
            dax = (f'EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS(dim_calendar[date], {SLICE[grain]}, '
                   f'"v", [{measure}]), {dates})')
            for row in model.query(conn, dax):
                value = number(row["[v]"])
                if value is not None:
                    got[(grain, row["dim_calendar[date]"][:10], row[SLICE[grain]], measure)] = value

    # A value one side does not have counts as 0 there: a blank and a zero are the same answer
    # (no charging in a region), and a figure that is really missing shows as its whole size.
    bad = []
    for key in sorted(set(expected) | set(got)):
        e, g = expected.get(key, 0.0), got.get(key, 0.0)
        if abs(e - g) > TOLERANCE * max(1.0, abs(e), abs(g)):
            bad.append((key, e, g))
    by_measure = {}
    for key in set(expected) | set(got):
        by_measure.setdefault((key[0], key[3]), [0, 0])[0] += 1
    for key, _, _ in bad:
        by_measure[(key[0], key[3])][1] += 1
    for (grain, measure), (n, wrong) in sorted(by_measure.items()):
        print(f"{'DIFF' if wrong else 'same'}  per day and {grain:<6} {measure:<30} {n - wrong}/{n}")
    for (grain, date, part, measure), e, g in bad[:60]:
        print(f"  {date} {part or '(blank)'} [{measure}]: dashboard {e}, model {g}")

    # Not a failure: how far the dashboard's 5-minute rooftop capture price is from the model's.
    five = {(str(r[0]), r[1]): r[2] for r in con.execute(ROOFTOP_CAPTURE_5MIN.format(days=days_sql)).fetchall()}
    gaps = [abs(five[(k[1], k[2])] - v) / abs(v) for k, v in got.items()
            if k[0] == "region" and k[3] == ROOFTOP_CAPTURE and five.get((k[1], k[2])) and v]
    if gaps:
        print(f"method difference, not compared: [{ROOFTOP_CAPTURE}] against the dashboard's 5-minute figure, "
              f"per day and region: mean {100 * sum(gaps) / len(gaps):.1f}%, largest {100 * max(gaps):.1f}%")

    print(f"{len(set(expected) | set(got)) - len(bad)} values equal, {len(bad)} different")
    return 1 if bad or not expected else 0


if __name__ == "__main__":
    sys.exit(main())
