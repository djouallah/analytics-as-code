-- The regions, for Power BI: what the unit, the regional and the rooftop tables are all
-- filtered by. Taken from dim_duid, so it holds WA1 too (Western Australia, another market:
-- units and no prices). Insert-only merge, like dim_duid: a region is added, never changed.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['Region'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

SELECT Region, MAX(State) AS State
FROM {{ ref('dim_duid') }}
WHERE Region IS NOT NULL
GROUP BY Region
