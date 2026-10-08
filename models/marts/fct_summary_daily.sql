-- Energy per unit and day, with the day's average price of the unit's region: fct_summary
-- one grain up. What the dashboard reads for ranges over 30 days, where the 5-minute fact is
-- too much for a browser. mwh is the day's NET energy: a battery's charging is
-- taken off its output.
--
-- output_mwh, charging_mwh and revenue are the day's sums of what the 5-minute measures sum
-- (output, charging, output x price), so the semantic model's measures give the same number
-- from this table as from fct_summary and read this one when no time of day is asked for.
-- They are DOUBLE, not DECIMAL(18, 4): rounded to 4 decimals, a unit that makes 50 kWh in a
-- day is 0.1% off, and its capture price with it.
--
-- A day is written once, when the next-day files hold it whole (macros/whole_days.sql), and
-- only from the day fct_summary has reached: it fills its history newest first. The price
-- comes from fct_region_daily, so a day that table does not hold yet waits. Insert-only
-- merge on the grain; rebuild=fct_summary_daily resets it.
--
-- Rooftop solar is five units of fct_summary since 2026-10-07. var backfill_rooftop (a
-- dispatch input of process_data.yml, once) also adds their rows for every day this table
-- already holds: those days were written before fct_summary had them.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['DUID', 'date'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

{#- The oldest day fct_summary holds (it fills newest first) is the floor: a day it does
    not hold yet waits. From the manifests, like the ranges (macros/whole_days.sql). #}
{%- set summary_min, summary_max = date_bounds(ref('fct_summary'), 'date') %}
{%- set ranges = pending_day_ranges(floor=summary_min) %}
{%- set backfill_rooftop = var('backfill_rooftop', false) and is_incremental() %}
{%- set this_min, this_max = date_bounds(this, 'date') if backfill_rooftop else (none, none) %}

{% if is_incremental() and not backfill_rooftop and not has_whole_days(ranges) %}
{{ nothing_to_do() }}
{% else %}
WITH
days AS (
  {{ whole_days(ranges) }}
)

SELECT
  s.DUID,
  s.date,
  CAST(SUM(s.mw) / 12.0 AS DECIMAL(18, 4)) AS mwh,
  MAX(p.price) AS price,
  SUM(CAST(GREATEST(s.mw, 0) AS DOUBLE)) / 12 AS output_mwh,
  SUM(CAST(LEAST(s.mw, 0) AS DOUBLE)) / 12 AS charging_mwh,
  SUM(CAST(GREATEST(s.mw, 0) AS DOUBLE) * s.price) / 12 AS revenue
FROM {{ ref('fct_summary') }} s
JOIN {{ ref('dim_duid') }} d ON d.DUID = s.DUID
JOIN {{ ref('fct_region_daily') }} p ON p.REGIONID = d.Region AND p.date = s.date
WHERE ({{ date_ranges_sql(ranges, 's.date') }}
  AND s.date IN (SELECT date FROM days))
  {%- if backfill_rooftop and this_max %}
  OR (starts_with(s.DUID, 'ROOFTOP_') AND s.date <= DATE '{{ this_max }}')
  {%- endif %}
GROUP BY s.DUID, s.date
{% endif %}
