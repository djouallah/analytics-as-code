-- Rooftop solar per region and half hour, with the half hour's price: its own table, not
-- units in fct_summary. It is AEMO's estimate (MW at the end of the half hour), not a meter
-- reading. The selection: the MEASUREMENT estimate, the latest version of it, never a blank one
-- (QI 0 means AEMO had none: that half hour is missing, not zero), the five regions, from
-- the calendar's first day.
--
-- Stored as published and nothing more. The straight line between two half hours and the
-- newest value carried forward are how a chart draws it: they are worked out by whoever
-- draws, never written here. A half hour at 0 MW IS stored (unlike a unit's interval):
-- the line needs to know the estimate reached zero.
--
-- price is the average of the region's six 5-minute prices in the half hour (fct_region), so
-- that what rooftop earned needs no join. A half hour is written once all six are there;
-- like fct_summary, a row without a price is not in the table.
--
-- Insert-only merge on the grain: a missing half hour is added, a stored value is not
-- revised (a later version of an estimate is not picked up); rebuild=fct_rooftop resets it.
-- Small, so every run recomputes all of it and the merge adds what is missing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date', 'time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

WITH
half_hours AS (
  SELECT REGIONID, INTERVAL_DATETIME, MAX(DATE) AS date, arg_max(POWER, LASTCHANGED) AS mw
  FROM {{ ref('fct_rooftop_pv') }}
  WHERE TYPE = 'MEASUREMENT' AND POWER IS NOT NULL AND QI > 0
    AND REGIONID IN ('NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1')
    AND DATE >= (SELECT MIN(date) FROM {{ ref('dim_calendar') }})
  GROUP BY REGIONID, INTERVAL_DATETIME
),
-- The half hour a 5-minute interval belongs to is the one it ends in: 14:05 to 14:30 are
-- the six intervals of the half hour ending 14:30.
prices AS (
  SELECT
    REGIONID,
    ends + to_minutes((30 - minute(ends) % 30) % 30) AS half_hour,
    AVG(price) AS price,
    COUNT(*) AS intervals
  FROM (
    SELECT REGIONID, price,
      CAST(date AS TIMESTAMP) + to_minutes((time // 100) * 60 + time % 100) AS ends
    FROM {{ ref('fct_region') }}
  )
  GROUP BY ALL
)

SELECT
  h.REGIONID,
  h.date,
  CAST(strftime(h.INTERVAL_DATETIME, '%H%M') AS INT) AS time,
  CAST(h.mw AS DECIMAL(18, 4)) AS mw,
  CAST(p.price AS DECIMAL(18, 4)) AS price
FROM half_hours h
JOIN prices p
  ON p.REGIONID = h.REGIONID
  AND p.half_hour = CAST(h.INTERVAL_DATETIME AS TIMESTAMP)
  AND p.intervals = 6
WHERE h.mw IS NOT NULL
