-- Grain check: the merge key of fct_interconnector_today should be unique. Warn-only, for the
-- same reason as assert_fct_price_today_grain: a file logged twice can be read twice in one
-- batch, and fct_interconnector takes one row per interval, which collapses identical copies.
{{ config(severity='warn') }}
SELECT file, INTERCONNECTORID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_interconnector_today') }}
GROUP BY ALL
HAVING COUNT(*) > 1
