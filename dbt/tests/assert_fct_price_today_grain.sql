-- Grain check: the merge key of fct_price_today should be unique. Warn-only: a file
-- logged twice in stg_csv_archive_log (overlapping runs race the append-only log) gets
-- read twice in one batch, and MERGE dedupes against committed data, not the batch
-- itself — so identical-copy dupes are possible. Downstream is safe: the mart models
-- (fct_summary, fct_region) take one row per key, which collapses them.
{{ config(severity='warn') }}
SELECT file, REGIONID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_price_today') }}
GROUP BY ALL
HAVING COUNT(*) > 1
