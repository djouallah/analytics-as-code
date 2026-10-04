-- Test: every archived DispatchIS file should have REGIONSUM rows in fct_regionsum_today.
-- Returns the files the log has and the fact doesn't. A file that is there but yields no row
-- (e.g. AEMO moves REGIONSUM off version 9) shows here too: the pre-hook would re-read it
-- every run without ever loading it.
--
-- NOT EXISTS, not NOT IN: a single NULL `file` would turn NOT IN permanently green.

SELECT DISTINCT
  l.csv_filename
FROM {{ ref('stg_csv_archive_log') }} l
WHERE l.source_type = 'price_today'
  AND NOT EXISTS (
    SELECT 1
    FROM {{ ref('fct_regionsum_today') }} f
    WHERE f.file = l.csv_filename
  )
