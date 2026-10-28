-- `file` is part of every merge key, so the grain tests only catch one file read twice. The
-- same interval from two different files (a next-day file present under two publish stamps,
-- the GitHub backfill and AEMO's folder both supplying a day) would be two rows that no test
-- sees. The mart models take one row per key, which collapses them, but a reader of the
-- landing tables would double-count. Returns the keys found in more than one file.
-- Warn-only: what to do about it (dedupe in the model, or accept) is a decision, not a bug fix.
{{ config(severity='warn') }}
-- fct_scada over the last 14 days only: whole, it needs more memory and spill disk than a
-- runner has (see assert_fct_scada_grain); an interval only reaches a second file with a load.
SELECT 'fct_scada' AS model, DUID AS id, SETTLEMENTDATE, INTERVENTION, COUNT(DISTINCT file) AS files
FROM {{ ref('fct_scada') }}
WHERE DATE >= current_date - 14
GROUP BY ALL
HAVING COUNT(DISTINCT file) > 1
UNION ALL
SELECT 'fct_price', REGIONID, SETTLEMENTDATE, INTERVENTION, COUNT(DISTINCT file)
FROM {{ ref('fct_price') }}
GROUP BY ALL
HAVING COUNT(DISTINCT file) > 1
