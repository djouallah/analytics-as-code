-- dim_calendar must run ahead of the data: the semantic model filters every fact by date
-- through it, so a calendar that stops (it was hard-coded to end on 2026-12-31) silently
-- hides every row after its last date from a date filter.
SELECT max(date) AS last_date
FROM {{ ref('dim_calendar') }}
HAVING max(date) < current_date + INTERVAL 90 DAY
