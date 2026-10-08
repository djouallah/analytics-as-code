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
-- An incremental run recomputes the days of the files loaded since it last committed into
-- fct_rooftop_pv and into fct_region's sources (pending_file_ranges,
-- macros/pending_archive_files.sql), a day either side: the half hour ending 00:00 is a row
-- of the next day and averages five prices of the day before. No new file, nothing sent.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date', 'time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    post_hook={"sql": "{{ record_mart_watermark(['fct_rooftop_pv', 'fct_price', 'fct_price_today', 'fct_regionsum_today']) }}", "transaction": false},
    tags=['powerbi']
) }}

{%- set ranges = pending_file_ranges(['fct_rooftop_pv', 'fct_price', 'fct_price_today', 'fct_regionsum_today'], before=1, after=1) if is_incremental() else [(none, none)] %}

{% if not ranges %}
{{ nothing_to_do() }}
{% else %}
WITH
half_hours AS (
  SELECT REGIONID, INTERVAL_DATETIME, MAX(DATE) AS date, arg_max(POWER, LASTCHANGED) AS mw
  FROM {{ ref('fct_rooftop_pv') }}
  WHERE TYPE = 'MEASUREMENT' AND POWER IS NOT NULL AND QI > 0
    AND REGIONID IN ('NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1')
    AND DATE >= (SELECT MIN(date) FROM {{ ref('dim_calendar') }})
    AND {{ date_ranges_sql(ranges, 'DATE') }}
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
    WHERE {{ date_ranges_sql(ranges, 'date') }}
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
{% endif %}
