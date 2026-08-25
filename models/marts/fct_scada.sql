-- Insert-only merge (WHEN MATCHED THEN DO NOTHING): every commit stays a single
-- append snapshot -- the OneLake catalog rejects commits that mix delete files and
-- data files (BadRequest 400) -- while re-processed files dedupe on the unique_key
-- instead of double-inserting.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    unique_key=['file', 'DUID', 'SETTLEMENTDATE','INTERVENTION'],
    pre_hook="SET VARIABLE scada_daily_paths = (SELECT COALESCE(NULLIF(list('{{ get_csv_archive_path() }}' || archive_path), []), ['']) FROM (SELECT archive_path FROM {{ ref('stg_csv_archive_log') }} WHERE source_type = 'daily'{% if is_incremental() %} AND csv_filename NOT IN (SELECT DISTINCT file FROM {{ this }}){% endif %} LIMIT {{ env_var('process_limit', '1000') }}))"
) }}

{%- set check_files_query -%}
SELECT COUNT(*) as cnt FROM {{ ref('stg_csv_archive_log') }}
WHERE source_type = 'daily'
{%- if is_incremental() %}
AND csv_filename NOT IN (SELECT DISTINCT file FROM {{ this }})
{%- endif -%}
{%- endset -%}

{%- if execute and flags.WHICH in ('run', 'build', 'retry') -%}
  {%- set files_result = run_query(check_files_query) -%}
  {%- set has_files = files_result and files_result.rows[0][0] > 0 -%}
{%- else -%}
  {%- set has_files = true -%}
{%- endif -%}

{% if has_files %}
{# The CSV layout in file order â€” single source of truth: the read_csv
   columns spec and the CAST select are both generated from this list. #}
{%- set csv_cols = [
    'I', 'UNIT', 'XX', 'VERSION',
    'SETTLEMENTDATE', 'RUNNO', 'DUID', 'INTERVENTION',
    'DISPATCHMODE', 'AGCSTATUS', 'INITIALMW', 'TOTALCLEARED',
    'RAMPDOWNRATE', 'RAMPUPRATE', 'LOWER5MIN', 'LOWER60SEC',
    'LOWER6SEC', 'RAISE5MIN', 'RAISE60SEC', 'RAISE6SEC',
    'MARGINAL5MINVALUE', 'MARGINAL60SECVALUE', 'MARGINAL6SECVALUE', 'MARGINALVALUE',
    'VIOLATION5MINDEGREE', 'VIOLATION60SECDEGREE', 'VIOLATION6SECDEGREE', 'VIOLATIONDEGREE',
    'LOWERREG', 'RAISEREG', 'AVAILABILITY', 'RAISE6SECFLAGS',
    'RAISE60SECFLAGS', 'RAISE5MINFLAGS', 'RAISEREGFLAGS', 'LOWER6SECFLAGS',
    'LOWER60SECFLAGS', 'LOWER5MINFLAGS', 'LOWERREGFLAGS', 'RAISEREGAVAILABILITY',
    'RAISEREGENABLEMENTMAX', 'RAISEREGENABLEMENTMIN', 'LOWERREGAVAILABILITY', 'LOWERREGENABLEMENTMAX',
    'LOWERREGENABLEMENTMIN', 'RAISE6SECACTUALAVAILABILITY', 'RAISE60SECACTUALAVAILABILITY', 'RAISE5MINACTUALAVAILABILITY',
    'RAISEREGACTUALAVAILABILITY', 'LOWER6SECACTUALAVAILABILITY', 'LOWER60SECACTUALAVAILABILITY', 'LOWER5MINACTUALAVAILABILITY',
    'LOWERREGACTUALAVAILABILITY'
] -%}
{# Kept raw or handled in the tail instead of CAST(... AS DOUBLE) #}
{%- set not_double = ['I', 'UNIT', 'XX', 'SETTLEMENTDATE', 'DUID'] -%}
WITH scada_staging AS (
  SELECT *
  FROM read_csv(
    getvariable('scada_daily_paths'),
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
  WHERE I = 'D' AND UNIT = 'DUNIT' AND VERSION = '3'
)

SELECT
  UNIT,
  DUID,
  {%- for name in csv_cols if name not in not_double %}
  CAST({{ name }} AS DOUBLE) AS {{ name }},
  {%- endfor %}
  {{ parse_filename('filename') }} AS file,
  CAST(SETTLEMENTDATE AS TIMESTAMPTZ) AS SETTLEMENTDATE,
  CAST(SETTLEMENTDATE AS DATE) AS DATE,
  CAST(YEAR(CAST(SETTLEMENTDATE AS TIMESTAMP)) AS INT) AS YEAR
FROM scada_staging
{% else %}
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
