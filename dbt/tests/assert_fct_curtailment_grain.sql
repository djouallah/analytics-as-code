-- Grain check: the merge key of fct_curtailment must be unique.
SELECT DUID, date, COUNT(*) AS n
FROM {{ ref('fct_curtailment') }}
GROUP BY ALL
HAVING COUNT(*) > 1
