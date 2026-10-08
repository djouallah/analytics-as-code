-- Flow on each link between regions, per 5 minutes, back to 2018. The rules: the pricing run,
-- one row per interval (fct_interconnector_today holds August 2026 from two sources), and
-- mw is the dispatch target MWFLOW, not the metered flow. It is positive from the first
-- region in the id to the second (T-V-MNSP1 > 0: Tasmania to Victoria); the two limits bound
-- it in the same sign.
--
-- Insert-only merge on the grain: a missing interval is added, a stored value is not
-- revised; rebuild=fct_interconnector resets it. An incremental run recomputes the days of
-- the files fct_interconnector_today loaded since it last committed (pending_file_ranges,
-- macros/pending_archive_files.sql); no new file, nothing sent.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['interconnector', 'date', 'time'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    schema='mart',
    post_hook={"sql": "{{ record_mart_watermark(['fct_interconnector_today']) }}", "transaction": false},
    tags=['powerbi']
) }}

{%- set ranges = pending_file_ranges(['fct_interconnector_today']) if is_incremental() else [(none, none)] %}

{% if not ranges %}
{{ nothing_to_do() }}
{% else %}
SELECT
  INTERCONNECTORID AS interconnector,
  MAX(DATE) AS date,
  CAST(strftime(SETTLEMENTDATE, '%H%M') AS INT) AS time,
  CAST(MAX(MWFLOW) AS DECIMAL(18, 4)) AS mw,
  CAST(MAX(EXPORTLIMIT) AS DECIMAL(18, 4)) AS export_limit,
  CAST(MAX(IMPORTLIMIT) AS DECIMAL(18, 4)) AS import_limit
FROM {{ ref('fct_interconnector_today') }}
WHERE INTERVENTION = 0
  AND {{ date_ranges_sql(ranges, 'DATE') }}
GROUP BY INTERCONNECTORID, SETTLEMENTDATE
{% endif %}
