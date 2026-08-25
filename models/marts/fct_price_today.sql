-- Insert-only merge (WHEN MATCHED THEN DO NOTHING): every commit stays a single
-- append snapshot -- the OneLake catalog rejects commits that mix delete files and
-- data files (BadRequest 400) -- while re-processed files dedupe on the unique_key
-- instead of double-inserting.
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    unique_key=['file', 'REGIONID', 'SETTLEMENTDATE','INTERVENTION'],
    pre_hook="SET VARIABLE price_today_paths = (SELECT COALESCE(NULLIF(list('{{ get_csv_archive_path() }}' || archive_path), []), ['']) FROM (SELECT archive_path FROM {{ ref('stg_csv_archive_log') }} WHERE source_type = 'price_today'{% if is_incremental() %} AND csv_filename NOT IN (SELECT DISTINCT file FROM {{ this }}){% endif %} LIMIT {{ env_var('process_limit', '1000') }}))"
) }}

{% set csv_archive_path = get_csv_archive_path() %}

{%- set check_files_query -%}
SELECT COUNT(*) as cnt FROM {{ ref('stg_csv_archive_log') }}
WHERE source_type = 'price_today'
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
    ('I', 'VARCHAR'), ('DISPATCH', 'VARCHAR'),
    ('PRICE', 'VARCHAR'), ('xx', 'VARCHAR'),
    ('SETTLEMENTDATE', 'timestamp'), ('RUNNO', 'VARCHAR'),
    ('REGIONID', 'VARCHAR'), ('DISPATCHINTERVAL', 'VARCHAR'),
    ('INTERVENTION', 'VARCHAR'), ('RRP', 'VARCHAR'),
    ('EEP', 'VARCHAR'), ('ROP', 'VARCHAR'),
    ('APCFLAG', 'VARCHAR'), ('MARKETSUSPENDEDFLAG', 'VARCHAR'),
    ('LASTCHANGED', 'VARCHAR'), ('RAISE6SECRRP', 'VARCHAR'),
    ('RAISE6SECROP', 'VARCHAR'), ('RAISE6SECAPCFLAG', 'VARCHAR'),
    ('RAISE60SECRRP', 'VARCHAR'), ('RAISE60SECROP', 'VARCHAR'),
    ('RAISE60SECAPCFLAG', 'VARCHAR'), ('RAISE5MINRRP', 'VARCHAR'),
    ('RAISE5MINROP', 'VARCHAR'), ('RAISE5MINAPCFLAG', 'VARCHAR'),
    ('RAISEREGRRP', 'VARCHAR'), ('RAISEREGROP', 'VARCHAR'),
    ('RAISEREGAPCFLAG', 'VARCHAR'), ('LOWER6SECRRP', 'VARCHAR'),
    ('LOWER6SECROP', 'VARCHAR'), ('LOWER6SECAPCFLAG', 'VARCHAR'),
    ('LOWER60SECRRP', 'VARCHAR'), ('LOWER60SECROP', 'VARCHAR'),
    ('LOWER60SECAPCFLAG', 'VARCHAR'), ('LOWER5MINRRP', 'VARCHAR'),
    ('LOWER5MINROP', 'VARCHAR'), ('LOWER5MINAPCFLAG', 'VARCHAR'),
    ('LOWERREGRRP', 'VARCHAR'), ('LOWERREGROP', 'VARCHAR'),
    ('LOWERREGAPCFLAG', 'VARCHAR'), ('PRICE_STATUS', 'VARCHAR'),
    ('PRE_AP_ENERGY_PRICE', 'VARCHAR'), ('PRE_AP_RAISE6_PRICE', 'VARCHAR'),
    ('PRE_AP_RAISE60_PRICE', 'VARCHAR'), ('PRE_AP_RAISE5MIN_PRICE', 'VARCHAR'),
    ('PRE_AP_RAISEREG_PRICE', 'VARCHAR'), ('PRE_AP_LOWER6_PRICE', 'VARCHAR'),
    ('PRE_AP_LOWER60_PRICE', 'VARCHAR'), ('PRE_AP_LOWER5MIN_PRICE', 'VARCHAR'),
    ('PRE_AP_LOWERREG_PRICE', 'VARCHAR'), ('RAISE1SECRRP', 'VARCHAR'),
    ('RAISE1SECROP', 'VARCHAR'), ('RAISE1SECAPCFLAG', 'VARCHAR'),
    ('LOWER1SECRRP', 'VARCHAR'), ('LOWER1SECROP', 'VARCHAR'),
    ('LOWER1SECAPCFLAG', 'VARCHAR'), ('PRE_AP_RAISE1_PRICE', 'VARCHAR'),
    ('PRE_AP_LOWER1_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_ENERGY_PRICE', 'VARCHAR'),
    ('CUMUL_PRE_AP_RAISE6_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_RAISE60_PRICE', 'VARCHAR'),
    ('CUMUL_PRE_AP_RAISE5MIN_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_RAISEREG_PRICE', 'VARCHAR'),
    ('CUMUL_PRE_AP_LOWER6_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_LOWER60_PRICE', 'VARCHAR'),
    ('CUMUL_PRE_AP_LOWER5MIN_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_LOWERREG_PRICE', 'VARCHAR'),
    ('CUMUL_PRE_AP_RAISE1_PRICE', 'VARCHAR'), ('CUMUL_PRE_AP_LOWER1_PRICE', 'VARCHAR'),
    ('OCD_STATUS', 'VARCHAR'), ('MII_STATUS', 'VARCHAR')
] -%}
{# Kept raw or handled in the tail instead of CAST(... AS DOUBLE) #}
{%- set not_double = ['I', 'DISPATCH', 'PRICE', 'xx', 'SETTLEMENTDATE', 'REGIONID', 'LASTCHANGED', 'PRICE_STATUS', 'OCD_STATUS', 'MII_STATUS'] -%}
WITH price_staging AS (
  SELECT *
  FROM read_csv(
    getvariable('price_today_paths'),
    skip = 1,
    header = 0,
    all_varchar = 1,
    columns = {
      {%- for name, type in csv_cols %}
      '{{ name }}': '{{ type }}'{{ "," if not loop.last }}
      {%- endfor %}
    },
    filename = 1,
    null_padding = true,
    ignore_errors = 1,
    auto_detect = false,
    hive_partitioning = false
  )
  WHERE I = 'D' AND PRICE = 'PRICE'
)

SELECT
  REGIONID,
  {%- for name, type in csv_cols if name not in not_double %}
  CAST({{ name }} AS DOUBLE) AS {{ name }},
  {%- endfor %}
  CAST(SETTLEMENTDATE AS TIMESTAMPTZ) AS SETTLEMENTDATE,
  CAST(SETTLEMENTDATE AS DATE) AS DATE,
  {{ parse_filename('filename') }} AS file,
  CAST(YEAR(SETTLEMENTDATE) AS INT) AS YEAR
FROM price_staging
{% else %}
-- No unprocessed files: empty result keeps existing data untouched
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
