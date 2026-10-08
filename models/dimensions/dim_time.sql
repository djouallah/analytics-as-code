-- The 5-minute times of a day, for Power BI: 288 rows. It is the time axis every fact is
-- read against, and what lets a measure give rooftop solar a value between two half hours:
-- fct_rooftop only has rows at :00 and :30, and the straight line between them is worked out
-- by the reader, never stored. `time` is the HHMM the facts carry (1435 is 14:35, the
-- interval ends at it); `minute` is the same as minutes since midnight, which is what the
-- arithmetic needs. Insert-only merge: a fixed list, so once it is there a run sends nothing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    tags=['powerbi']
) }}

{% if is_incremental() %}
{{ nothing_to_do() }}
{% else %}
SELECT
  CAST((minute // 60) * 100 + minute % 60 AS INT) AS time,
  CAST(minute AS INT) AS minute,
  CAST(minute // 60 AS INT) AS hour
FROM (SELECT unnest(generate_series(0, 1435, 5)) AS minute)
{% endif %}
