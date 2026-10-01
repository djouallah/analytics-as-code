-- Grain check: the merge key of fct_regionsum_today should be unique. Warn-only, for the
-- same reason as assert_fct_price_today_grain: a file logged twice can be read twice in one
-- batch, and the dashboard export collapses identical copies with ANY_VALUE.
{{ config(severity='warn') }}
SELECT file, REGIONID, SETTLEMENTDATE, INTERVENTION, COUNT(*) AS n
FROM {{ ref('fct_regionsum_today') }}
GROUP BY ALL
HAVING COUNT(*) > 1
