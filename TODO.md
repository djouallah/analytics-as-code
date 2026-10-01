# TODO

Simplest first, in stages. Tick items off as they land; each stage is independent of the
next unless an item says otherwise.

## Stage 1 — simple (an hour or two each)

- [x] **Deploy repo history squash** — `NemTracker/nemtracker.github.io` is 16.5 GB (2026-10-01)
  because `energy_today.duckdb` (8 MB) is redeployed every 30 min and git keeps every copy.
  Weekly job: replace the history with one fresh commit of the current tree. The site stays
  identical. **Force-pushes the deploy repo — needs an explicit OK before it is built.**
- [x] **Station drill level** — group units by `dim_duid.StationName` (added 2026-10-01) as an
  option next to the fuel → DUID drill in `dashboard/index.html`.
- [x] **Document the 5-day seam** — history uses `INITIALMW`, the last 5 days `SCADAVALUE`
  (`fct_scada_today.sql`), so the two measures meet in the dashboard. Note it in CLAUDE.md (a
  rebuild to unify them isn't worth it).
- [ ] **DuckDB 2.0.0 stable** (due 2026-10-21) — replace `2.0.0.dev2609250715` in
  `requirements.txt`, `table_maintenance.yml` (compaction) and `import_data.yml` (read venv);
  check Process Data, maintenance and import; update CLAUDE.md's version policy.
- [ ] **Capability probe** (separate repo, manual) — re-run against the 2.0 pin.

## Stage 2 — moderate (data already archived, no new downloads)

The 5-minute DispatchIS files already archived since 2026-08 also carry `REGIONSUM` and
`INTERCONNECTORRES` rows; `fct_price_today` only keeps `PRICE`.

- [ ] **Curtailment, up to yesterday** — `fct_scada` has `AVAILABILITY` and `TOTALCLEARED`; add
  daily curtailed MWh per semi-scheduled wind/solar unit to `energy_daily_agg.duckdb`
  (`scripts/cache_catalog.py build_daily_agg`), chart it in Insights. The last 5 days have no
  availability, so it ends yesterday.
- [ ] **Demand and net interchange** — history is in `fct_price` (`TOTALDEMAND`,
  `NETINTERCHANGE`); new model `fct_regionsum_today` from the `REGIONSUM` rows. Add both
  columns to the price exports; demand line over the generation stack, imports/exports per
  region.
- [x] **Interconnector flows** — `fct_interconnector_today` from the `INTERCONNECTORRES` rows,
  exported (last 14 days) into `energy_today.duckdb`; its own **Flows** tab: price-shaded map
  with animated flows, live board, small multiples with limit bands, playback (2026-10-01).
- [ ] **Flows beyond 14 days** — add `interconnector` to the half-year files and the daily
  aggregate so the Flows page works on any range (the archive only goes back to 2026-08).
- [ ] **Daily profile and price-by-hour beyond 30 days** — add an hour-of-day × month aggregate
  to the daily aggregate so those Insights charts work on long ranges.

## Stage 3 — bigger (new AEMO feeds)

- [ ] **Retired units + emissions** — AEMO MMSDM monthly archive: `GENUNITS` (fuel, CO2
  factor), `DUALLOC` (DUID → unit), `DUDETAILSUMMARY` (region). Gives region/fuel to the ~10%
  "Unregistered" history and an emissions-intensity KPI and chart.
- [ ] **Rooftop solar** — new feed from AEMO `ROOFTOP_PV/ACTUAL` (30-min, per region) with an
  archive/MMSDM backfill; rooftop in the generation stack and renewable share with and without
  it (today's share is utility-scale only).

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and `import_data.yml`'s write venv
  together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
