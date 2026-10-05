-- Grain check: the merge key of fct_region_hourly must be unique.
SELECT REGIONID, month, hour, COUNT(*) AS n
FROM {{ ref('fct_region_hourly') }}
GROUP BY ALL
HAVING COUNT(*) > 1
