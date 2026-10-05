-- Flow on each link between regions, per 5 minutes, back to 2018. For Power BI; the rules
-- are the ones scripts/cache_catalog.py applied in _export_interconnector: the pricing run,
-- one row per interval (fct_interconnector_today holds August 2026 from two sources), and
-- mw is the dispatch target MWFLOW, not the metered flow. It is positive from the first
-- region in the id to the second (T-V-MNSP1 > 0: Tasmania to Victoria); the two limits bound
-- it in the same sign.
--
-- Insert-only merge on the grain: a missing interval is added, a stored value is not
-- revised; rebuild=fct_interconnector resets it. Small (7 links), so every run recomputes
-- all of it and the merge adds what is missing.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['interconnector', 'date', 'time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    tags=['powerbi']
) }}

SELECT
  INTERCONNECTORID AS interconnector,
  MAX(DATE) AS date,
  CAST(strftime(SETTLEMENTDATE, '%H%M') AS INT) AS time,
  CAST(MAX(MWFLOW) AS DECIMAL(18, 4)) AS mw,
  CAST(MAX(EXPORTLIMIT) AS DECIMAL(18, 4)) AS export_limit,
  CAST(MAX(IMPORTLIMIT) AS DECIMAL(18, 4)) AS import_limit
FROM {{ ref('fct_interconnector_today') }}
WHERE INTERVENTION = 0
GROUP BY INTERCONNECTORID, SETTLEMENTDATE
