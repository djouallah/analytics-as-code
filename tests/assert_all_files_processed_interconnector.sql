-- Test: every archived DispatchIS file and every monthly INTERCONNECTORRES archive should
-- have rows in fct_interconnector_today. Returns the files the log has and the fact doesn't,
-- including any that yield no row and so stay pending forever.
--
-- NOT EXISTS, not NOT IN: a single NULL `file` would turn NOT IN permanently green.

SELECT DISTINCT
  l.source_type,
  l.csv_filename
FROM {{ ref('stg_csv_archive_log') }} l
WHERE l.source_type IN ('price_today', 'interconnector_monthly')
  AND NOT EXISTS (
    SELECT 1
    FROM {{ ref('fct_interconnector_today') }} f
    WHERE f.file = l.csv_filename
  )
