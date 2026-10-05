-- depends_on: {{ ref('fct_scada_today') }}
-- depends_on: {{ ref('fct_price_today') }}

-- The table Power BI reads: one row per unit and 5 minutes with its MW and the price of its
-- region, so no report joins two facts. Ported as it is from the iceberg tree of
-- djouallah/fabric-medallion-dbt-community (dbt1/models/aemo/iceberg/marts/fct_summary.sql),
-- the same fct_summary as the sibling repo's; fix it there first.
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
-- dropped and the next run recomputes it.
--
-- No merge path DELETES a row the recomputation stops producing, which is why dispatch_duids
-- below gates the intraday branch to units the daily branch can reproduce: some
-- non-scheduled units publish SCADA telemetry and never appear in the next-day files.
-- Treat any edit to dispatch_duids as load-bearing.
--
-- Tagged `powerbi`: process_data.yml builds it in a step of its own, after the tables the
-- dashboard reads, so a failure here cannot hold those back.
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

WITH
-- The unit universe the DAILY branch can reproduce. Gates the intraday branch so it never
-- emits a unit that will be unreproducible once the date settles (see the header).
-- Deliberately UNBOUNDED, not a trailing window: fct_scada is append-only, so this set only
-- ever GROWS and can never orphan a row it previously admitted. A rolling window would
-- reintroduce the same bug from the other side — a unit ageing out of the window turns its
-- already-written intraday rows into orphans, which merge still cannot delete.
-- Outside the `scoped` block on purpose: a --full-refresh runs the intraday branch too and
-- must apply the identical filter.
dispatch_duids AS (
  SELECT DISTINCT DUID FROM {{ ref('fct_scada') }}
),
{% if scoped %}
-- Dates whose stored content could differ from a clean recomputation. Everything older
-- is settled: its daily file has landed and been folded in, so recomputing it would
-- reproduce it exactly. Shrinking this window silently reduces what can be repaired.
rebuild_dates AS (
  -- Never seen before: archive backfill, or a first build catching up.
  SELECT DISTINCT s.DATE AS date FROM {{ ref('fct_scada') }} s
  WHERE s.INTERVENTION = 0
    AND s.DATE NOT IN (SELECT DISTINCT date FROM {{ this }})
  UNION
  -- Recently settled: a date first written from the intraday feed is incomplete until
  -- its daily file lands, which is several days later if the pipeline missed a run — so
  -- a window, not just the newest daily date.
  SELECT DISTINCT s.DATE FROM {{ ref('fct_scada') }} s
  WHERE s.DATE >= (SELECT MAX(DATE) - INTERVAL 6 DAY FROM {{ ref('fct_scada') }})
  UNION
  -- Still in flux: the intraday feed keeps extending these until their daily file lands.
  SELECT DISTINCT s.DATE FROM {{ ref('fct_scada_today') }} s
  UNION
  -- Partially written and never completed. A calendar date straddles TWO PUBLIC_DAILY files
  -- (they roll at 04:00), so a date first computed when only one had landed holds ~48 or
  -- ~240 intervals; when the second file lands in a LATER run, a 60-file backfill batch has
  -- moved MAX(DATE) two months past the 6-day window above and the date is never revisited.
  -- Every batch boundary of a backfill left one (measured 2026-09-17: spark short ~30k rows
  -- on each of 2019-01-27, 2019-11-23, 2020-01-23 after three incremental runs; the reference
  -- repo never saw it because it loads the whole archive at once). 280 matches
  -- assert_fct_summary_no_partial_dates. A date the SOURCE itself still lacks stays in this
  -- set and recomputes each run until its file lands -- a few dates' scan, nothing inserts.
  SELECT date FROM {{ this }} GROUP BY date HAVING COUNT(DISTINCT time) < 280
),
{% endif %}

daily_summary AS (
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
    {% if scoped %}
    AND s.DATE IN (SELECT date FROM rebuild_dates)
    {% endif %}
  GROUP BY ALL

  UNION ALL

  -- Intraday tail: intervals beyond the daily horizon. Every date here is in
  -- rebuild_dates by construction, so no extra scoping predicate is needed.
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
    AND s.SETTLEMENTDATE > (SELECT MAX(CAST(SETTLEMENTDATE AS TIMESTAMPTZ)) FROM {{ ref('fct_scada') }})
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
  (SELECT GREATEST(
    (SELECT MAX(CAST(SETTLEMENTDATE AS TIMESTAMPTZ)) FROM {{ ref('fct_scada') }}),
    COALESCE((SELECT MAX(CAST(SETTLEMENTDATE AS TIMESTAMPTZ)) FROM {{ ref('fct_scada_today') }}), CAST('1900-01-01' AS TIMESTAMPTZ))
  )) AS cutoff
FROM daily_summary
-- As in the sibling's copies. It makes no claim about physical layout: this SQL is a merge
-- SOURCE, so nothing about the ordering reaches the stored table.
ORDER BY date, time
