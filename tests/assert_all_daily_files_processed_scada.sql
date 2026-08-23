-- Test: All downloaded daily files should be processed in fct_scada
-- Returns rows where a downloaded file is missing from fct_scada
--
-- NOT EXISTS, not NOT IN: a single NULL `file` in the fact table would make a NOT IN
-- predicate evaluate to NULL for every row and turn this test permanently green.
-- DISTINCT because the log is append-only and can hold the same marker twice.

SELECT DISTINCT
  l.csv_filename
FROM {{ ref('stg_csv_archive_log') }} l
WHERE l.source_type = 'daily'
  AND NOT EXISTS (
    SELECT 1
    FROM {{ ref('fct_scada') }} f
    WHERE f.file = l.csv_filename
  )
