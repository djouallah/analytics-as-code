-- Grain check: the merge key of fct_summary_daily must be unique.
SELECT DUID, date, COUNT(*) AS n
FROM {{ ref('fct_summary_daily') }}
GROUP BY ALL
HAVING COUNT(*) > 1
