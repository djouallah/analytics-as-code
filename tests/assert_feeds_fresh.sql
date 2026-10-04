-- Every feed must keep up, not only the two the dashboard reads first
-- (assert_today_facts_fresh). A download that stalls without failing leaves the
-- files-processed tests green: they only compare against what was logged.
--   - next-day files (fct_scada, fct_price): AEMO publishes one a day, early morning; the
--     newest DATE more than 3 days old means the daily feed has stopped
--   - DispatchIS rows (regionsum, interconnector): every 5 minutes, like the price feed
--   - rooftop: half-hourly, landing 30-60 minutes late, so 3 hours
-- SETTLEMENTDATE / INTERVAL_DATETIME are AEST wall clock labelled UTC: timezone('UTC', ...)
-- reads the wall clock back, and "now" is Brisbane's. DATE is the AEST date already.
-- Skipped on the ci target, whose facts hold whatever one build downloaded.
{% if target.name == 'ci' %}
SELECT NULL AS feed WHERE FALSE
{% else %}
WITH now_aest AS (SELECT timezone('Australia/Brisbane', now()) AS t),
latest AS (
  SELECT 'fct_scada' AS feed, CAST(max(DATE) AS TIMESTAMP) AS newest, INTERVAL 3 DAY AS allowed
  FROM {{ ref('fct_scada') }}
  UNION ALL
  SELECT 'fct_price', CAST(max(DATE) AS TIMESTAMP), INTERVAL 3 DAY
  FROM {{ ref('fct_price') }}
  UNION ALL
  SELECT 'fct_regionsum_today', timezone('UTC', max(SETTLEMENTDATE)), INTERVAL 2 HOUR
  FROM {{ ref('fct_regionsum_today') }}
  UNION ALL
  SELECT 'fct_interconnector_today', timezone('UTC', max(SETTLEMENTDATE)), INTERVAL 2 HOUR
  FROM {{ ref('fct_interconnector_today') }}
  UNION ALL
  SELECT 'fct_rooftop_pv', timezone('UTC', max(INTERVAL_DATETIME)), INTERVAL 3 HOUR
  FROM {{ ref('fct_rooftop_pv') }}
  WHERE TYPE = 'MEASUREMENT'
)
SELECT feed, newest
FROM latest, now_aest
WHERE newest IS NULL
   OR newest < now_aest.t - allowed
{% endif %}
