-- Grain check: the merge key of fct_summary must be unique. This is the tripwire for a
-- residual concurrent-writer race, and for an incremental strategy that stopped deduping.
SELECT date, time, DUID, COUNT(*) AS n
FROM {{ ref('fct_summary') }}
GROUP BY ALL
HAVING COUNT(*) > 1
