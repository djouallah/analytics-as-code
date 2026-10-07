-- depends_on: {{ ref('fct_scada_today') }}
-- depends_on: {{ ref('fct_price_today') }}
-- depends_on: {{ ref('fct_price') }}
-- depends_on: {{ ref('fct_rooftop') }}
-- depends_on: {{ ref('fct_region') }}

-- The table Power BI reads: one row per unit and 5 minutes with its MW and the price of its
-- region, so no report joins two facts. The idea is the fct_summary of the iceberg tree of
-- djouallah/fabric-medallion-dbt-community (dbt1/models/aemo/iceberg/marts/fct_summary.sql),
-- the same as the sibling repo's; the dates it reads are decided differently here (below).
--
-- Determinism contract: same inputs => same summary, regardless of the run history. Every
-- run emits the COMPLETE recomputation -- the same SQL as a first build -- for exactly the
-- dates whose stored content could still be stale, and the write reconciles that batch key
-- by key. A partial top-up would fossilize gaps forever.
--
-- Insert-only, like every model here: the OneLake Iceberg REST catalog rejects a
-- matched-UPDATE branch (BadRequest 400). Consequence: a re-emitted row carrying REVISED
-- mw/price does NOT overwrite what is stored -- craters (missing keys) are repaired, changed
-- values are not. The repair lever is rebuild=fct_summary (process_data.yml): the table is
-- dropped and the next runs recompute it.
--
-- WHICH DATES, AND HOW THEY ARE FOUND (2026-10-06). The dates are decided at compile time
-- and written into the SQL as literals, so that every scan of fct_scada carries a constant
-- DATE filter, which duckdb-iceberg prunes data files on. The reference's SQL asked them of
-- the data (MAX(DATE), DISTINCT DATE ... NOT IN, COUNT(DISTINCT time) per date): five full
-- scans of fct_scada and two of this table, 450-700 s a run over OneLake, to recompute a
-- week. The bounds come from the Iceberg manifests (macros/date_bounds.sql), not from scans.
--   * Every run: from six days before the newest daily date on -- a date first written
--     from the intraday feed is incomplete until its daily file lands, which is several
--     days later if the pipeline missed a run, so a window, not just the newest date -- and
--     the intraday feed's intervals after the newest daily interval.
--   * Refill (a first build, or after rebuild=fct_summary): process_limit dates below the
--     oldest date this table holds, newest first, until it reaches fct_scada's oldest. The
--     refill is contiguous downward, so MIN(date) is the frontier; nothing is asked of
--     this table's rows. Uncapped, the first build ran the runner out of memory (12.4 GiB,
--     2026-10-05).
--   * Not kept: the reference's "partially written" dates (COUNT(DISTINCT time) < 280). It
--     repaired dates whose second daily file landed after a backfill batch had moved on.
--     fct_scada now holds the whole archive, so a refill reads dates whose files are all
--     there, and the window recomputes the newest week every run.
--     tests/assert_fct_summary_no_partial_dates.sql remains the tripwire; the repair is
--     rebuild=fct_summary.
--
-- No merge path DELETES a row the recomputation stops producing, which is why dispatch_duids
-- gates the intraday branch to units the daily branch can reproduce: some non-scheduled
-- units publish SCADA telemetry and never appear in the next-day files. It is the units of
-- the window's next-day rows: fct_scada keeps 0 MW rows, so every unit the next-day files
-- know is in them every day, and a unit they stopped carrying can no longer be reproduced
-- by the daily branch -- the reference's DISTINCT over all history let such a unit through,
-- at the price of a full scan. A unit new to the next-day files is gated in from the day
-- its first file lands. Treat any edit to it as load-bearing.
--
-- ROOFTOP SOLAR (2026-10-07) is five units of this table, ROOFTOP_<region> (dim_duid): the
-- half-hourly estimate of fct_rooftop, kept there as published, on the straight line between
-- two consecutive half hours (a half hour and the five times after it; nothing across a
-- missing one, nothing carried forward), with the region's price of that interval
-- (fct_region). 0 MW rows are left out, as for the units. A derived reporting table may hold
-- what the source must not (AGENTS.md): this is where rooftop and the units meet, so that a
-- report reads one table.
-- An interval is written only when both sources have it: every branch stops at the newest
-- half hour all five regions' rooftop has (`both_until`, a literal). The units of the
-- intraday feed are 30-60 minutes later for it; they are written by the run after rooftop
-- catches up, as the tail is recomputed every run. Before 2018-03-06 there is no rooftop
-- and the units are on their own.
-- The rooftop branch takes the same dates as the others. var backfill_rooftop (a dispatch
-- input of process_data.yml) makes it take all of rooftop's history, once: rooftop alone,
-- about 2.5M rows, which is what the merge is handed.
--
-- Tagged `powerbi`: process_data.yml builds the mart tables in a step of their own, after
-- the landing facts they read, so a failure here cannot fail the load of those.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['date', 'time', 'DUID'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

{# No full-history lever inside the model, deliberately: a var that makes the incremental
   branch emit all history would hand the merge the whole table as a source. Reset =
   rebuild=fct_summary. #}
{# Closes with `%}`, NOT `-%}`: a right-strip swallows the newlines after this tag and
   glues WITH onto the `-- depends_on` comment line above, commenting the keyword out
   (the compiled SQL then starts at `daily_summary AS (` and the parser errors there). #}
{%- set scoped = is_incremental() %}
{%- set process_limit = env_var('process_limit', '1000') | int %}
{%- set day = modules.datetime.timedelta(days=1) %}
{%- set scada_min, scada_max = date_bounds(ref('fct_scada'), 'DATE') %}
{%- set summary_min, summary_max = date_bounds(this, 'date') if scoped else (none, none) %}

{#- The date ranges the daily branch recomputes: [from, to), to exclusive, none = open. #}
{%- set ranges = [] %}
{%- set scada_max_ts = none %}
{%- if scada_max %}
  {%- set window_from = scada_max - 6 * day %}
  {%- if scoped %}
    {%- do ranges.append((window_from, none)) %}
    {%- set frontier = window_from if summary_min is none or summary_min > window_from else summary_min %}
    {%- if scada_min and frontier > scada_min %}
      {%- do ranges.append((frontier - process_limit * day, frontier)) %}
    {%- endif %}
  {%- else %}
    {%- do ranges.append((scada_max - (process_limit - 1) * day, none)) %}
  {%- endif %}
  {%- if execute %}
    {%- set scada_max_ts = run_query("SELECT CAST(MAX(SETTLEMENTDATE) AS VARCHAR) FROM " ~ ref('fct_scada')
                                     ~ " WHERE DATE >= DATE '" ~ scada_max ~ "'").rows[0][0] %}
  {%- endif %}
{%- endif %}
{#- The newest interval both sources have: the newest half hour that every region's rooftop
    has. fct_rooftop is small (a row per region and half hour); read whole. #}
{%- set backfill_rooftop = var('backfill_rooftop', false) %}
{%- set both_until = none %}
{%- if execute and flags.WHICH in ('run', 'build', 'retry') %}
  {%- set both_until = run_query("SELECT CAST(MIN(newest) AS VARCHAR) FROM (SELECT REGIONID, MAX(CAST(date AS TIMESTAMP)"
                                  ~ " + to_minutes((time // 100) * 60 + time % 100)) AS newest FROM " ~ ref('fct_rooftop')
                                  ~ " GROUP BY REGIONID)").rows[0][0] %}
{%- endif %}
{%- if execute %}
  {%- do log("fct_summary: both sources until " ~ both_until ~ (", rooftop backfill: all of its history" if backfill_rooftop else ""), info=True) %}
  {%- do log("fct_summary: fct_scada " ~ scada_min ~ " .. " ~ scada_max ~ " (newest interval " ~ scada_max_ts
             ~ "), this " ~ summary_min ~ " .. " ~ summary_max ~ "; recomputing " ~ ranges_text(ranges), info=True) %}
{%- endif %}

WITH
dispatch_duids AS (
  SELECT DISTINCT DUID FROM {{ ref('fct_scada') }}
  WHERE {{ date_ranges_sql(ranges, 'DATE') }}
),

daily_summary AS (
  {%- for lo, hi in ranges %}
  SELECT
    s.DATE as date,
    CAST(strftime(s.SETTLEMENTDATE, '%H%M') AS INT) as time,
    s.DUID,
    MAX(s.INITIALMW) as mw,
    MAX(p.RRP) as price
  FROM {{ ref('fct_scada') }} s
  -- INNER joins: `WHERE p.INTERVENTION = 0` always discarded null-price rows anyway,
  -- so the old LEFT JOINs were inner joins in disguise — say what we do.
  JOIN {{ ref('dim_duid') }} d ON s.DUID = d.DUID
  JOIN {{ ref('fct_price') }} p
    ON s.SETTLEMENTDATE = p.SETTLEMENTDATE AND d.Region = p.REGIONID
  WHERE
    s.INTERVENTION = 0
    AND s.INITIALMW <> 0
    AND p.INTERVENTION = 0
    AND {{ date_ranges_sql([(lo, hi)], 's.DATE') }}
    AND {{ date_ranges_sql([(lo, hi)], 'p.DATE') }}
  GROUP BY ALL

  UNION ALL
  {%- endfor %}

  -- Intraday tail: intervals beyond the daily horizon. Its dates are in the window by
  -- construction (they are the newest daily date and after), so no further scoping.
  SELECT
    s.DATE as date,
    CAST(strftime(s.SETTLEMENTDATE, '%H%M') AS INT) as time,
    s.DUID,
    MAX(s.INITIALMW) as mw,
    MAX(p.RRP) as price
  FROM {{ ref('fct_scada_today') }} s
  JOIN {{ ref('dim_duid') }} d ON s.DUID = d.DUID
  JOIN {{ ref('fct_price_today') }} p
    ON s.SETTLEMENTDATE = p.SETTLEMENTDATE AND d.Region = p.REGIONID
  WHERE
    s.INITIALMW <> 0
    AND p.INTERVENTION = 0
    -- Only units the daily branch will be able to reproduce once this date settles.
    AND s.DUID IN (SELECT DUID FROM dispatch_duids)
    {%- if scada_max_ts %}
    AND s.DATE >= DATE '{{ scada_max }}'
    AND p.DATE >= DATE '{{ scada_max }}'
    AND s.SETTLEMENTDATE > TIMESTAMPTZ '{{ scada_max_ts }}'
    {%- else %}
    AND FALSE
    {%- endif %}
  GROUP BY ALL
),

-- Rooftop at 5 minutes: a half hour (its value) and the five times after it, on the line to
-- the next half hour, which must exist. 23:30's next half hour is 00:00 of the next date.
rooftop_half_hours AS (
  SELECT REGIONID, date, time, mw, (time // 100) * 60 + time % 100 AS minute
  FROM {{ ref('fct_rooftop') }}
),

rooftop AS (
  SELECT
    a.date,
    CAST((a.minute + 5 * s.step) // 60 * 100 + (a.minute + 5 * s.step) % 60 AS INT) AS time,
    'ROOFTOP_' || a.REGIONID AS DUID,
    a.REGIONID,
    CASE WHEN s.step = 0 THEN a.mw ELSE a.mw + (b.mw - a.mw) * s.step / 6.0 END AS mw
  FROM rooftop_half_hours a
  CROSS JOIN range(6) s(step)
  LEFT JOIN rooftop_half_hours b
    ON b.REGIONID = a.REGIONID
    AND b.date = CASE WHEN a.minute = 1410 THEN a.date + 1 ELSE a.date END
    AND b.minute = CASE WHEN a.minute = 1410 THEN 0 ELSE a.minute + 30 END
  WHERE (s.step = 0 OR b.mw IS NOT NULL)
    {%- if not backfill_rooftop %}
    AND {{ date_ranges_sql(ranges, 'a.date') }}
    {%- endif %}
),

summary AS (
  SELECT date, time, DUID, mw, price FROM daily_summary
  UNION ALL
  SELECT r.date, r.time, r.DUID, r.mw, p.price
  FROM rooftop r
  JOIN {{ ref('fct_region') }} p ON p.REGIONID = r.REGIONID AND p.date = r.date AND p.time = r.time
  WHERE r.mw <> 0
    {%- if not backfill_rooftop %}
    AND {{ date_ranges_sql(ranges, 'p.date') }}
    {%- endif %}
)

SELECT
  date,
  time,
  DUID,
  CAST(mw AS DECIMAL(18, 4)) AS mw,
  CAST(price AS DECIMAL(18, 4)) AS price,
  -- Provenance column only: no read path depends on it. Kept so the table has the same
  -- columns as the sibling's.
  GREATEST(
    TIMESTAMPTZ '{{ scada_max_ts or "1900-01-01 00:00:00+00" }}',
    COALESCE((SELECT MAX(SETTLEMENTDATE) FROM {{ ref('fct_scada_today') }}
              {%- if scada_max %} WHERE DATE >= DATE '{{ scada_max }}'{% else %} WHERE FALSE{% endif %}),
             TIMESTAMPTZ '1900-01-01 00:00:00+00')
  ) AS cutoff
FROM summary
{%- if both_until %}
WHERE CAST(date AS TIMESTAMP) + to_minutes((time // 100) * 60 + time % 100) <= TIMESTAMP '{{ both_until }}'
{%- endif %}
-- As in the sibling's copies. It makes no claim about physical layout: this SQL is a merge
-- SOURCE, so nothing about the ordering reaches the stored table.
ORDER BY date, time
