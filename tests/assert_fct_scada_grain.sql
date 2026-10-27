-- Grain check: the merge key of fct_scada must be unique.
-- Over the last 14 days only. The whole table (half a billion rows since 2018) grouped by
-- its key needs more memory and spill disk than a runner has (the runner was killed every
-- night from 2026-10-21, then the spill hit the disk quota). A duplicate can only come in
-- with a load: the merges insert keys, never rewrite one, and loaded files never change.

SELECT file, DUID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_scada') }}
WHERE DATE >= current_date - 14
GROUP BY ALL
HAVING COUNT(*) > 1
