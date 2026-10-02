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
- [ ] **A browser can keep a stale history file** — `cacheInOPFS` (`dashboard/index.html`) checks
  the ETag with a `no-store` HEAD but downloads with a plain `fetch`, which the HTTP cache can
  answer with the previous body for up to 10 minutes (GitHub Pages sends `max-age=600`): the
  old file is then stored under the new ETag and stays until the file changes again. Likely
  why rooftop showed for the last days only in one browser on 2026-10-02 while a fresh browser
  had every day; not confirmed on that machine. Fix: `fetch(url, { cache: 'no-store' })`.

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
- [x] **Flows back to 2018** — AEMO's monthly MMSDM archive holds the same `INTERCONNECTORRES`
  record as the DispatchIS files; its 104 months (2018-01 → 2026-08) load into
  `fct_interconnector_today` as more rows, the half-year files gain an `interconnector` table,
  and the Flows page plays any range of up to 30 days (2026-10-02). After the backfill:
  one `import_data.yml` dispatch with `all_periods=true`.
- [x] **Daily profile and price-by-hour beyond 30 days** — hour-of-day × month tables in the
  daily aggregate; beyond 30 days both charts are hourly over the whole months the range
  touches (2026-10-01).

## Stage 3 — bigger (new AEMO feeds)

- [x] **The two missing days** — no daily file was ever archived for 2018-08-30 and 2019-12-31.
  Both were rebuilt from AEMO's monthly MMSDM tables and added to `djouallah/aemo_data`
  (2026-10-02); the archive now has a file for every day from 2018-04-01.
- [ ] **History back to 2015** — the same rebuild gives 2015-01-01 → 2018-03-31 (1,186 days).
  A daily file's `DUNIT` v3 record is MMSDM `DISPATCHLOAD`, and `DREGION` v3 is `DISPATCHPRICE`
  joined to `DISPATCHREGIONSUM`: columns by name in the models' `csv_cols` order, the trading
  day running 04:05 → 04:00 next day. Rebuilding days that exist (2018-04-01, 2018-08-29,
  2019-12-30) matched the real files on every row and column, read the way `fct_scada` and
  `fct_price` read them. The 1,187 files were built on 2026-10-02 (12 minutes, 1.8 GB) but
  **not uploaded**. Left to do:
  - push them to `aemo_data` under `data/archive/2015` … `2018`;
  - `stg_csv_archive_log.py`: list the archive from 2015, not 2018, and start the
    interconnector months at 2015-01 (the 36 extra monthly URLs exist, same 22-column layout);
  - `dim_calendar.sql`: start at 2015-01-01 instead of 2018-04-01;
  - load (`download_limit` raised once), then `import_data.yml` with `all_periods=true`.
  Two things to settle first: the deployed data files are already 973 MB against GitHub
  Pages' 1 GB soft limit, and seven more half-year files add roughly 250 MB; and plants
  closed before today (Hazelwood, Northern) will show as "Unregistered" until the retired
  units item below is done. MMSDM months before 2015 sit in a different folder layout, not
  looked at. Rooftop solar has no usable estimate before 2018-03-06.

- [ ] **Retired units + emissions** — AEMO MMSDM monthly archive: `GENUNITS` (fuel, CO2
  factor), `DUALLOC` (DUID → unit), `DUDETAILSUMMARY` (region). Gives region/fuel to the ~10%
  "Unregistered" history and an emissions-intensity KPI and chart. DUIDs that MMSDM doesn't
  cover stay "Unregistered"; no guessed fuel, region or CO2 factor.
- [x] **Rooftop solar** — AEMO's half-hourly estimate per region (`ROOFTOP_PV_ACTUAL`) in the
  new `fct_rooftop_pv`, from 2018-03-06; in the dashboard as five pseudo-units (`QLD_PV` …)
  interpolated to 5 minutes, so the generation stack, the renewable share and every other
  unit-based chart include it; deselect the "Rooftop solar" fuel for the utility-only picture
  (2026-10-02). AEMO plans to replace the record with a 5-minute one: see CLAUDE.md.

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and `import_data.yml`'s write venv
  together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
