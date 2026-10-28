-- Grain check: the merge key of fct_summary_hourly must be unique.
SELECT DUID, month, hour, COUNT(*) AS n
FROM {{ ref('fct_summary_hourly') }}
GROUP BY ALL
HAVING COUNT(*) > 1
