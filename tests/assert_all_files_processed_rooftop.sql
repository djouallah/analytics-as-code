-- Test: every archived rooftop file (current folder, weekly and monthly archives) should have
-- rows in fct_rooftop_pv. Returns the files the log has and the fact doesn't. The model joins
-- each file to its own I row to tell the column order, so a file without one loads nothing
-- and shows here.
--
-- NOT EXISTS, not NOT IN: a single NULL `file` would turn NOT IN permanently green.

SELECT DISTINCT
  l.source_type,
  l.csv_filename
FROM {{ ref('stg_csv_archive_log') }} l
WHERE l.source_type IN ('rooftop_today', 'rooftop_weekly', 'rooftop_monthly')
  AND NOT EXISTS (
    SELECT 1
    FROM {{ ref('fct_rooftop_pv') }} f
    WHERE f.file = l.csv_filename
  )
