-- Grain check: the merge key of fct_scada must be unique.

SELECT file, DUID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_scada') }}
GROUP BY ALL
HAVING COUNT(*) > 1
