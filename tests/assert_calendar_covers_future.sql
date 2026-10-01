-- dim_calendar must run ahead of the data: the dashboard inner-joins every fact to it,
-- so a calendar that stops (it was hard-coded to end on 2026-12-31) silently hides
-- every row after its last date.
SELECT max(date) AS last_date
FROM {{ ref('dim_calendar') }}
HAVING max(date) < current_date + INTERVAL 90 DAY
