-- Grain check: the merge key of fct_price must be unique.

SELECT file, REGIONID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_price') }}
GROUP BY ALL
HAVING COUNT(*) > 1
