-- Energy per unit and day, with the day's average price of the unit's region: fct_summary
-- one grain up. What the dashboard reads for ranges over 30 days (the rule
-- scripts/cache_catalog.py applied in build_daily_agg, as scada_daily), where the 5-minute
-- fact is too much for a browser. mwh is the day's NET energy: a battery's charging is
-- taken off its output.
--
-- output_mwh, charging_mwh and revenue are the day's sums of what the 5-minute measures sum
-- (output, charging, output x price), so the semantic model's measures give the same number
-- from this table as from fct_summary and read this one when no time of day is asked for.
-- They are DOUBLE, not DECIMAL(18, 4): rounded to 4 decimals, a unit that makes 50 kWh in a
-- day is 0.1% off, and its capture price with it.
--
-- A day is written once, when the next-day files hold it whole (macros/whole_days.sql), and
-- only from the day fct_summary has reached: it fills its history newest first. The price
-- comes from fct_region_daily, so a day that table does not hold yet waits. Insert-only
-- merge on the grain; rebuild=fct_summary_daily resets it.
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
  {{ whole_days("DATE >= (SELECT MIN(date) FROM " ~ ref('fct_summary') ~ ")") }}
)

SELECT
  s.DUID,
  s.date,
  CAST(SUM(s.mw) / 12.0 AS DECIMAL(18, 4)) AS mwh,
  MAX(p.price) AS price,
  SUM(CAST(GREATEST(s.mw, 0) AS DOUBLE)) / 12 AS output_mwh,
  SUM(CAST(LEAST(s.mw, 0) AS DOUBLE)) / 12 AS charging_mwh,
  SUM(CAST(GREATEST(s.mw, 0) AS DOUBLE) * s.price) / 12 AS revenue
FROM {{ ref('fct_summary') }} s
JOIN {{ ref('dim_duid') }} d ON d.DUID = s.DUID
JOIN {{ ref('fct_region_daily') }} p ON p.REGIONID = d.Region AND p.date = s.date
WHERE s.date IN (SELECT date FROM days)
GROUP BY s.DUID, s.date
