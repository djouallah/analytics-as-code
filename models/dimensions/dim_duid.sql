{#- The NEM units come from two files, both written by stg_csv_archive_log:
    registration.csv, the generator sheet of AEMO's current NEM Registration and Exemption
    List, and duid_unregistered.csv, the units in the data that the list doesn't have.
    Every file read here is declared in models/sources.yml (source duid_reference). -#}

{# Check if there are new DUIDs not in the existing table #}
{%- set check_new_duids_query -%}
  SELECT count(*) as cnt FROM (
    SELECT DUID FROM read_csv({{ source('duid_reference', 'registration') }}, all_varchar = true) WHERE length(DUID) > 2
    UNION
    SELECT DUID FROM read_csv({{ source('duid_reference', 'duid_unregistered') }}, all_varchar = true) WHERE length(DUID) > 2
    UNION
    SELECT "Facility Code" AS DUID FROM read_csv_auto({{ source('duid_reference', 'facilities') }})
  ) source_duids
  WHERE DUID NOT IN (SELECT DUID FROM {{ this }})
{%- endset -%}

{%- if execute and is_incremental() and flags.WHICH in ('run', 'build', 'retry') -%}
  {%- set result = run_query(check_new_duids_query) -%}
  {%- set has_new_duids = result and result.rows[0][0] > 0 -%}
{%- else -%}
  {%- set has_new_duids = true -%}
{%- endif -%}

-- Insert-only merge on DUID (WHEN MATCHED DO NOTHING), same pattern as the facts:
-- new DUIDs are inserted, existing ones are never touched — so a run that sees a
-- stale/empty view of the table can at worst re-insert nothing that survives the
-- merge, instead of the old wipe-and-reload appending a full duplicate copy.
-- Consequence: attribute changes (region/fuel/geo) never update in place;
-- dispatching process_data.yml with rebuild=dim_duid is the reconciliation lever
-- (not --full-refresh: its RENAME step is untested on this catalog).
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['DUID'],
    merge_clauses={'when_matched': [{'action': 'do_nothing'}]},
    on_schema_change='sync_all_columns'
) }}

-- Ensure the download runs first
-- depends_on: {{ ref('stg_csv_archive_log') }}

