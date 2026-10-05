-- Grain check: the merge key of fct_region_daily must be unique.
SELECT REGIONID, date, COUNT(*) AS n
FROM {{ ref('fct_region_daily') }}
GROUP BY ALL
HAVING COUNT(*) > 1
