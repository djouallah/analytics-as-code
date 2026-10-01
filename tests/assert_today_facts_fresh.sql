-- The intraday facts must keep up: AEMO publishes every 5 minutes and process_data runs
-- every 30, so a newest interval more than 2 hours old means loading has stalled without
-- failing (e.g. a pre-hook that keeps finding no files). SETTLEMENTDATE is AEST wall clock
-- labelled UTC, so timezone('UTC', ...) reads the wall clock back and "now" is Brisbane's.
-- Skipped on the ci target, whose in-memory facts hold whatever one build downloaded.
{% if target.name == 'ci' %}
SELECT NULL AS model WHERE FALSE
{% else %}
WITH latest AS (
  SELECT 'fct_scada_today' AS model, timezone('UTC', max(SETTLEMENTDATE)) AS newest
  FROM {{ ref('fct_scada_today') }}
  UNION ALL
  SELECT 'fct_price_today', timezone('UTC', max(SETTLEMENTDATE))
  FROM {{ ref('fct_price_today') }}
)
SELECT model, newest
FROM latest
WHERE newest IS NULL
   OR newest < timezone('Australia/Brisbane', now()) - INTERVAL 2 HOUR
{% endif %}
