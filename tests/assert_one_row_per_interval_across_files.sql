-- `file` is part of every merge key, so the grain tests only catch one file read twice. The
-- same interval from two different files (a next-day file present under two publish stamps,
-- the GitHub backfill and AEMO's folder both supplying a day) would be two rows that no test
-- sees. The dashboard export collapses them with ANY_VALUE, but a reader of the Iceberg
-- tables would double-count. Returns the keys found in more than one file.
-- Warn-only: what to do about it (dedupe in the model, or accept) is a decision, not a bug fix.
{{ config(severity='warn') }}
SELECT 'fct_scada' AS model, DUID AS id, SETTLEMENTDATE, INTERVENTION, COUNT(DISTINCT file) AS files
FROM {{ ref('fct_scada') }}
GROUP BY ALL
HAVING COUNT(DISTINCT file) > 1
UNION ALL
SELECT 'fct_price', REGIONID, SETTLEMENTDATE, INTERVENTION, COUNT(DISTINCT file)
FROM {{ ref('fct_price') }}
GROUP BY ALL
HAVING COUNT(DISTINCT file) > 1
