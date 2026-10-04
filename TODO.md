# TODO

Ideas, not requirements. The only goal is a dashboard that is more useful; an item that
doesn't serve that can be dropped, and none of them has to land as written. Open items
only: a finished item is removed, not ticked.

- **No workarounds.** If an item only works through a hack (hand-made rows, guessed mappings,
  values copied from another source to fill a hole), don't build it.
- **Don't invent data.** If AEMO doesn't publish it, or the archive doesn't go back far
  enough, the chart shows the gap ("no data before …") or the item is dropped. Never fill it.
- **Simplest first.** Each item stands alone unless it says otherwise.

## Small

- [ ] **DuckDB 2.0.0 stable** (due 2026-10-21) — replace `2.0.0.dev2609250715` in
  `requirements.txt`, `table_maintenance.yml` (compaction) and `import_data.yml` (read venv);
  check Process Data, maintenance and import; update AGENTS.md's version policy.
- [ ] **Capability probe** (separate repo, manual) — re-run against the 2.0 pin.
- [ ] **The hour-of-day profile reads low for the current month** (not confirmed on the data) —
  `month_days` (`scripts/cache_catalog.py build_daily_agg`) counts every date in the scada
  export, and the newest one only holds 00:05 → 04:00 (a daily file's trading day ends at
  04:00). Hours 4-23 of the current month are then divided by one day too many. Check with
  the intervals of the newest date in a half-year file before changing anything.

## Bigger

- [ ] **Curtailment right up to now, per region** — the Insights chart ends with the newest
  next-day file. `fct_regionsum_today` carries regional `SS_SOLAR_AVAILABILITY`/`SS_WIND_AVAILABILITY`
  against `SS_*_CLEAREDMW` every 5 minutes, and it matches the per-unit sum: a per-region line
  for the last days can be real. Per-unit stays next-day only.
- [ ] **Two units with a wrong fuel in `duid_unregistered.csv`** (aemo_data) — TORRB1 is
  "Natural gas" (the list had "Natural gas / fuel oil"), ADPBA1L, the load side of the
  Adelaide Desalination battery, has no fuel, so its charging shows as "Unknown". Fix in the
  generator of that file, then `rebuild=dim_duid`.
- [ ] **History back to 2015** — AEMO's monthly MMSDM archive can rebuild the daily files for
  2015-01-01 → 2018-03-31 (1,186 days). A daily file's `DUNIT` v3 record is MMSDM
  `DISPATCHLOAD`, and `DREGION` v3 is `DISPATCHPRICE` joined to `DISPATCHREGIONSUM`: columns by
  name in the models' `csv_cols` order, the trading day running 04:05 → 04:00 next day.
  Rebuilt days that exist (2018-04-01, 2018-08-29, 2019-12-30) match the real files on every
  row and column, read the way `fct_scada` and `fct_price` read them. The 1,187 files are
  built (1.8 GB) but **not uploaded**. Left to do:
  - push them to `djouallah/aemo_data` under `data/archive/2015` … `2018`;
  - `stg_csv_archive_log.py`: list the archive from 2015, not 2018, and start the
    interconnector months at 2015-01 (the 36 extra monthly URLs exist, same 22-column layout);
  - `dim_calendar.sql`: start at 2015-01-01 instead of 2018-03-06;
  - load (`download_limit` raised once), then `import_data.yml` with `all_periods=true`.

  Two things to settle first: the deployed data files are about 973 MB against GitHub
  Pages' 1 GB soft limit, and seven more half-year files add roughly 250 MB; and plants
  closed before 2018 (Hazelwood, Northern) will show as "Unregistered" until
  `duid_unregistered.csv` (aemo_data) is regenerated over the longer history, from the same
  MMSDM tables. MMSDM months before 2015 sit in a different folder layout, not
  looked at. Rooftop solar has no usable estimate before 2018-03-06.
- [ ] **Interconnectors from the data** — the Flows page types each link's two regions and
  its name (`INTERCONNECTORS` in `dashboard/index.html`); the facts carry only the id. AEMO's
  MMSDM `INTERCONNECTOR` table should have them (`REGIONFROM`, `REGIONTO`, a description;
  not checked against the archive): a small `dim_interconnector`, exported with the dims.
- [ ] **Site size** — the deployed data files are close to GitHub Pages' 1 GB limit, and the
  current half-year file grows to ~75 MB by its end. Measure what takes the space in a
  half-year file before anything else is added.
- [ ] **Emissions** — AEMO MMSDM `GENUNITS` has a CO2 factor per genset (`DUALLOC` maps it to
  a DUID): an emissions-intensity KPI and chart. A unit without a factor stays out; no
  guessed factor.

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and `import_data.yml`'s write venv
  together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
- [ ] AEMO publishes `ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute rooftop estimate) → move
  `fct_rooftop_pv` to it; the half-hourly record it replaces is to be removed (see AGENTS.md).
