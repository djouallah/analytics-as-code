-- Grain check: the merge key of fct_interconnector must be unique.
SELECT interconnector, date, time, COUNT(*) AS n
FROM {{ ref('fct_interconnector') }}
GROUP BY ALL
HAVING COUNT(*) > 1
