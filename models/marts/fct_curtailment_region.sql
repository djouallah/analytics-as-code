-- Curtailed and available energy per region, day and fuel (Wind, Solar): what the curtailment
-- chart reads, from two sources and one table. A derived reporting table: the sources stay as
-- they are.
--   * source 'farms': fct_curtailment, the semi-scheduled farms per day, added up by their
--     region and fuel (dim_duid). Whole days only, from the next-day files, so it ends a day or
--     two ago.
--   * source 'aemo': AEMO's regional semi-scheduled figures (fct_region: available MW, and
--     available less cleared), for the days after the farms' newest. The farms add up to them
--     (checked 2026-10-03). The newest day is still filling.
-- A day moves from 'aemo' to 'farms' once its next-day file lands, and an 'aemo' day changes
-- while it fills, so this is the one mart table whose rows are revised: one MERGE, one commit,
-- updates a row whose figures or source changed, inserts a new one, and deletes an 'aemo' row
-- the run no longer gives (until 2026-10-17 a pre-hook DELETE in a commit of its own, then an
-- insert-only merge: OneLake refused delete files and data files in one commit). Small (a row
-- per region, day and fuel), so every run recomputes all of it.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date', 'fuel'],
    merge_clauses={
      'when_matched': [{
        'condition': ['DBT_INTERNAL_DEST.curtailed_mwh IS DISTINCT FROM DBT_INTERNAL_SOURCE.curtailed_mwh'
                      ~ ' OR DBT_INTERNAL_DEST.available_mwh IS DISTINCT FROM DBT_INTERNAL_SOURCE.available_mwh'
                      ~ ' OR DBT_INTERNAL_DEST.source IS DISTINCT FROM DBT_INTERNAL_SOURCE.source'],
        'action': 'update', 'mode': 'by_name'}],
      'when_not_matched': [
        {'action': 'insert', 'mode': 'by_name'},
        {'by': 'source', 'condition': "DBT_INTERNAL_DEST.source = 'aemo'", 'action': 'delete'}]
    },
    schema='mart',
    tags=['powerbi']
) }}

{#- The farms' newest day, from the manifests: a literal, so the scans of fct_region prune. #}
{%- set farms_min, farms_max = date_bounds(ref('fct_curtailment'), 'date') %}

WITH
farms AS (
  SELECT d.Region AS REGIONID, c.date, d.FuelSourceDescriptor AS fuel,
    SUM(c.curtailed_mwh) AS curtailed_mwh, SUM(c.available_mwh) AS available_mwh
  FROM {{ ref('fct_curtailment') }} c
  JOIN {{ ref('dim_duid') }} d ON d.DUID = c.DUID
  WHERE d.FuelSourceDescriptor IN ('Wind', 'Solar')
  GROUP BY ALL
),

aemo AS (
  SELECT REGIONID, date, fuel,
    SUM(curtailed) / 12.0 AS curtailed_mwh, SUM(available) / 12.0 AS available_mwh
  FROM (
    SELECT REGIONID, date, 'Wind' AS fuel, wind_curtailed AS curtailed, wind_available AS available
    FROM {{ ref('fct_region') }}
    {%- if farms_max %} WHERE date > DATE '{{ farms_max }}'{% endif %}
    UNION ALL
    SELECT REGIONID, date, 'Solar', solar_curtailed, solar_available
    FROM {{ ref('fct_region') }}
    {%- if farms_max %} WHERE date > DATE '{{ farms_max }}'{% endif %}
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
