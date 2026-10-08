-- Price, demand and net interchange per region and 5 minutes, with the region's
-- semi-scheduled wind and solar (available MW, and curtailed MW: available less the dispatch
-- target, never below 0). Next to fct_summary: what is per region, not per unit.
--
-- Two sources, one row per interval: the intraday record (price from the PRICE rows, the
-- rest from the REGIONSUM rows of the same DispatchIS files) where BOTH have the interval,
-- else the next-day record (fct_price's DREGION rows), which has no regional wind and solar.
-- The intraday feeds go back to 2026-08, so the history before it is the next-day record.
-- An interval the REGIONSUM rows have not delivered yet is not written from the price alone:
-- it waits for the next run, because a stored row is never completed afterwards.
--
-- NETINTERCHANGE is positive when the region exports. Demand is operational demand: rooftop
-- solar is not in it.
--
-- Insert-only merge on the grain, like every model here (the catalog rejects a matched
-- UPDATE): a missing interval is added, a stored value is not revised; rebuild=fct_region
-- resets it.
--
-- Which dates: an incremental run recomputes the days of the files its three sources loaded
-- since it last committed (pending_file_ranges, macros/pending_archive_files.sql), written
-- as literals on all three sources, so their scans prune data files. No new file: nothing
-- is sent. A first build, or one after rebuild=fct_region, reads them whole.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date', 'time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    post_hook={"sql": "{{ record_mart_watermark(['fct_price', 'fct_price_today', 'fct_regionsum_today']) }}", "transaction": false},
    tags=['powerbi']
) }}

{%- set ranges = pending_file_ranges(['fct_price', 'fct_price_today', 'fct_regionsum_today']) if is_incremental() else [(none, none)] %}
{%- set in_window = "AND " ~ date_ranges_sql(ranges, 'DATE') %}

{% if not ranges %}
{{ nothing_to_do() }}
{% else %}
WITH
price_today AS (
  SELECT REGIONID, SETTLEMENTDATE, MAX(DATE) AS date, MAX(RRP) AS price
  FROM {{ ref('fct_price_today') }}
  WHERE INTERVENTION = 0 {{ in_window }}
  GROUP BY REGIONID, SETTLEMENTDATE
),
regionsum AS (
  SELECT
    REGIONID,
    SETTLEMENTDATE,
    MAX(TOTALDEMAND) AS demand,
    MAX(NETINTERCHANGE) AS net_interchange,
    MAX(SS_WIND_AVAILABILITY) AS wind_available,
    GREATEST(MAX(SS_WIND_AVAILABILITY) - MAX(SS_WIND_CLEAREDMW), 0) AS wind_curtailed,
    MAX(SS_SOLAR_AVAILABILITY) AS solar_available,
    GREATEST(MAX(SS_SOLAR_AVAILABILITY) - MAX(SS_SOLAR_CLEAREDMW), 0) AS solar_curtailed
  FROM {{ ref('fct_regionsum_today') }}
  WHERE INTERVENTION = 0 {{ in_window }}
  GROUP BY REGIONID, SETTLEMENTDATE
),
intraday AS (
  SELECT p.REGIONID, p.SETTLEMENTDATE, p.date, p.price, r.demand, r.net_interchange,
    r.wind_available, r.wind_curtailed, r.solar_available, r.solar_curtailed
  FROM price_today p
  JOIN regionsum r ON r.REGIONID = p.REGIONID AND r.SETTLEMENTDATE = p.SETTLEMENTDATE
),
daily AS (
  SELECT REGIONID, SETTLEMENTDATE, MAX(DATE) AS date, MAX(RRP) AS price,
    MAX(TOTALDEMAND) AS demand, MAX(NETINTERCHANGE) AS net_interchange
  FROM {{ ref('fct_price') }}
  WHERE INTERVENTION = 0 {{ in_window }}
  GROUP BY REGIONID, SETTLEMENTDATE
),
intervals AS (
  SELECT * FROM intraday
  UNION ALL
  SELECT d.REGIONID, d.SETTLEMENTDATE, d.date, d.price, d.demand, d.net_interchange,
    NULL, NULL, NULL, NULL
  FROM daily d
  WHERE NOT EXISTS (
    SELECT 1 FROM intraday i
    WHERE i.REGIONID = d.REGIONID AND i.SETTLEMENTDATE = d.SETTLEMENTDATE
  )
)

SELECT
  REGIONID,
  date,
  CAST(strftime(SETTLEMENTDATE, '%H%M') AS INT) AS time,
  CAST(price AS DECIMAL(18, 4)) AS price,
  CAST(demand AS DECIMAL(18, 4)) AS demand,
  CAST(net_interchange AS DECIMAL(18, 4)) AS net_interchange,
  CAST(wind_available AS DECIMAL(18, 4)) AS wind_available,
  CAST(wind_curtailed AS DECIMAL(18, 4)) AS wind_curtailed,
  CAST(solar_available AS DECIMAL(18, 4)) AS solar_available,
  CAST(solar_curtailed AS DECIMAL(18, 4)) AS solar_curtailed
FROM intervals
{% endif %}
