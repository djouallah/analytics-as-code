-- Test: no two values of a dim_duid text column differ only in case.
--
-- Power BI compares and groups text case-insensitively and the dashboard's DuckDB does not,
-- so two spellings of one name would be one group in the report and two on the page (found
-- by the parity check, 2026-10-07: a station AEMO spells two ways). dim_duid folds
-- StationName, Participant and TechnologyType, and Plant and Owner come from them; this keeps
-- every column a chart groups or filters by to one spelling, the fuel and region included.

{% set columns = ['Region', 'State', 'FuelSourceDescriptor', 'StationName', 'Participant',
                  'TechnologyType', 'Classification', 'Plant', 'Owner'] %}

{% for c in columns %}
SELECT '{{ c }}' AS column_name, lower({{ c }}) AS value, count(DISTINCT {{ c }}) AS spellings
FROM {{ ref('dim_duid') }}
WHERE {{ c }} IS NOT NULL
GROUP BY lower({{ c }})
HAVING count(DISTINCT {{ c }}) > 1
{% if not loop.last %}UNION ALL{% endif %}
{% endfor %}
