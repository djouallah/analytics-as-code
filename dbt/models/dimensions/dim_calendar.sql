-- Append-only: the NOT IN filter below already keeps existing dates out, so there is
-- nothing to delete (and this catalog rejects commits that mix deletes with inserts).
-- The series runs two years ahead of today; assert_calendar_covers_future guards it. A run
-- whose calendar already reaches that far (its newest date from the manifests) sends nothing.
-- It starts on 2018-03-06, the first day AEMO has a rooftop solar estimate: the units'
-- history is loaded from that day too, so every series on the dashboard starts together.
{{ config(
    materialized='incremental',
    incremental_strategy='append'
) }}

{%- set cal_min, cal_max = date_bounds(this, 'date') if is_incremental() else (none, none) %}
{%- set horizon = run_query("SELECT CAST(current_date + INTERVAL 2 YEAR AS DATE)").rows[0][0] if cal_max else none %}

{% if cal_max and cal_max >= horizon %}
{{ nothing_to_do() }}
{% else %}
SELECT
  CAST(date AS DATE) as date,
  CAST(EXTRACT(year FROM date) AS INT) as year,
  CAST(EXTRACT(month FROM date) AS INT) as month
FROM (
  SELECT unnest(generate_series(
    CAST('2018-03-06' AS DATE),
    CAST(current_date + INTERVAL 2 YEAR AS DATE),
    INTERVAL 1 DAY
  )) as date
)
{% if is_incremental() %}
WHERE date NOT IN (SELECT date FROM {{ this }})
{% endif %}
{% endif %}
