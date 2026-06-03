{% set csv_archive_path = get_csv_archive_path() %}

{# DUID reference data only changes ~daily, and the raw CSVs only exist on the    #}
{# daily pass (stg gates the download to daily_refresh). On the 30-min intraday   #}
{# cycle, skip the rebuild entirely and keep the existing Iceberg table.          #}
{# On the daily pass we always rebuild (delete-all + reinsert the deduped SELECT) #}
{# rather than only when *new* DUIDs appear: the old "new DUIDs only" gate let    #}
{# pre-existing duplicates persist forever (they break the unique_dim_duid test   #}
{# and never self-heal unless a brand-new DUID happens to show up).               #}
{% set daily_refresh = env_var('daily_refresh', 'false') == 'true' %}

{%- set should_rebuild = (not is_incremental()) or daily_refresh -%}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    on_schema_change='sync_all_columns',
    pre_hook=["DELETE FROM " ~ this ~ " WHERE 1=1"] if (should_rebuild and is_incremental()) else []
) }}

-- Ensure download runs first by depending on stg_csv_archive_log
-- depends_on: {{ ref('stg_csv_archive_log') }}

{% if should_rebuild %}
WITH
  states AS (
    SELECT 'WA1' AS RegionID, 'Western Australia' AS State
    UNION ALL SELECT 'QLD1', 'Queensland'
    UNION ALL SELECT 'NSW1', 'New South Wales'
    UNION ALL SELECT 'TAS1', 'Tasmania'
    UNION ALL SELECT 'SA1', 'South Australia'
    UNION ALL SELECT 'VIC1', 'Victoria'
  ),

  duid_aemo AS (
    SELECT
      DUID AS DUID,
      first(Region) AS Region,
      first("Fuel Source - Descriptor") AS FuelSourceDescriptor,
      first(Participant) AS Participant
    FROM
      read_csv('{{ csv_archive_path }}/duid/duid_data.csv')
    WHERE
      length(DUID) > 2
    GROUP BY
      DUID
  ),

  wa_facilities AS (
    SELECT
      'WA1' AS Region,
      "Facility Code" AS DUID,
      "Participant Name" AS Participant
    FROM
      read_csv_auto('{{ csv_archive_path }}/duid/facilities.csv')
  ),

  wa_energy AS (
    SELECT *
    FROM read_csv_auto('{{ csv_archive_path }}/duid/WA_ENERGY.csv', header = 1)
  ),

  duid_wa AS (
    SELECT
      wa_facilities.DUID,
      wa_facilities.Region,
      wa_energy.Technology AS FuelSourceDescriptor,
      wa_facilities.Participant
    FROM wa_facilities
    LEFT JOIN wa_energy ON wa_facilities.DUID = wa_energy.DUID
  ),

  duid_all AS (
    SELECT * FROM duid_aemo
    UNION ALL
    SELECT * FROM duid_wa
  ),

  geo AS (
    SELECT
      duid,
      max(latitude) as latitude,
      max(longitude) as longitude
    FROM read_csv('{{ csv_archive_path }}/duid/geo_data.csv')
    WHERE latitude IS NOT NULL
    GROUP BY duid
  )

SELECT
  a.DUID,
  first(a.Region) AS Region,
  first(UPPER(LEFT(TRIM(FuelSourceDescriptor), 1)) || LOWER(SUBSTR(TRIM(FuelSourceDescriptor), 2))) AS FuelSourceDescriptor,
  first(a.Participant) AS Participant,
  first(states.State) AS State,
  first(geo.latitude) AS latitude,
  first(geo.longitude) AS longitude
FROM duid_all a
JOIN states ON a.Region = states.RegionID
LEFT JOIN geo ON a.duid = geo.duid
GROUP BY a.DUID
{% else %}
-- Intraday cycle: no rebuild, keep existing data
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
