-- Price, demand and net interchange per region and day: the plain average of the day's
-- 5-minute intervals in fct_region. What the dashboard reads for ranges over 30 days (the
-- rule scripts/cache_catalog.py applied in build_daily_agg, as price_daily), and what gives
-- fct_summary_daily its price.
--
-- A day is written once, when fct_region holds its 288 intervals for the region (insert-only
-- merge on the grain: a stored value is not revised; rebuild=fct_region_daily resets it).
-- Small, so every run recomputes all of it and the merge adds what is missing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

SELECT
  REGIONID,
  date,
  CAST(AVG(price) AS DECIMAL(18, 4)) AS price,
  CAST(AVG(demand) AS DECIMAL(18, 4)) AS demand,
  CAST(AVG(net_interchange) AS DECIMAL(18, 4)) AS net_interchange
FROM {{ ref('fct_region') }}
GROUP BY REGIONID, date
HAVING COUNT(*) = 288
