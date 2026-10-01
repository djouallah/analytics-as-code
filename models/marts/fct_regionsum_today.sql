-- Regional demand, net interchange and supply every 5 minutes, from the REGIONSUM rows of the
-- DispatchIS files that fct_price_today already downloads and archives (source_type
-- 'price_today'). No new download: added 2026-10-01, it fills itself from the archive, which
-- goes back to 2026-08, newest files first (macros/pending_archive_files.sql). It is the
-- intraday counterpart of the TOTALDEMAND/NETINTERCHANGE columns fct_price reads from the
-- DREGION rows of the next-day files.
--
-- NETINTERCHANGE is positive when the region exports (TOTALDEMAND = DISPATCHABLEGENERATION
-- - NETINTERCHANGE - DISPATCHABLELOAD). TOTALDEMAND is operational demand: rooftop solar
-- is not in it.
--
-- Insert-only merge, same reasons as the other facts (see fct_price_today.sql).
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    unique_key=['file', 'REGIONID', 'SETTLEMENTDATE', 'INTERVENTION'],
    pre_hook="{{ set_pending_archive_paths('regionsum_today_paths', ref('stg_csv_archive_log'), 'price_today') }}"
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
{# The REGIONSUM record layout in file order (version 9, the same in the 2026-08 archive and
   in today's files). Read positionally: the file mixes record types of different widths,
   rows wider than this are skipped by ignore_errors and the WHERE keeps only this record
   at this version. AGGEGATEDISPATCHERROR is AEMO's spelling, next to the corrected column. #}
{%- set csv_cols = [
    'I', 'DISPATCH', 'REC', 'xx',
    'SETTLEMENTDATE', 'RUNNO', 'REGIONID', 'DISPATCHINTERVAL', 'INTERVENTION', 'TOTALDEMAND',
    'AVAILABLEGENERATION', 'AVAILABLELOAD', 'DEMANDFORECAST', 'DISPATCHABLEGENERATION',
    'DISPATCHABLELOAD', 'NETINTERCHANGE', 'EXCESSGENERATION', 'LOWER5MINDISPATCH',
    'LOWER5MINIMPORT', 'LOWER5MINLOCALDISPATCH', 'LOWER5MINLOCALPRICE', 'LOWER5MINLOCALREQ',
    'LOWER5MINPRICE', 'LOWER5MINREQ', 'LOWER5MINSUPPLYPRICE', 'LOWER60SECDISPATCH',
    'LOWER60SECIMPORT', 'LOWER60SECLOCALDISPATCH', 'LOWER60SECLOCALPRICE', 'LOWER60SECLOCALREQ',
    'LOWER60SECPRICE', 'LOWER60SECREQ', 'LOWER60SECSUPPLYPRICE', 'LOWER6SECDISPATCH',
    'LOWER6SECIMPORT', 'LOWER6SECLOCALDISPATCH', 'LOWER6SECLOCALPRICE', 'LOWER6SECLOCALREQ',
    'LOWER6SECPRICE', 'LOWER6SECREQ', 'LOWER6SECSUPPLYPRICE', 'RAISE5MINDISPATCH',
    'RAISE5MINIMPORT', 'RAISE5MINLOCALDISPATCH', 'RAISE5MINLOCALPRICE', 'RAISE5MINLOCALREQ',
    'RAISE5MINPRICE', 'RAISE5MINREQ', 'RAISE5MINSUPPLYPRICE', 'RAISE60SECDISPATCH',
    'RAISE60SECIMPORT', 'RAISE60SECLOCALDISPATCH', 'RAISE60SECLOCALPRICE', 'RAISE60SECLOCALREQ',
    'RAISE60SECPRICE', 'RAISE60SECREQ', 'RAISE60SECSUPPLYPRICE', 'RAISE6SECDISPATCH',
    'RAISE6SECIMPORT', 'RAISE6SECLOCALDISPATCH', 'RAISE6SECLOCALPRICE', 'RAISE6SECLOCALREQ',
    'RAISE6SECPRICE', 'RAISE6SECREQ', 'RAISE6SECSUPPLYPRICE', 'AGGEGATEDISPATCHERROR',
    'AGGREGATEDISPATCHERROR', 'LASTCHANGED', 'INITIALSUPPLY', 'CLEAREDSUPPLY',
    'LOWERREGIMPORT', 'LOWERREGLOCALDISPATCH', 'LOWERREGLOCALREQ', 'LOWERREGREQ',
    'RAISEREGIMPORT', 'RAISEREGLOCALDISPATCH', 'RAISEREGLOCALREQ', 'RAISEREGREQ',
    'RAISE5MINLOCALVIOLATION', 'RAISEREGLOCALVIOLATION', 'RAISE60SECLOCALVIOLATION',
    'RAISE6SECLOCALVIOLATION', 'LOWER5MINLOCALVIOLATION', 'LOWERREGLOCALVIOLATION',
    'LOWER60SECLOCALVIOLATION', 'LOWER6SECLOCALVIOLATION', 'RAISE5MINVIOLATION',
    'RAISEREGVIOLATION', 'RAISE60SECVIOLATION', 'RAISE6SECVIOLATION', 'LOWER5MINVIOLATION',
    'LOWERREGVIOLATION', 'LOWER60SECVIOLATION', 'LOWER6SECVIOLATION',
    'RAISE6SECACTUALAVAILABILITY', 'RAISE60SECACTUALAVAILABILITY', 'RAISE5MINACTUALAVAILABILITY',
    'RAISEREGACTUALAVAILABILITY', 'LOWER6SECACTUALAVAILABILITY', 'LOWER60SECACTUALAVAILABILITY',
    'LOWER5MINACTUALAVAILABILITY', 'LOWERREGACTUALAVAILABILITY', 'LORSURPLUS', 'LRCSURPLUS',
    'TOTALINTERMITTENTGENERATION', 'DEMAND_AND_NONSCHEDGEN', 'UIGF', 'SEMISCHEDULE_CLEAREDMW',
    'SEMISCHEDULE_COMPLIANCEMW', 'SS_SOLAR_UIGF', 'SS_WIND_UIGF', 'SS_SOLAR_CLEAREDMW',
    'SS_WIND_CLEAREDMW', 'SS_SOLAR_COMPLIANCEMW', 'SS_WIND_COMPLIANCEMW', 'WDR_INITIALMW',
    'WDR_AVAILABLE', 'WDR_DISPATCHED', 'RAISE1SECLOCALDISPATCH', 'LOWER1SECLOCALDISPATCH',
    'RAISE1SECACTUALAVAILABILITY', 'LOWER1SECACTUALAVAILABILITY', 'SS_SOLAR_AVAILABILITY',
    'SS_WIND_AVAILABILITY', 'BDU_ENERGY_STORAGE', 'BDU_MIN_AVAIL', 'BDU_MAX_AVAIL',
    'BDU_CLEAREDMW_GEN', 'BDU_CLEAREDMW_LOAD', 'BDU_INITIAL_ENERGY_STORAGE'
] -%}
{# Kept raw or handled in the tail instead of CAST(... AS DOUBLE) #}
{%- set not_double = ['I', 'DISPATCH', 'REC', 'xx', 'SETTLEMENTDATE', 'RUNNO', 'REGIONID',
    'DISPATCHINTERVAL', 'LASTCHANGED'] -%}
WITH regionsum_staging AS (
  SELECT *
  FROM read_csv(
    getvariable('regionsum_today_paths'),
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
  WHERE I = 'D' AND REC = 'REGIONSUM' AND xx = '9'
)

SELECT
  REGIONID,
  {%- for name in csv_cols if name not in not_double %}
  CAST({{ name }} AS DOUBLE) AS {{ name }},
  {%- endfor %}
  CAST(SETTLEMENTDATE AS TIMESTAMPTZ) AS SETTLEMENTDATE,
  CAST(SETTLEMENTDATE AS DATE) AS DATE,
  {{ parse_filename('filename') }} AS file,
  CAST(YEAR(CAST(SETTLEMENTDATE AS TIMESTAMP)) AS INT) AS YEAR
FROM regionsum_staging
{% else %}
-- No unprocessed files: empty result keeps existing data untouched
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
