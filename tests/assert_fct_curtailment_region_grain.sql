-- Grain check: the merge key of fct_curtailment_region must be unique.
SELECT REGIONID, date, fuel, COUNT(*) AS n
FROM {{ ref('fct_curtailment_region') }}
GROUP BY ALL
HAVING COUNT(*) > 1
