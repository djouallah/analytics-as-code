-- Test: every DUID that has generated in the last 30 days exists in dim_duid.
--
-- Replaces the generic relationships test on fct_scada.DUID, which warned on 82M rows and
-- could never reach 0: dim_duid is built from AEMO's *current* registration list, while
-- fct_scada goes back to 2018 and is full of DUIDs that have since been retired. Scoping to
-- recent data turns it into a real signal -- dim_duid has gone stale.
--
-- Kept at warn: AEMO republishes the registration list roughly fortnightly, so a newly
-- commissioned DUID can legitimately generate for a few days before it appears there.

{{ config(severity='warn') }}

SELECT DISTINCT
  f.DUID
FROM {{ ref('fct_scada') }} f
WHERE f.DATE >= CURRENT_DATE - INTERVAL 30 DAY
  AND NOT EXISTS (
    SELECT 1
    FROM {{ ref('dim_duid') }} d
    WHERE d.DUID = f.DUID
  )
