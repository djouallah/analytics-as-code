-- stg_csv_archive_log appends only the rows its target is missing (anti-join on these three
-- columns), so each should appear once. Warn-only: duplicates are tolerated downstream (the
-- fact pre-hooks SELECT DISTINCT), but a growing count means the anti-join stopped working,
-- which is how the table grew by its own size every run until 2026-09-18.
{{ config(severity='warn') }}
SELECT source_type, source_filename, csv_filename, COUNT(*) AS n
FROM {{ ref('stg_csv_archive_log') }}
GROUP BY ALL
HAVING COUNT(*) > 1
