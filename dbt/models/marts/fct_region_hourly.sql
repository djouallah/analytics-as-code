-- Price per region, month and hour of day: what the dashboard's price heatmap reads for
-- ranges over 30 days. price is the plain average of the month's intervals at that hour and
-- intervals is how many were averaged, so a range's price at an hour is the average over
-- its months weighted by it. hour is time // 100.
--
-- The same months as fct_summary_hourly: the whole ones (dim_month). Insert-only merge on
-- the grain; rebuild=fct_region_hourly resets it. An incremental run reads only the months
-- dim_month has and this table does not (macros/date_bounds.sql pending_months, from the
-- manifests), as literals, so the scan of fct_region prunes; none missing, nothing is sent.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['REGIONID', 'month', 'hour'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

{%- set to_write, held_min, held_max = pending_months() %}
{%- set held_next = (held_max + modules.datetime.timedelta(days=32)).replace(day=1) if held_max else none %}
{% if not to_write %}
{{ nothing_to_do() }}
{% else %}
SELECT
  r.REGIONID,
  m.month,
  CAST(r.time // 100 AS INT) AS hour,
  CAST(AVG(r.price) AS DECIMAL(18, 4)) AS price,
  CAST(COUNT(*) AS INT) AS intervals
FROM {{ ref('fct_region') }} r
JOIN {{ ref('dim_month') }} m ON r.date >= m.month AND r.date < m.month + INTERVAL 1 MONTH
{%- if held_max %}
WHERE (m.month > DATE '{{ held_max }}' OR m.month < DATE '{{ held_min }}')
  AND (r.date >= DATE '{{ held_next }}' OR r.date < DATE '{{ held_min }}')
{%- endif %}
GROUP BY r.REGIONID, m.month, CAST(r.time // 100 AS INT)
{% endif %}
