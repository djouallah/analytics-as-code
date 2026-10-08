-- Curtailed and available energy per region, day and fuel (Wind, Solar): what the curtailment
-- chart reads, from two sources and one table. A derived reporting table: the sources stay as
-- they are.
--   * source 'farms': fct_curtailment, the semi-scheduled farms per day, added up by their
--     region and fuel (dim_duid). Whole days only, from the next-day files, so it ends a day or
--     two ago.
--   * source 'aemo': AEMO's regional semi-scheduled figures (fct_region: available MW, and
--     available less cleared), for the days after the farms' newest. The farms add up to them
--     (checked 2026-10-03). The newest day is still filling.
-- Which days: those of the files loaded since it last committed into fct_scada and into
-- fct_region's sources (pending_file_ranges, macros/pending_archive_files.sql); no new file,
-- nothing sent. A day moves from 'aemo' to 'farms' once its next-day file lands, and that
-- file's days are then pending: a replacement, so each run first DELETEs the 'aemo' rows of
-- its days in a commit of its own (the pre-hook: OneLake refuses a commit that mixes delete
-- files and data files, a DELETE alone works), then the insert-only merge adds the farm days
-- it lacks and the 'aemo' days as they are now. The two commits are not atomic: between them
-- those days are missing, and a run that fails after the DELETE leaves them missing until
-- the next run, which reads the same files again (the watermark is the post-hook).
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date', 'fuel'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    pre_hook={"sql": "{% if is_incremental() %}DELETE FROM {{ this }} WHERE source = 'aemo' AND {{ date_ranges_sql(pending_file_ranges(['fct_scada', 'fct_price', 'fct_price_today', 'fct_regionsum_today']), 'date') }}{% else %}SELECT 1{% endif %}", "transaction": false},
    post_hook={"sql": "{{ record_mart_watermark(['fct_scada', 'fct_price', 'fct_price_today', 'fct_regionsum_today']) }}", "transaction": false},
    schema='mart',
    tags=['powerbi']
) }}

{#- The farms' newest day, from the manifests: a literal, so the scans of fct_region prune. #}
{%- set ranges = pending_file_ranges(['fct_scada', 'fct_price', 'fct_price_today', 'fct_regionsum_today']) if is_incremental() else [(none, none)] %}
{%- set farms_min, farms_max = date_bounds(ref('fct_curtailment'), 'date') if ranges else (none, none) %}

{% if not ranges %}
{{ nothing_to_do() }}
{% else %}
WITH
farms AS (
  SELECT d.Region AS REGIONID, c.date, d.FuelSourceDescriptor AS fuel,
    SUM(c.curtailed_mwh) AS curtailed_mwh, SUM(c.available_mwh) AS available_mwh
  FROM {{ ref('fct_curtailment') }} c
  JOIN {{ ref('dim_duid') }} d ON d.DUID = c.DUID
  WHERE d.FuelSourceDescriptor IN ('Wind', 'Solar')
    AND {{ date_ranges_sql(ranges, 'c.date') }}
  GROUP BY ALL
),

aemo AS (
  SELECT REGIONID, date, fuel,
    SUM(curtailed) / 12.0 AS curtailed_mwh, SUM(available) / 12.0 AS available_mwh
  FROM (
    SELECT REGIONID, date, 'Wind' AS fuel, wind_curtailed AS curtailed, wind_available AS available
    FROM {{ ref('fct_region') }}
    WHERE {{ date_ranges_sql(ranges, 'date') }}{% if farms_max %} AND date > DATE '{{ farms_max }}'{% endif %}
    UNION ALL
    SELECT REGIONID, date, 'Solar', solar_curtailed, solar_available
    FROM {{ ref('fct_region') }}
    WHERE {{ date_ranges_sql(ranges, 'date') }}{% if farms_max %} AND date > DATE '{{ farms_max }}'{% endif %}
  )
  WHERE available IS NOT NULL
  GROUP BY ALL
)

SELECT REGIONID, date, fuel, CAST(curtailed_mwh AS DECIMAL(18, 4)) AS curtailed_mwh,
  CAST(available_mwh AS DECIMAL(18, 4)) AS available_mwh, 'farms' AS source
FROM farms
UNION ALL
SELECT REGIONID, date, fuel, CAST(curtailed_mwh AS DECIMAL(18, 4)), CAST(available_mwh AS DECIMAL(18, 4)), 'aemo'
FROM aemo
{% endif %}
