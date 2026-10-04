-- Grain check: the merge key of fct_rooftop_pv should be unique. A weekly archive is several
-- hundred one-interval files joined into one, so an interval AEMO republished within the week
-- would be in it twice and MERGE (which only dedupes against the target) would insert both.
-- Warn-only: the export takes one row per interval with arg_max anyway.
{{ config(severity='warn') }}
SELECT file, REGIONID, INTERVAL_DATETIME, TYPE, COUNT(*) AS n
FROM {{ ref('fct_rooftop_pv') }}
GROUP BY ALL
HAVING COUNT(*) > 1
