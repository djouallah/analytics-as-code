"""Temporary probe: does the pinned duckdb-iceberg skip data files of landing.fct_scada on a
subquery or join filter, or only on a literal? Read-only. Each case sums INITIALMW over the
newest 7 days (sum, not count: count can come from the manifests) and prints its time, the
data files it opened (FileSystem log) and its EXPLAIN ANALYZE. The last case is the full
scan the literals were written to avoid."""

import time

from cache_catalog import connect_iceberg

T = "catalog.landing.fct_scada"
con = connect_iceberg()
con.execute("CALL enable_logging('FileSystem')")
hi = con.execute(f"""
    SELECT max(TRY_CAST(CAST(upper_bound AS VARCHAR) AS DATE))
    FROM iceberg_column_stats({T}) WHERE column_name = 'DATE'""").fetchone()[0]
lo = con.execute(f"SELECT DATE '{hi}' - 6").fetchone()[0]
total = con.execute(f"SELECT count(*) FROM iceberg_column_stats({T}) WHERE column_name = 'DATE'").fetchone()[0]
print(f"fct_scada: {total} data files, newest DATE {hi}, window from {lo}\n", flush=True)
con.execute(f"CREATE TEMP TABLE small AS SELECT DATE '{lo}' AS d")
con.execute(f"CREATE TEMP TABLE days AS SELECT unnest(range(DATE '{lo}', DATE '{hi}' + 1, INTERVAL 1 DAY))::DATE AS d")
con.execute(f"SET VARIABLE lo = DATE '{lo}'")

stats_lo = (f"(SELECT max(TRY_CAST(CAST(upper_bound AS VARCHAR) AS DATE)) - 6 "
            f"FROM iceberg_column_stats({T}) WHERE column_name = 'DATE')")
CASES = [
    ("literal", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE >= DATE '{lo}'"),
    ("getvariable", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE >= getvariable('lo')"),
    ("scalar subquery, temp table", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE >= (SELECT d FROM small)"),
    ("scalar subquery, iceberg_column_stats", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE >= {stats_lo}"),
    ("IN subquery", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE IN (SELECT d FROM days)"),
    ("range join", f"SELECT sum(INITIALMW) FROM {T} f JOIN small s ON f.DATE >= s.d"),
    ("equi join", f"SELECT sum(INITIALMW) FROM {T} f JOIN days s ON f.DATE = s.d"),
    ("CONTROL full scan: MAX(DATE) - 6", f"SELECT sum(INITIALMW) FROM {T} WHERE DATE >= (SELECT max(DATE) - 6 FROM {T})"),
]
summary = []
for name, sql in CASES:
    con.execute("CALL truncate_duckdb_logs()")
    started = time.time()
    try:
        value = con.execute(sql).fetchone()[0]
    except Exception as e:  # noqa: BLE001 - a probe reports and goes on
        print(f"::warning::{name}: {e}")
        summary.append((name, None, None, None))
        continue
    secs = time.time() - started
    opened = con.execute("""
        SELECT count(DISTINCT regexp_extract(message, '([A-Za-z0-9_.-]+[.]parquet)', 1))
        FROM duckdb_logs WHERE type = 'FileSystem' AND message LIKE '%.parquet%'""").fetchone()[0]
    summary.append((name, secs, opened, value))
    print(f"=== {name}: {secs:.1f}s, {opened} of {total} data files opened, sum {value}", flush=True)
    for row in con.execute(f"EXPLAIN ANALYZE {sql}").fetchall():
        print(row[1])
    print(flush=True)

print("\nSUMMARY")
for name, secs, opened, value in summary:
    print(f"{name:42s} " + ("failed" if secs is None else f"{secs:7.1f}s  {opened:5d}/{total} files  sum {value}"))
