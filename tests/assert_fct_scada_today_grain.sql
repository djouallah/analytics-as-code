-- Grain check: the merge key of fct_scada_today should be unique. Warn-only: a file
-- logged twice in stg_csv_archive_log (overlapping runs race the append-only log) gets
-- read twice in one batch, and MERGE dedupes against committed data, not the batch
-- itself — so identical-copy dupes are possible. Downstream is safe: fct_summary
-- aggregates with GROUP BY + MAX, which collapses identical copies.
{{ config(severity='warn') }}
SELECT file, DUID, SETTLEMENTDATE, COUNT(*) AS n
FROM {{ ref('fct_scada_today') }}
GROUP BY ALL
HAVING COUNT(*) > 1
