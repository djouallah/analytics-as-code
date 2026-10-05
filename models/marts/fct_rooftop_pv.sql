-- Rooftop solar: AEMO's estimate of each region's rooftop PV output (MW at the end of every
-- half hour), from the ROOFTOP_PV_ACTUAL record. It is an estimate, not a meter reading,
-- and it is kept here exactly as published: half-hourly, every estimate type the files
-- carry (MEASUREMENT, SATELLITE, DAILY), the sub-regions of the older files included.
-- fct_rooftop takes MEASUREMENT for the five regions from it; the 5-minute values a chart
-- draws are worked out by the reader, never stored.
--
-- Three sources (macros/pending_archive_files.sql): the current folder ('rooftop_today',
-- one file per half hour), the monthly MMSDM archive 2018-01 to 2026-08 ('rooftop_monthly')
-- and the weekly archives after it ('rooftop_weekly'). They overlap, so an interval can be
-- here under more than one `file`: readers take one (ANY_VALUE ... GROUP BY).
--
-- AEMO's data model 5.6 report (2025-10) says this record is to be removed in a later
-- release in favour of ROOFTOP_PV_ACTUAL_PRED/_RUN; neither was published on 2026-10-02.
--
-- Insert-only merge, same reasons as the other facts (see fct_price_today.sql).
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    unique_key=['file', 'REGIONID', 'INTERVAL_DATETIME', 'TYPE'],
    pre_hook="{{ set_pending_archive_paths('rooftop_pv_paths', ref('stg_csv_archive_log'), ['rooftop_today', 'rooftop_weekly', 'rooftop_monthly']) }}"
) }}

{%- set check_files_query -%}
{{ pending_archive_count(ref('stg_csv_archive_log'), ['rooftop_today', 'rooftop_weekly', 'rooftop_monthly']) }}
{%- endset -%}

{%- if execute and flags.WHICH in ('run', 'build', 'retry') -%}
  {%- set files_result = run_query(check_files_query) -%}
  {%- set has_files = files_result and files_result.rows[0][0] > 0 -%}
{%- else -%}
  {%- set has_files = true -%}
{%- endif -%}

{% if has_files %}
{# The last three columns come in two orders: QI, TYPE, LASTCHANGED in the current, weekly
   and older monthly files, and LASTCHANGED, TYPE, QI in the monthly files from 2024-08.
   Each file's I row says which, so columns 8 and 10 are read as text and assigned from it.
   strict_mode = false for the same monthly files as fct_interconnector_today. #}
WITH rooftop_staging AS (
  SELECT *
  FROM read_csv(
    {{ source('aemo', 'rooftop_pv_actual') }},
    skip = 1,
    header = 0,
    all_varchar = 1,
    columns = {
      'I': 'VARCHAR', 'ROOFTOP': 'VARCHAR', 'REC': 'VARCHAR', 'VERSION': 'VARCHAR',
      'INTERVAL_DATETIME': 'VARCHAR', 'REGIONID': 'VARCHAR', 'POWER': 'VARCHAR',
      'col8': 'VARCHAR', 'TYPE': 'VARCHAR', 'col10': 'VARCHAR'
    },
    filename = 1,
    null_padding = true,
    ignore_errors = 1,
    strict_mode = false,
    auto_detect = false,
    hive_partitioning = false
  )
  WHERE REC = 'ACTUAL'
),

layout AS (
  SELECT filename, bool_or(col8 = 'QI') AS qi_first
  FROM rooftop_staging
  WHERE I = 'I'
  GROUP BY filename
)

SELECT
  r.REGIONID,
  TRY_CAST(r.POWER AS DOUBLE) AS POWER,
  TRY_CAST(CASE WHEN l.qi_first THEN r.col8 ELSE r.col10 END AS DOUBLE) AS QI,
  r.TYPE,
  TRY_CAST(CASE WHEN l.qi_first THEN r.col10 ELSE r.col8 END AS TIMESTAMPTZ) AS LASTCHANGED,
  CAST(r.INTERVAL_DATETIME AS TIMESTAMPTZ) AS INTERVAL_DATETIME,
  CAST(r.INTERVAL_DATETIME AS DATE) AS DATE,
  {{ parse_filename('r.filename') }} AS file,
  CAST(YEAR(CAST(r.INTERVAL_DATETIME AS TIMESTAMP)) AS INT) AS YEAR
FROM rooftop_staging r
JOIN layout l ON l.filename = r.filename
WHERE r.I = 'D'
{% else %}
-- No unprocessed files: empty result keeps existing data untouched
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
