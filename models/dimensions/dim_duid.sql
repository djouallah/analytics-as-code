{#- The NEM units come from two files, both written by stg_csv_archive_log:
    registration.csv, the generator sheet of AEMO's current NEM Registration and Exemption
    List, and duid_unregistered.csv, the units in the data that the list doesn't have. Their
    CO2-e factors come from genunits.csv and dualloc.csv, AEMO's MMSDM tables.
    Every file read here is declared in models/sources.yml (source duid_reference).
    Plus one unit per NEM region for rooftop solar (ROOFTOP_<region>, added 2026-10-07): a
    derived reporting row, not a registered unit, so that fct_summary can carry rooftop as
    units of the fuel "Rooftop solar" and every filter on the units reaches it. -#}

{# Check if there are new DUIDs not in the existing table #}
{%- set check_new_duids_query -%}
  SELECT count(*) as cnt FROM (
    SELECT DUID FROM read_csv({{ source('duid_reference', 'registration') }}, all_varchar = true) WHERE length(DUID) > 2
    UNION
    SELECT DUID FROM read_csv({{ source('duid_reference', 'duid_unregistered') }}, all_varchar = true) WHERE length(DUID) > 2
    UNION
    SELECT "Facility Code" AS DUID FROM read_csv_auto({{ source('duid_reference', 'facilities') }})
    UNION
    SELECT 'ROOFTOP_' || unnest(['NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1'])
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
                   'Landfill methane / landfill gas', 'Sewerage / waste water',
                   'Rooftop solar']) AS fuel
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

  -- Rooftop solar, one unit per NEM region (see the header): no capacity, no classification,
  -- no owner, no coordinates.
  duid_rooftop AS (
    SELECT
      'ROOFTOP_' || RegionID AS DUID,
      RegionID AS Region,
      'Rooftop solar' AS FuelSourceDescriptor,
      NULL::VARCHAR AS Participant,
      'Rooftop solar ' || State AS StationName,
      NULL::VARCHAR AS TechnologyType,
      NULL::DOUBLE AS RegCapMW,
      NULL::DOUBLE AS MaxCapMW,
      NULL::DOUBLE AS StorageMWh,
      NULL::VARCHAR AS Classification
    FROM states
    WHERE RegionID <> 'WA1'
  ),

  duid_all AS (
    SELECT * FROM duid_aemo
    UNION ALL
    SELECT * FROM duid_wa
    UNION ALL
    SELECT * FROM duid_rooftop
  ),

  -- Each unit's CO2-e emissions factor, t per MWh sent out (added 2026-10-07), from AEMO's
  -- MMSDM registration tables, which hold every DUID, registered or not: the gensets of its
  -- newest DUALLOC allocation, their GENUNITS factors averaged by registered capacity (two
  -- units have gensets with different factors). NULL when none of them has one: loads, and
  -- the gensets AEMO lists "On Exclusion List" (about 1.4 GW of gas peakers in 2026-08),
  -- which the emissions measures therefore leave out. The date strings are YYYY/MM/DD
  -- hh:mm:ss, so they order as text.
  dualloc AS (
    SELECT DUID, GENSETID
    FROM read_csv({{ source('duid_reference', 'dualloc') }}, all_varchar = true)
    QUALIFY rank() OVER (PARTITION BY DUID
                         ORDER BY EFFECTIVEDATE DESC, CAST(VERSIONNO AS INT) DESC) = 1
  ),

  genunits AS (
    SELECT GENSETID,
           TRY_CAST(CO2E_EMISSIONS_FACTOR AS DOUBLE) AS factor,
           TRY_CAST(REGISTEREDCAPACITY AS DOUBLE) AS capacity
    FROM read_csv({{ source('duid_reference', 'genunits') }}, all_varchar = true)
  ),

  co2e AS (
    SELECT dualloc.DUID,
           round(coalesce(sum(factor * capacity) / nullif(sum(capacity), 0), avg(factor)), 8) AS factor
    FROM dualloc
    JOIN genunits ON genunits.GENSETID = dualloc.GENSETID
    WHERE factor IS NOT NULL
    GROUP BY dualloc.DUID
  ),

  geo AS (
    SELECT
      duid,
      max(latitude) as latitude,
      max(longitude) as longitude
    FROM read_csv({{ source('duid_reference', 'geo_data') }})
    WHERE latitude IS NOT NULL
    GROUP BY duid
  ),

  units AS (
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
  first(a.Classification) AS Classification,
  -- t CO2-e per MWh (added 2026-10-07; see co2e). NULL for WA.
  first(co2e.factor) AS CO2eFactor,
  -- Whether the unit is storage (added 2026-10-07): a battery, the fuel "Grid". The one place
  -- the rule lives: the semantic model's measures and the dashboard read the column. A unit
  -- with no fuel is not storage. Hornsdale Power Reserve's HPR1 is registered with the fuel
  -- "Wind", so it is not storage here, and is renewable.
  first(coalesce(lower(trim(a.FuelSourceDescriptor)) = 'grid', false)) AS Storage
FROM duid_all a
JOIN states ON a.Region = states.RegionID
LEFT JOIN geo ON a.duid = geo.duid
LEFT JOIN co2e ON co2e.DUID = a.DUID
LEFT JOIN renewable_fuels ON lower(renewable_fuels.fuel) = lower(trim(a.FuelSourceDescriptor))
GROUP BY a.DUID
  )

-- One spelling per name (added 2026-10-07): AEMO's list spells some names differently for
-- different units of them (WEST KIEWA POWER STATION and West Kiewa Power Station), and
-- VertiPaq stores text case-insensitively, so Power BI showed one of them for both while
-- DuckDB grouped them apart. The spelling kept is the greatest, which is the one with lower
-- case in it. The rows already in the table keep the spelling they were written with until
-- a rebuild=dim_duid.
SELECT * REPLACE (
  max(StationName) OVER (PARTITION BY lower(StationName)) AS StationName,
  max(Participant) OVER (PARTITION BY lower(Participant)) AS Participant,
  max(TechnologyType) OVER (PARTITION BY lower(TechnologyType)) AS TechnologyType),
  -- What the dashboard groups units by when it groups them by plant (added 2026-10-07): the
  -- station, or the unit itself when it has none (about 180 units, most of them loads).
  coalesce(max(StationName) OVER (PARTITION BY lower(StationName)), DUID) AS Plant,
  -- Who the unit's output is counted to (added 2026-10-07): the participant, and for rooftop
  -- solar's five units, which have none, the estimate they are. NULL where AEMO names none.
  coalesce(max(Participant) OVER (PARTITION BY lower(Participant)),
           CASE WHEN starts_with(DUID, 'ROOFTOP_') THEN 'Rooftop solar (AEMO estimate)' END) AS Owner
FROM units
{% else %}
-- No new DUIDs found, return empty result to keep existing data
{{ nothing_to_do() }}
{% endif %}
