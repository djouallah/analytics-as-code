-- depends_on: {{ ref('fct_scada_today') }}
-- depends_on: {{ ref('fct_price_today') }}
-- depends_on: {{ ref('fct_price') }}

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
{%- if execute %}
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
FROM daily_summary
-- As in the sibling's copies. It makes no claim about physical layout: this SQL is a merge
-- SOURCE, so nothing about the ordering reaches the stored table.
ORDER BY date, time
