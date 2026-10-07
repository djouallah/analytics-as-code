-- The links between regions, for Power BI and the Flows page: each one's two regions and
-- AEMO's description, from MMSDM INTERCONNECTOR (stg_csv_archive_log keeps the newest
-- month's copy). fct_interconnector's mw is positive from from_region to to_region. Only
-- the links between regions of dim_region: AEMO's table also lists SNOWY1 and V-SN, from
-- before the Snowy region was abolished in 2008. Insert-only merge, like dim_region: a link
-- is added, never changed.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['interconnector'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

-- depends_on: {{ ref('stg_csv_archive_log') }}

SELECT
  INTERCONNECTORID AS interconnector,
  REGIONFROM AS from_region,
  REGIONTO AS to_region,
  DESCRIPTION AS description
FROM read_csv({{ source('duid_reference', 'interconnector') }}, all_varchar = true)
WHERE REGIONFROM IN (SELECT Region FROM {{ ref('dim_region') }})
  AND REGIONTO IN (SELECT Region FROM {{ ref('dim_region') }})