{% if has_new_duids %}
WITH
  -- Deliberately an inline CTE, not a seed: 6 static rows aren't worth a
  -- materialized Iceberg table + a `dbt seed` step in every runner.
  states AS (
    SELECT 'WA1' AS RegionID, 'Western Australia' AS State
    UNION ALL SELECT 'QLD1', 'Queensland'
    UNION ALL SELECT 'NSW1', 'New South Wales'
    UNION ALL SELECT 'TAS1', 'Tasmania'
    UNION ALL SELECT 'SA1', 'South Australia'
    UNION ALL SELECT 'VIC1', 'Victoria'
  ),

  -- The fuels that count as renewable, by the names AEMO's list gives them. This is the one
  -- place the rule lives: the dashboard reads the Renewable column. Batteries ("Grid") are
  -- storage, not on the list. Inline for the same reason as states; a change to the list
  -- reaches the rows already in the table with a rebuild=dim_duid.
  renewable_fuels AS (
    SELECT unnest(['Solar', 'Wind', 'Water', 'Bagasse', 'Biogas - sludge',
                   'Landfill methane / landfill gas', 'Sewerage / waste water']) AS fuel
  ),

  -- One row per DUID. The registration list wins over duid_unregistered.csv (a unit can
  -- come back onto the list); within the list a unit's generating registration wins over
  -- its load registration (e.g. LIMOSF11 is listed as both). duid_unregistered.csv has no
  -- technology and no classification column, and no fuel for the loads AEMO gives no energy
  -- source for. Classification is the list's own (Scheduled, Semi-Scheduled, Non-Scheduled),
  -- without the footnote stars some rows carry.
  duid_aemo_ranked AS (
    SELECT DUID, Region, "Fuel Source - Descriptor" AS fuel, Participant,
           "Station Name" AS StationName,
           "Technology Type - Descriptor" AS TechnologyType,
           TRY_CAST("Reg Cap generation (MW)" AS DOUBLE) AS RegCapMW,
           TRY_CAST("Max Cap generation (MW)" AS DOUBLE) AS MaxCapMW,
           TRY_CAST("Maximum storage capacity" AS DOUBLE) AS StorageMWh,
           trim(replace(Classification, '*', '')) AS Classification,
           CASE WHEN "Dispatch Type" ILIKE '%load%' THEN 1 ELSE 0 END AS priority
    FROM read_csv({{ source('duid_reference', 'registration') }}, all_varchar = true)
    WHERE length(DUID) > 2
    UNION ALL
    SELECT DUID, Region, "Fuel Source - Descriptor", Participant,
           "Station Name" AS StationName,
           NULL AS TechnologyType,
           TRY_CAST("Reg Cap generation (MW)" AS DOUBLE) AS RegCapMW,
           TRY_CAST("Max Cap generation (MW)" AS DOUBLE) AS MaxCapMW,
           TRY_CAST("Maximum storage capacity" AS DOUBLE) AS StorageMWh,
           NULL AS Classification,
           2
    FROM read_csv({{ source('duid_reference', 'duid_unregistered') }}, all_varchar = true)
    WHERE length(DUID) > 2
  ),

  duid_aemo AS (
    SELECT
      DUID,
      arg_min(Region, priority) AS Region,
      arg_min(fuel, priority) AS FuelSourceDescriptor,
      arg_min(Participant, priority) AS Participant,
      arg_min(StationName, priority) AS StationName,
      arg_min(TechnologyType, priority) AS TechnologyType,
      arg_min(RegCapMW, priority) AS RegCapMW,
      arg_min(MaxCapMW, priority) AS MaxCapMW,
      arg_min(StorageMWh, priority) AS StorageMWh,
      arg_min(Classification, priority) AS Classification
    FROM duid_aemo_ranked
    GROUP BY DUID
  ),

  wa_facilities AS (
    SELECT
      'WA1' AS Region,
      "Facility Code" AS DUID,
      "Participant Name" AS Participant
    FROM
      read_csv_auto({{ source('duid_reference', 'facilities') }})
  ),

  wa_energy AS (
    SELECT *
    FROM read_csv_auto({{ source('duid_reference', 'WA_ENERGY') }}, header = 1)
  ),

  duid_wa AS (
    SELECT
      wa_facilities.DUID,
      wa_facilities.Region,
      wa_energy.Technology AS FuelSourceDescriptor,
      wa_facilities.Participant,
      NULL::VARCHAR AS StationName,
      NULL::VARCHAR AS TechnologyType,
      NULL::DOUBLE AS RegCapMW,
      NULL::DOUBLE AS MaxCapMW,
      NULL::DOUBLE AS StorageMWh,
      NULL::VARCHAR AS Classification
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
    FROM read_csv({{ source('duid_reference', 'geo_data') }})
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
  first(geo.longitude) AS longitude,
  -- Registered capacity, for capacity factors (added 2026-10-01). Rows inserted before then
  -- were filled by a rebuild=dim_duid; WA units have none.
  first(a.StationName) AS StationName,
  first(a.TechnologyType) AS TechnologyType,
  first(a.RegCapMW) AS RegCapMW,
  first(a.MaxCapMW) AS MaxCapMW,
  first(a.StorageMWh) AS StorageMWh,
  -- Whether the unit's fuel is on renewable_fuels (added 2026-10-04); a unit with no fuel
  -- is not. Compared in lower case, so it doesn't depend on the casing applied above.
  first(renewable_fuels.fuel IS NOT NULL) AS Renewable,
  -- How AEMO dispatches the unit (added 2026-10-04): Semi-Scheduled is a wind or solar farm
  -- that can be capped, which is what curtailment is measured on. Not the fuel: Hornsdale
  -- Power Reserve, a battery, is registered with the fuel "Wind". NULL for the units that
  -- are not on the registration list and for WA.
  first(a.Classification) AS Classification
FROM duid_all a
JOIN states ON a.Region = states.RegionID
LEFT JOIN geo ON a.duid = geo.duid
LEFT JOIN renewable_fuels ON lower(renewable_fuels.fuel) = lower(trim(a.FuelSourceDescriptor))
GROUP BY a.DUID
{% else %}
-- No new DUIDs found, return empty result to keep existing data
SELECT * FROM {{ this }} WHERE FALSE
{% endif %}
