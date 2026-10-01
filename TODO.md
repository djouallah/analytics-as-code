# TODO

Ideas, not requirements. The only goal is a dashboard that is more useful; an item that
doesn't serve that can be dropped, and none of them has to land as written.

- **No workarounds.** If an item only works through a hack (hand-made rows, guessed mappings,
  interpolation, values copied from another source to fill a hole), don't build it.
- **Don't invent data.** If AEMO doesn't publish it, or the archive doesn't go back far
  enough, the chart shows the gap ("no data before …") or the item is dropped. Never fill it.
- **Simplest first.** Tick items off as they land; each stage stands alone unless an item
  says otherwise.

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
  per-unit availability, so the per-unit view ends yesterday — don't estimate it.
  `fct_regionsum_today` does carry regional `SS_SOLAR_UIGF`/`SS_WIND_UIGF` against
  `SS_*_CLEAREDMW` for the last days, so a per-region view can be real right up to now.
- [x] **Demand and net interchange** — history from `fct_price` (`TOTALDEMAND`,
  `NETINTERCHANGE`), the last days from the new `fct_regionsum_today` (REGIONSUM rows); both in
  the price exports. Dashed demand line over the generation stack, net exports chart in
  Insights (2026-10-01).
- [x] **Interconnector flows** — `fct_interconnector_today` from the `INTERCONNECTORRES` rows,
  exported (last 14 days) into `energy_today.duckdb`; its own **Flows** tab: price-shaded map
  with animated flows, live board, small multiples with limit bands, playback (2026-10-01).
- [ ] **Flows beyond 14 days** — add `interconnector` to the half-year files and the daily
  aggregate so the Flows page works on longer ranges. The archive only goes back to 2026-08:
  the range starts there, no backfill from other sources.
- [x] **Daily profile and price-by-hour beyond 30 days** — hour-of-day × month tables in the
  daily aggregate; beyond 30 days both charts are hourly over the whole months the range
  touches (2026-10-01).

## Stage 3 — bigger (new AEMO feeds)

- [ ] **Retired units + emissions** — AEMO MMSDM monthly archive: `GENUNITS` (fuel, CO2
  factor), `DUALLOC` (DUID → unit), `DUDETAILSUMMARY` (region). Gives region/fuel to the ~10%
  "Unregistered" history and an emissions-intensity KPI and chart. DUIDs that MMSDM doesn't
  cover stay "Unregistered"; no guessed fuel, region or CO2 factor.
- [ ] **Rooftop solar** — new feed from AEMO `ROOFTOP_PV/ACTUAL` (30-min, per region) with an
  archive/MMSDM backfill; rooftop in the generation stack and renewable share with and without
  it (today's share is utility-scale only). Backfill only as far as AEMO's archive goes;
  before that the share stays utility-only and is labelled as such.

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and `import_data.yml`'s write venv
  together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
