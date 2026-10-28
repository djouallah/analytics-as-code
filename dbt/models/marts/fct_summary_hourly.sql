-- Energy per unit, month and hour of day: what the dashboard's average-day chart reads for
-- ranges over 30 days. Output only: an interval where the unit is charging is left out, as the
-- chart leaves storage charging out. hour is time // 100, like the 5-minute charts: the
-- interval ending 14:00 is hour 14. A range's average MW at an hour is SUM(mwh) over its
-- months / SUM(dim_month.days) over the same months.
--
-- A month is written once, when it is whole (dim_month), a year of them per run, newest
-- first. Insert-only merge on the grain; rebuild=fct_summary_hourly resets it.
--
-- Rooftop solar is five units of fct_summary since 2026-10-07. var backfill_rooftop (a
-- dispatch input of process_data.yml, once) also adds their rows for every month this table
-- already holds: those months were written before fct_summary had them.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['DUID', 'month', 'hour'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

{%- set to_write, held_min, held_max = pending_months() %}
{% if not to_write and not var('backfill_rooftop', false) %}
{{ nothing_to_do() }}
{% else %}
WITH
months AS (
  SELECT month, month + INTERVAL 1 MONTH AS next_month
  FROM {{ ref('dim_month') }}
  {% if is_incremental() %}
  WHERE month NOT IN (SELECT DISTINCT month FROM {{ this }})
  {% endif %}
  ORDER BY month DESC
  LIMIT 12
){% if var('backfill_rooftop', false) and is_incremental() %},

held AS (
  SELECT month, month + INTERVAL 1 MONTH AS next_month
  FROM (SELECT DISTINCT month FROM {{ this }})
){% endif %}

SELECT
  s.DUID,
  m.month,
  CAST(s.time // 100 AS INT) AS hour,
  CAST(SUM(s.mw) / 12.0 AS DECIMAL(18, 4)) AS mwh
FROM {{ ref('fct_summary') }} s
JOIN months m ON s.date >= m.month AND s.date < m.next_month
WHERE s.mw > 0
  AND s.date >= (SELECT MIN(month) FROM months)
  AND s.date < (SELECT MAX(next_month) FROM months)
GROUP BY s.DUID, m.month, CAST(s.time // 100 AS INT)
{%- if var('backfill_rooftop', false) and is_incremental() %}

UNION ALL

SELECT
  s.DUID,
  m.month,
  CAST(s.time // 100 AS INT) AS hour,
  CAST(SUM(s.mw) / 12.0 AS DECIMAL(18, 4)) AS mwh
FROM {{ ref('fct_summary') }} s
JOIN held m ON s.date >= m.month AND s.date < m.next_month
WHERE s.mw > 0
  AND starts_with(s.DUID, 'ROOFTOP_')
GROUP BY s.DUID, m.month, CAST(s.time // 100 AS INT)
{%- endif %}
{% endif %}
