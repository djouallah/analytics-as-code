-- depends_on: {{ ref('stg_csv_archive_log') }}

{{ config(
    materialized='incremental',
    unique_key=['file', 'DUID', 'SETTLEMENTDATE'],
    incremental_strategy='delete+insert',
    pre_hook="SET VARIABLE scada_today_paths = (SELECT COALESCE(NULLIF(list(file), []), ['']) FROM glob('{{ get_csv_archive_path() }}/scada_today/*.gz'))"
) }}

{%- set check_files_query -%}
SELECT COUNT(*) as cnt FROM glob('{{ get_csv_archive_path() }}/scada_today/*.gz')
{%- endset -%}

{%- set files_result = run_query(check_files_query) -%}
{%- set has_files = files_result and files_result.rows[0][0] > 0 -%}

{% if has_files %}
WITH scada_staging AS (
  SELECT *
  FROM read_csv(
    getvariable('scada_today_paths'),
    skip = 1,
    header = 0,
    all_varchar = 1,
    columns = {
      'I': 'VARCHAR',
      'DISPATCH': 'VARCHAR',
      'UNIT_SCADA': 'VARCHAR',
      'xx': 'VARCHAR',
      'SETTLEMENTDATE': 'timestamp',
      'DUID': 'VARCHAR',
      'SCADAVALUE': 'double',
      'LASTCHANGED': 'timestamp'
    },
    filename = 1,
    null_padding = true,
    ignore_errors = 1,
    auto_detect = false,
    hive_partitioning = false
  )
  WHERE I = 'D' AND SCADAVALUE != 0
)

SELECT
  DUID,
  SCADAVALUE AS INITIALMW,
  {{ parse_filename('filename') }} AS file,
  SETTLEMENTDATE,
  LASTCHANGED,
  CAST(SETTLEMENTDATE AS DATE) AS DATE,
  CAST(YEAR(SETTLEMENTDATE) AS INT) AS YEAR
FROM scada_staging
{% else %}
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
