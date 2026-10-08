-- The months the hour-of-day tables hold, with their number of days: the divisor that turns
-- a month's energy at an hour into an average MW (SUM(mwh) / SUM(days) over the months of a
-- range). For Power BI and the dashboard's long ranges.
--
-- A month is written once, when it is whole: when fct_summary_daily holds every day of it.
-- The hour-of-day tables (fct_summary_hourly, fct_region_hourly) take their months from
-- here, so the three always agree. Insert-only merge; the running month is not in it.
--
-- Which months: decided at compile time from the Iceberg manifests (macros/date_bounds.sql),
-- no scan. The whole months fct_summary_daily can hold run from the first month it starts
-- on its 1st to the last month it ends on its last day. When this table already holds all of
-- them, there is nothing to write and nothing is sent (macros/nothing_to_do.sql); when only
-- newer ones are missing, only the days after the newest month held are read.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['month'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

{%- set td = modules.datetime.timedelta %}
{%- set daily_min, daily_max = date_bounds(ref('fct_summary_daily'), 'date') %}
{%- set this_min, this_max = date_bounds(this, 'month') if is_incremental() else (none, none) %}
{%- set from_date = none %}
{%- set to_write = true %}
{%- if daily_min and daily_max and this_min and this_max %}
  {%- set first_whole = daily_min if daily_min.day == 1 else (daily_min.replace(day=1) + td(days=32)).replace(day=1) %}
  {%- set last_whole = daily_max.replace(day=1) if (daily_max + td(days=1)).day == 1 else (daily_max.replace(day=1) - td(days=1)).replace(day=1) %}
  {%- if first_whole >= this_min %}
    {%- set from_date = (this_max + td(days=32)).replace(day=1) %}
    {%- set to_write = last_whole > this_max %}
  {%- endif %}
  {%- do log("dim_month: fct_summary_daily " ~ daily_min ~ " .. " ~ daily_max ~ ", whole months " ~ first_whole ~ " .. "
             ~ last_whole ~ ", this " ~ this_min ~ " .. " ~ this_max ~ "; "
             ~ ("nothing to write" if not to_write else "reading from " ~ (from_date or "the start")), info=True) %}
{%- endif %}

{% if not to_write %}
{{ nothing_to_do() }}
{% else %}
SELECT
  CAST(date_trunc('month', date) AS DATE) AS month,
  CAST(COUNT(DISTINCT date) AS INT) AS days
FROM {{ ref('fct_summary_daily') }}
{%- if from_date %}
WHERE date >= DATE '{{ from_date }}'
{%- endif %}
GROUP BY 1
HAVING COUNT(DISTINCT date) = day(last_day(MIN(date)))
{% endif %}
