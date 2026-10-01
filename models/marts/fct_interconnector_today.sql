-- Interconnector flows and limits, every 5 minutes, from the INTERCONNECTORRES rows of the
-- DispatchIS files that fct_price_today already downloads and archives (source_type
-- 'price_today'). No new download: added 2026-10-01, it fills itself from the archive, which
-- goes back to 2026-08, newest files first (macros/pending_archive_files.sql).
--
-- MWFLOW is the dispatch target and is positive from the first region in INTERCONNECTORID to
-- the second (e.g. T-V-MNSP1 > 0 means Tasmania exporting to Victoria). EXPORTLIMIT and
-- IMPORTLIMIT bound it in the same sign convention.
--
-- Insert-only merge, same reasons as the other facts (see fct_price_today.sql).
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    unique_key=['file', 'INTERCONNECTORID', 'SETTLEMENTDATE', 'INTERVENTION'],
    pre_hook="{{ set_pending_archive_paths('interconnector_today_paths', ref('stg_csv_archive_log'), 'price_today') }}"
) }}

{%- set check_files_query -%}
{{ pending_archive_count(ref('stg_csv_archive_log'), 'price_today') }}
{%- endset -%}

{%- if execute and flags.WHICH in ('run', 'build', 'retry') -%}
  {%- set files_result = run_query(check_files_query) -%}
  {%- set has_files = files_result and files_result.rows[0][0] > 0 -%}
{%- else -%}
  {%- set has_files = true -%}
{%- endif -%}

{% if has_files %}
{# The INTERCONNECTORRES record layout in file order (version 3). Read positionally: the
   file mixes record types of different widths, rows wider than this are skipped by
   ignore_errors and the WHERE keeps only this record. #}
{%- set csv_cols = [
    'I', 'DISPATCH', 'REC', 'xx', 'SETTLEMENTDATE', 'RUNNO', 'INTERCONNECTORID',
    'DISPATCHINTERVAL', 'INTERVENTION', 'METEREDMWFLOW', 'MWFLOW', 'MWLOSSES',
    'MARGINALVALUE', 'VIOLATIONDEGREE', 'LASTCHANGED', 'EXPORTLIMIT', 'IMPORTLIMIT',
    'MARGINALLOSS', 'EXPORTGENCONID', 'IMPORTGENCONID', 'FCASEXPORTLIMIT', 'FCASIMPORTLIMIT',
    'LOCAL_PRICE_ADJUSTMENT_EXPORT', 'LOCALLY_CONSTRAINED_EXPORT',
    'LOCAL_PRICE_ADJUSTMENT_IMPORT', 'LOCALLY_CONSTRAINED_IMPORT'
] -%}
{%- set numeric = ['INTERVENTION', 'METEREDMWFLOW', 'MWFLOW', 'MWLOSSES', 'MARGINALVALUE',
    'VIOLATIONDEGREE', 'EXPORTLIMIT', 'IMPORTLIMIT', 'MARGINALLOSS'] -%}
WITH interconnector_staging AS (
  SELECT *
  FROM read_csv(
    getvariable('interconnector_today_paths'),
    skip = 1,
    header = 0,
    all_varchar = 1,
    columns = {
      {%- for name in csv_cols %}
      '{{ name }}': 'VARCHAR'{{ "," if not loop.last }}
      {%- endfor %}
    },
    filename = 1,
    null_padding = true,
    ignore_errors = 1,
    auto_detect = false,
    hive_partitioning = false
  )
  WHERE I = 'D' AND REC = 'INTERCONNECTORRES'
)

SELECT
  INTERCONNECTORID,
  {%- for name in numeric %}
  CAST({{ name }} AS DOUBLE) AS {{ name }},
  {%- endfor %}
  EXPORTGENCONID,
  IMPORTGENCONID,
  CAST(SETTLEMENTDATE AS TIMESTAMPTZ) AS SETTLEMENTDATE,
  CAST(SETTLEMENTDATE AS DATE) AS DATE,
  {{ parse_filename('filename') }} AS file,
  CAST(YEAR(CAST(SETTLEMENTDATE AS TIMESTAMP)) AS INT) AS YEAR
FROM interconnector_staging
{% else %}
-- No unprocessed files: empty result keeps existing data untouched
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
