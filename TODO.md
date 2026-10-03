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
  check Process Data, maintenance and import; update CLAUDE.md's version policy.
- [ ] **Capability probe** (separate repo, manual) — re-run against the 2.0 pin.
- [ ] **A browser can keep a stale history file** — `cacheInOPFS` (`dashboard/index.html`) checks
  the ETag with a `no-store` HEAD but downloads with a plain `fetch`, which the HTTP cache can
  answer with the previous body for up to 10 minutes (GitHub Pages sends `max-age=600`): the
  old file is then stored under the new ETag and stays until the file changes again. Likely
  why rooftop showed for the last days only in one browser on 2026-10-02 while a fresh browser
  had every day; not confirmed on that machine. Fix: `fetch(url, { cache: 'no-store' })`.

## Bigger

- [ ] **Curtailment, up to yesterday** — `fct_scada` has `AVAILABILITY` and `TOTALCLEARED`; add
  daily curtailed MWh per semi-scheduled wind/solar unit to `energy_daily_agg.duckdb`
  (`scripts/cache_catalog.py build_daily_agg`), chart it in Insights. The last 5 days have no
  per-unit availability, so the per-unit view ends yesterday — don't estimate it.
  `fct_regionsum_today` does carry regional `SS_SOLAR_UIGF`/`SS_WIND_UIGF` against
  `SS_*_CLEAREDMW` for the last days, so a per-region view can be real right up to now.
- [ ] **History back to 2015** — AEMO's monthly MMSDM archive can rebuild the daily files for
  2015-01-01 → 2018-03-31 (1,186 days). A daily file's `DUNIT` v3 record is MMSDM
  `DISPATCHLOAD`, and `DREGION` v3 is `DISPATCHPRICE` joined to `DISPATCHREGIONSUM`: columns by
  name in the models' `csv_cols` order, the trading day running 04:05 → 04:00 next day.
  Rebuilding days that exist (2018-04-01, 2018-08-29, 2019-12-30) matched the real files on
  every row and column, read the way `fct_scada` and `fct_price` read them. The 1,187 files
  were built on 2026-10-02 (12 minutes, 1.8 GB) but **not uploaded**. Left to do:
  - push them to `djouallah/aemo_data` under `data/archive/2015` … `2018`;
  - `stg_csv_archive_log.py`: list the archive from 2015, not 2018, and start the
    interconnector months at 2015-01 (the 36 extra monthly URLs exist, same 22-column layout);
  - `dim_calendar.sql`: start at 2015-01-01 instead of 2018-04-01;
  - load (`download_limit` raised once), then `import_data.yml` with `all_periods=true`.

  Two things to settle first: the deployed data files are already 973 MB against GitHub
  Pages' 1 GB soft limit, and seven more half-year files add roughly 250 MB; and plants
  closed before 2018 (Hazelwood, Northern) will show as "Unregistered" until
  `duid_unregistered.csv` (aemo_data) is regenerated over the longer history, from the same
  MMSDM tables. MMSDM months before 2015 sit in a different folder layout, not
  looked at. Rooftop solar has no usable estimate before 2018-03-06.
- [ ] **Emissions** — AEMO MMSDM `GENUNITS` has a CO2 factor per genset (`DUALLOC` maps it to
  a DUID): an emissions-intensity KPI and chart. A unit without a factor stays out; no
  guessed factor.

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and `import_data.yml`'s write venv
  together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
- [ ] AEMO publishes `ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute rooftop estimate) → move
  `fct_rooftop_pv` to it; the half-hourly record it replaces is to be removed (see CLAUDE.md).
