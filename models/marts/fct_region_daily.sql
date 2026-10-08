-- Price, demand and net interchange per region and day: the plain average of the day's
-- 5-minute intervals in fct_region. What the dashboard reads for ranges over 30 days, and
-- what gives fct_summary_daily its price.
--
-- A day is written once, when fct_region holds its 288 intervals for the region (insert-only
-- merge on the grain: a stored value is not revised; rebuild=fct_region_daily resets it).
-- An incremental run looks at the days from six days before the newest one it holds on (from
-- the Iceberg manifests, a literal, so the scan of fct_region prunes), as fct_region does.
-- When none of them is whole and missing here, it has nothing to write and sends nothing
-- (macros/nothing_to_do.sql). A first build reads fct_region whole.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'date'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

{%- set this_min, this_max = date_bounds(this, 'date') if is_incremental() else (none, none) %}
{%- set window_from = this_max - modules.datetime.timedelta(days=6) if this_max else none %}
{%- set in_window = "WHERE date >= DATE '" ~ window_from ~ "'" if window_from else "" %}
{%- set days_sql %}
SELECT REGIONID, date
FROM {{ ref('fct_region') }}
{{ in_window }}
GROUP BY REGIONID, date
HAVING COUNT(*) = 288
{%- endset %}
{%- set to_write = true %}
{%- if window_from and execute and flags.WHICH in ('run', 'build', 'retry') %}
  {%- set to_write = run_query("SELECT COUNT(*) FROM (" ~ days_sql ~ ") n WHERE NOT EXISTS (SELECT 1 FROM "
                                ~ this ~ " t WHERE t.date >= DATE '" ~ window_from
                                ~ "' AND t.REGIONID = n.REGIONID AND t.date = n.date)").rows[0][0] > 0 %}
  {%- do log("fct_region_daily: this .. " ~ this_max ~ "; looking at " ~ window_from ~ " .. open; "
             ~ ("days to write" if to_write else "nothing to write"), info=True) %}
{%- endif %}

{% if not to_write %}
{{ nothing_to_do() }}
{% else %}
SELECT
  REGIONID,
  date,
  CAST(AVG(price) AS DECIMAL(18, 4)) AS price,
  CAST(AVG(demand) AS DECIMAL(18, 4)) AS demand,
  CAST(AVG(net_interchange) AS DECIMAL(18, 4)) AS net_interchange
FROM {{ ref('fct_region') }}
{{ in_window }}
GROUP BY REGIONID, date
HAVING COUNT(*) = 288
{% endif %}
