-- The links between regions, for Power BI and the Flows page: each one's two regions and
-- AEMO's description, from MMSDM INTERCONNECTOR (stg_csv_archive_log keeps the newest
-- month's copy). fct_interconnector's mw is positive from from_region to to_region. Only
-- the links between regions of dim_region: AEMO's table also lists SNOWY1 and V-SN, from
-- before the Snowy region was abolished in 2008. Insert-only merge, like dim_region: a link
-- is added, never changed. With no link missing here, a run sends nothing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['interconnector'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

-- depends_on: {{ ref('stg_csv_archive_log') }}

{%- set links_sql %}
SELECT
  INTERCONNECTORID AS interconnector,
  REGIONFROM AS from_region,
  REGIONTO AS to_region,
  DESCRIPTION AS description
FROM read_csv({{ source('duid_reference', 'interconnector') }}, all_varchar = true)
WHERE REGIONFROM IN (SELECT Region FROM {{ ref('dim_region') }})
  AND REGIONTO IN (SELECT Region FROM {{ ref('dim_region') }})
{%- endset %}
{%- set to_write = true %}
{%- if execute and is_incremental() and flags.WHICH in ('run', 'build', 'retry') %}
  {%- set to_write = run_query("SELECT COUNT(*) FROM (" ~ links_sql ~ ") n WHERE n.interconnector NOT IN (SELECT interconnector FROM "
                                ~ this ~ ")").rows[0][0] > 0 %}
{%- endif %}

{% if not to_write %}
{{ nothing_to_do() }}
{% else %}
{{ links_sql }}
{% endif %}
