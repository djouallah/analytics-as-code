// Made-up data in the shape of this repository's model (semantic_model/model.bim): a few
// units in each region, 5-minute rows for the last days, daily rows for the month before.
// Deterministic: the values come from hashes of the keys. Each table is v_<table>, the
// names the page's compiler reads.
export const setup = `
CREATE TABLE v_dim_region AS SELECT * FROM (VALUES ('NSW1', 'NSW'), ('QLD1', 'QLD'), ('VIC1', 'VIC'), ('SA1', 'SA'), ('TAS1', 'TAS'), ('WA1', NULL))
  t("Region", "State");
CREATE TABLE v_dim_calendar AS SELECT CAST(d AS DATE) AS date, year(d) AS year, month(d) AS month
  FROM generate_series(TIMESTAMP '2026-08-01', TIMESTAMP '2026-10-31', INTERVAL 1 DAY) g(d);
CREATE TABLE v_dim_month AS SELECT CAST(date_trunc('month', date) AS DATE) AS month, CAST(COUNT(*) AS BIGINT) AS days FROM v_dim_calendar GROUP BY 1;
CREATE TABLE v_dim_time AS SELECT CAST((m // 60) * 100 + m % 60 AS BIGINT) AS time, CAST(m % 60 AS BIGINT) AS minute, CAST(m // 60 AS BIGINT) AS hour
  FROM range(0, 1440, 5) r(m);
CREATE TABLE v_dim_duid AS SELECT *,
    COALESCE(lower(trim("FuelSourceDescriptor")) = 'grid', false) AS "Storage",
    COALESCE("StationName", "DUID") AS "Plant",
    COALESCE("Participant", CASE WHEN starts_with("DUID", 'ROOFTOP_') THEN 'Rooftop solar (AEMO estimate)' END) AS "Owner"
  FROM (VALUES
  ('WIND1', 'NSW1', 'NSW', 'Wind', 'P1', 'Wind Farm A', 'Wind Turbine', 'Semi-Scheduled', 0.0, TRUE, 100.0, 100.0, NULL::DOUBLE, -33.0, 150.0),
  ('WIND2', 'VIC1', 'VIC', 'Wind', 'P2', 'Wind Farm B', 'Wind Turbine', 'Semi-Scheduled', 0.0, TRUE, 200.0, 210.0, NULL, -37.0, 144.0),
  ('SOLAR1', 'QLD1', 'QLD', 'Solar', 'P1', 'Solar Farm A', 'Photovoltaic', 'Semi-Scheduled', 0.0, TRUE, 150.0, 150.0, NULL, -27.0, 152.0),
  ('COAL1', 'NSW1', 'NSW', 'Black coal', 'P3', 'Coal Station', 'Steam', 'Scheduled', 0.9, FALSE, 700.0, 720.0, NULL, -32.5, 151.0),
  ('COAL2', 'NSW1', 'NSW', 'Black coal', 'P3', 'Coal Station', 'Steam', 'Scheduled', 0.9, FALSE, 700.0, 720.0, NULL, -32.5, 151.0),
  ('GAS1', 'SA1', 'SA', 'Natural gas', 'P4', 'Gas Peaker', 'OCGT', 'Scheduled', 0.6, FALSE, 120.0, 130.0, NULL, -34.9, 138.6),
  ('HYDRO1', 'TAS1', 'TAS', 'Hydro', 'P5', 'Hydro Dam', 'Hydro', 'Scheduled', 0.0, TRUE, 300.0, 300.0, NULL, -42.0, 146.0),
  ('BATT1', 'VIC1', 'VIC', 'Grid', 'P2', 'Big Battery', 'Battery', 'Scheduled', 0.0, FALSE, 100.0, 100.0, 200.0, -37.8, 144.9),
  ('BATT2', 'SA1', 'SA', 'Grid', NULL, NULL, 'Battery', 'Scheduled', 0.0, FALSE, 50.0, 50.0, 100.0, NULL, NULL),
  ('MYST1', 'QLD1', 'QLD', NULL, 'P6', 'Unknown Plant', NULL, NULL, NULL, NULL, 10.0, 10.0, NULL, -20.0, 146.0),
  ('ROOFTOP_NSW1', 'NSW1', 'NSW', 'Rooftop solar', NULL, NULL, 'Photovoltaic', NULL, NULL, TRUE, 0.0, 0.0, NULL, NULL, NULL),
  ('ROOFTOP_VIC1', 'VIC1', 'VIC', 'Rooftop solar', NULL, NULL, 'Photovoltaic', NULL, NULL, TRUE, 0.0, 0.0, NULL, NULL, NULL))
  t("DUID", "Region", "State", "FuelSourceDescriptor", "Participant", "StationName", "TechnologyType", "Classification",
    "CO2eFactor", "Renewable", "RegCapMW", "MaxCapMW", "StorageMWh", latitude, longitude);
-- 5-minute rows: the last 6 days (2026-10-02 .. 2026-10-07), every 2 hours, every unit.
CREATE TABLE v_fct_summary AS
  WITH k AS (SELECT CAST(d AS DATE) AS date, CAST(h * 200 AS BIGINT) AS time, u."DUID" FROM generate_series(TIMESTAMP '2026-10-02', TIMESTAMP '2026-10-07', INTERVAL 1 DAY) g(d),
    range(0, 12) r(h), v_dim_duid u)
  SELECT date, time, "DUID",
    CAST(CASE WHEN "DUID" LIKE 'BATT%' THEN (hash(date, time, "DUID") % 200)::INT - 100 ELSE (hash(date, time, "DUID") % 500)::INT END AS DECIMAL(15,5)) AS mw,
    CAST((hash(date, time) % 300)::INT - 50 AS DECIMAL(15,5)) AS price,
    TIMESTAMP '2026-10-07 22:00:00' AS cutoff
  FROM k WHERE NOT (date = DATE '2026-10-07' AND time > 2000);
-- Daily rows: 2026-09-01 .. 2026-10-05 (the 6th and 7th are in the 5-minute rows only).
CREATE TABLE v_fct_summary_daily AS
  WITH k AS (SELECT CAST(d AS DATE) AS date, u."DUID" FROM generate_series(TIMESTAMP '2026-09-01', TIMESTAMP '2026-10-05', INTERVAL 1 DAY) g(d), v_dim_duid u)
  SELECT "DUID", date, CAST((hash(date, "DUID") % 5000)::INT AS DECIMAL(15,5)) AS mwh, CAST((hash(date) % 200)::INT AS DECIMAL(15,5)) AS price,
    CAST((hash(date, "DUID", 1) % 6000)::INT AS DOUBLE) AS output_mwh,
    CAST(CASE WHEN "DUID" LIKE 'BATT%' THEN -((hash(date, "DUID", 2) % 300)::INT) ELSE 0 END AS DOUBLE) AS charging_mwh,
    CAST((hash(date, "DUID", 3) % 500000)::INT AS DOUBLE) AS revenue
  FROM k;
CREATE TABLE v_fct_region AS
  WITH k AS (SELECT DISTINCT date, time FROM v_fct_summary), r AS (SELECT "Region" AS "REGIONID" FROM v_dim_region WHERE "Region" <> 'WA1')
  SELECT "REGIONID", date, time, CAST((hash(date, time, "REGIONID") % 400)::INT - 80 AS DECIMAL(15,5)) AS price,
    CAST(CASE WHEN hash(date, time, "REGIONID", 9) % 17 = 0 THEN NULL ELSE 1000 + (hash(date, time, "REGIONID") % 9000)::INT END AS DECIMAL(15,5)) AS demand,
    CAST((hash(date, time, "REGIONID", 4) % 600)::INT - 300 AS DECIMAL(15,5)) AS net_interchange,
    CAST((hash(date, time, "REGIONID", 5) % 900)::INT AS DECIMAL(15,5)) AS wind_available,
    CAST((hash(date, time, "REGIONID", 6) % 50)::INT AS DECIMAL(15,5)) AS wind_curtailed,
    CAST((hash(date, time, "REGIONID", 7) % 700)::INT AS DECIMAL(15,5)) AS solar_available,
    CAST((hash(date, time, "REGIONID", 8) % 40)::INT AS DECIMAL(15,5)) AS solar_curtailed
  FROM k, r;
CREATE TABLE v_fct_region_daily AS
  WITH k AS (SELECT CAST(d AS DATE) AS date FROM generate_series(TIMESTAMP '2026-09-01', TIMESTAMP '2026-10-05', INTERVAL 1 DAY) g(d)),
    r AS (SELECT "Region" AS "REGIONID" FROM v_dim_region WHERE "Region" <> 'WA1')
  SELECT "REGIONID", date, CAST((hash(date, "REGIONID") % 300)::INT - 40 AS DECIMAL(15,5)) AS price,
    CAST(1000 + (hash(date, "REGIONID", 1) % 8000)::INT AS DECIMAL(15,5)) AS demand,
    CAST((hash(date, "REGIONID", 2) % 400)::INT - 200 AS DECIMAL(15,5)) AS net_interchange
  FROM k, r;
CREATE TABLE v_dim_interconnector AS SELECT * FROM (VALUES ('N-Q', 'NSW1', 'QLD1', 'NSW to QLD'), ('V-S', 'VIC1', 'SA1', 'VIC to SA'), ('T-V', 'TAS1', 'VIC1', 'Basslink'))
  t(interconnector, from_region, to_region, description);
CREATE TABLE v_fct_interconnector AS SELECT i.interconnector, k.date, k.time, CAST((hash(i.interconnector, k.date, k.time) % 800)::INT - 400 AS DECIMAL(15,5)) AS mw,
    CAST(600 AS DECIMAL(15,5)) AS export_limit, CAST(-600 AS DECIMAL(15,5)) AS import_limit
  FROM (SELECT DISTINCT date, time FROM v_fct_summary) k, v_dim_interconnector i;
CREATE TABLE v_fct_curtailment AS SELECT u."DUID", CAST(d AS DATE) AS date, CAST((hash(u."DUID", d) % 30)::INT AS DECIMAL(15,5)) AS curtailed_mwh,
    CAST(100 + (hash(u."DUID", d, 1) % 900)::INT AS DECIMAL(15,5)) AS available_mwh
  FROM generate_series(TIMESTAMP '2026-09-20', TIMESTAMP '2026-10-06', INTERVAL 1 DAY) g(d), v_dim_duid u WHERE u."FuelSourceDescriptor" IN ('Wind', 'Solar');
CREATE TABLE v_fct_curtailment_region AS SELECT r."Region" AS "REGIONID", CAST(d AS DATE) AS date, f.fuel,
    CAST((hash(r."Region", d, f.fuel) % 100)::INT AS DECIMAL(15,5)) AS curtailed_mwh, CAST(500 + (hash(r."Region", d, f.fuel, 1) % 2000)::INT AS DECIMAL(15,5)) AS available_mwh,
    CASE WHEN d < TIMESTAMP '2026-10-01' THEN 'farms' ELSE 'aemo' END AS source
  FROM generate_series(TIMESTAMP '2026-09-20', TIMESTAMP '2026-10-06', INTERVAL 1 DAY) g(d), v_dim_region r, (VALUES ('Wind'), ('Solar')) f(fuel)
  WHERE r."Region" <> 'WA1';
CREATE TABLE v_fct_summary_hourly AS SELECT u."DUID", m.month, CAST(h AS BIGINT) AS hour, CAST((hash(u."DUID", m.month, h) % 3000)::INT AS DECIMAL(15,5)) AS mwh
  FROM v_dim_month m, range(0, 24) r(h), v_dim_duid u WHERE m.month BETWEEN DATE '2026-08-01' AND DATE '2026-10-01';
CREATE TABLE v_fct_region_hourly AS SELECT r."Region" AS "REGIONID", m.month, CAST(h AS BIGINT) AS hour,
    CAST((hash(r."Region", m.month, h) % 200)::INT AS DECIMAL(15,5)) AS price, CAST(300 + (hash(r."Region", m.month, h, 1) % 60)::INT AS BIGINT) AS intervals
  FROM v_dim_month m, range(0, 24) r(h), v_dim_region r WHERE r."Region" <> 'WA1' AND m.month BETWEEN DATE '2026-08-01' AND DATE '2026-10-01';
`;
