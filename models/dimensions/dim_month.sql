-- The months the hour-of-day tables hold, with their number of days: the divisor that turns
-- a month's energy at an hour into an average MW (SUM(mwh) / SUM(days) over the months of a
-- range). For Power BI and the dashboard's long ranges.
--
-- A month is written once, when it is whole: when fct_summary_daily holds every day of it.
-- The hour-of-day tables (fct_summary_hourly, fct_region_hourly) take their months from
-- here, so the three always agree. Insert-only merge; the running month is not in it.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['month'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

SELECT
  CAST(date_trunc('month', date) AS DATE) AS month,
  CAST(COUNT(DISTINCT date) AS INT) AS days
FROM {{ ref('fct_summary_daily') }}
GROUP BY 1
HAVING COUNT(DISTINCT date) = day(last_day(MIN(date)))
