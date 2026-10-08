-- The regions, for Power BI: what the unit, the regional and the rooftop tables are all
-- filtered by. Taken from dim_duid, so it holds WA1 too (Western Australia, another market:
-- units and no prices). Insert-only merge, like dim_duid: a region is added, never changed.
-- With no region missing here, a run sends nothing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['Region'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

{%- set regions_sql %}
SELECT Region, MAX(State) AS State
FROM {{ ref('dim_duid') }}
WHERE Region IS NOT NULL
GROUP BY Region
{%- endset %}
{%- set to_write = true %}
{%- if execute and is_incremental() and flags.WHICH in ('run', 'build', 'retry') %}
  {%- set to_write = run_query("SELECT COUNT(*) FROM (" ~ regions_sql ~ ") n WHERE n.Region NOT IN (SELECT Region FROM "
                                ~ this ~ ")").rows[0][0] > 0 %}
{%- endif %}

{% if not to_write %}
{{ nothing_to_do() }}
{% else %}
{{ regions_sql }}
{% endif %}
