-- A NULL price means the SCADA-to-price join through dim_duid's region broke: the unit's
-- region matched no REGIONID in the price data. Cheap, so it runs untagged everywhere.
SELECT date, DUID, mw
FROM {{ ref('fct_summary') }}
WHERE price IS NULL
LIMIT 10
