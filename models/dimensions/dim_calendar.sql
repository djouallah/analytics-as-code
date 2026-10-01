-- Append-only: the NOT IN filter below already keeps existing dates out, so there is
-- nothing to delete (and this catalog rejects commits that mix deletes with inserts).
-- The series runs two years ahead of today; assert_calendar_covers_future guards it.
{{ config(
    materialized='incremental',
    incremental_strategy='append'
) }}

SELECT
  CAST(date AS DATE) as date,
  CAST(EXTRACT(year FROM date) AS INT) as year,
  CAST(EXTRACT(month FROM date) AS INT) as month
FROM (
  SELECT unnest(generate_series(
    CAST('2018-04-01' AS DATE),
    CAST(current_date + INTERVAL 2 YEAR AS DATE),
    INTERVAL 1 DAY
  )) as date
)
{% if is_incremental() %}
WHERE date NOT IN (SELECT date FROM {{ this }})
{% endif %}
