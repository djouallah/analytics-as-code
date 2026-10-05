-- Grain check: the merge key of fct_rooftop must be unique.
SELECT REGIONID, date, time, COUNT(*) AS n
FROM {{ ref('fct_rooftop') }}
GROUP BY ALL
HAVING COUNT(*) > 1
