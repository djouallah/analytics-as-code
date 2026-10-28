-- Grain check: the merge key of fct_region must be unique.
SELECT REGIONID, date, time, COUNT(*) AS n
FROM {{ ref('fct_region') }}
GROUP BY ALL
HAVING COUNT(*) > 1
