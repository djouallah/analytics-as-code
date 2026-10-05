-- Price per region, month and hour of day: what the dashboard's price heatmap reads for
-- ranges over 30 days. price is the plain average of the month's intervals at that hour and
-- intervals is how many were averaged, so a range's price at an hour is the average over
-- its months weighted by it. hour is time // 100.
--
-- The same months as fct_summary_hourly: the whole ones (dim_month). Insert-only merge on
-- the grain; rebuild=fct_region_hourly resets it. Small, so every run recomputes all of it.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'month', 'hour'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

SELECT
  r.REGIONID,
  m.month,
  CAST(r.time // 100 AS INT) AS hour,
  CAST(AVG(r.price) AS DECIMAL(18, 4)) AS price,
  CAST(COUNT(*) AS INT) AS intervals
FROM {{ ref('fct_region') }} r
JOIN {{ ref('dim_month') }} m ON r.date >= m.month AND r.date < m.month + INTERVAL 1 MONTH
GROUP BY r.REGIONID, m.month, CAST(r.time // 100 AS INT)
