-- Curtailed energy per unit and day: what a wind or solar farm could have made and was not
-- dispatched for. Per 5 minutes it is AVAILABILITY - TOTALCLEARED (the unit's available MW
-- against its dispatch target), never below 0, over the units AEMO classes as Semi-Scheduled
-- (dim_duid.Classification): those are the ones a target caps; for any other unit the same
-- subtraction is just headroom. available_mwh is the denominator of a curtailment rate.
-- Checked against AEMO's regional SS_WIND/SS_SOLAR figures (2026-10-03): the units add up to
-- them.
--
-- From the next-day files, which carry the availability. It cannot be read off fct_summary:
-- a fully curtailed unit is at 0 MW, and 0 MW rows are not in it.
--
-- A DAY IS WRITTEN ONCE, WHEN IT IS WHOLE: when fct_scada holds its 288 intervals. A
-- calendar date straddles two daily files, and a day summed from one of them could not be
-- completed afterwards (insert-only merge on the grain: a stored value is not revised).
-- Days not written yet are taken newest first, process_limit per run, like fct_summary: the
-- fact is 300M rows. A unit that is not Semi-Scheduled in dim_duid when its day is written
-- is not there; rebuild=fct_curtailment recomputes everything.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['DUID', 'date'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

WITH
days AS (
  {{ whole_days() }}
),
intervals AS (
  SELECT DUID, DATE AS date, MAX(AVAILABILITY) AS available, MAX(TOTALCLEARED) AS target
  FROM {{ ref('fct_scada') }}
  WHERE INTERVENTION = 0
    AND DATE IN (SELECT date FROM days)
    AND DUID IN (SELECT DUID FROM {{ ref('dim_duid') }} WHERE Classification = 'Semi-Scheduled')
  GROUP BY DUID, DATE, SETTLEMENTDATE
)

SELECT
  DUID,
  date,
  CAST(SUM(GREATEST(available - target, 0)) / 12.0 AS DECIMAL(18, 4)) AS curtailed_mwh,
  CAST(SUM(available) / 12.0 AS DECIMAL(18, 4)) AS available_mwh
FROM intervals
GROUP BY DUID, date
HAVING SUM(available) > 0
