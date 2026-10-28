-- Test: All downloaded daily files should be processed in fct_price
-- Returns rows where a downloaded file is missing from fct_price
--
-- NOT EXISTS, not NOT IN: a single NULL `file` in the fact table would make a NOT IN
-- predicate evaluate to NULL for every row and turn this test permanently green.
-- DISTINCT because the log is append-only and can hold the same marker twice.
-- The fact is reduced to its distinct files first: anti-joined whole, its every row went into
-- the join's hash table, and fct_scada's ran the runner out of memory (killed, "shutdown
-- signal", every night from 2026-10-21).

SELECT DISTINCT
  l.csv_filename
FROM {{ ref('stg_csv_archive_log') }} l
WHERE l.source_type = 'daily'
  AND NOT EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT file FROM {{ ref('fct_price') }}) f
    WHERE f.file = l.csv_filename
  )
