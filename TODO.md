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
  `requirements.txt`, `table_maintenance.yml` (compaction), `import_data.yml` and
  `import_onelake.yml` (read venv);
  check Process Data, maintenance and import; update AGENTS.md's version policy.
- [ ] **Capability probe** (separate repo, manual) — re-run against the 2.0 pin.
- [ ] **Fabric app from CI** — waiting on microsoft/rayfin#89. The CI deploy works
  (`deploy_fabric.yml` with `app=wasm`, dispatch-only, into its own item `nemtracker`), but
  Fabric answers 500 to every function call on an item owned by a service principal, and
  only an item's owner can deploy to it. When it is fixed: dispatch the workflow with
  `app=wasm` and open `nemtracker`.
  Until then the app is deployed from the laptop (`cd dashboard/fabric_app_wasm && npx rayfin up`).
- [ ] **The empty MERGE** — a landing fact with no new file still creates its temp table
  and runs `MERGE` against the target (5-7 s each, seven facts a run). Skipping it needs a
  custom incremental strategy (dbt-duckdb looks up `get_incremental_<name>_sql`) that
  counts the temp table first. Worth it only if the run total still matters after
  2026-10-06.
- [ ] **The intraday tables are never trimmed** (`fct_scada_today`, `fct_price_today`,
  `fct_regionsum_today`: no DELETE on OneLake). Since 2026-10-06 the scans that read them
  are bounded by the newest daily date, so growth costs file pruning, not rows; the
  tables themselves still grow by about a month's intervals a month, and a
  `rebuild=<table>` of one re-reads every intraday file in the log. If that ever hurts, the
  log could stop listing intraday files older than the newest daily file.
- [ ] **A refill is not exercised by CI** — `fct_summary`, `fct_summary_daily` and
  `fct_curtailment` refill downward from the oldest date they hold (2026-10-06); the next
  `rebuild=` of one of them is the first run of that path on the catalog. Read its log
  line ("recomputing" / "looking at") on each run until it reaches `fct_scada`'s oldest.

## Bigger

- [ ] **`rebuild=dim_duid` once the fixed `duid_unregistered.csv` is downloaded** — the file
  in aemo_data now gives TORRB1 "Natural Gas / Fuel Oil" and ADPBA1L "Grid" (from the older
  AEMO list, `duid_data.csv`). The pipeline re-downloads it 24 hours after its last copy
  (2026-10-05 after ~07:15 UTC); `dim_duid` holds the old values until a rebuild after that.
- [ ] **Interconnectors from the data** — the Flows page types each link's two regions and
  its name (`INTERCONNECTORS` in `dashboard/github/index.html`); the facts carry only the id. AEMO's
  MMSDM `INTERCONNECTOR` table should have them (`REGIONFROM`, `REGIONTO`, a description;
  not checked against the archive): a small `dim_interconnector`, a table of `model.bim`,
  copied with the dims.
- [ ] **Site size** — the deployed data files total about 880 MB (2026-10-05) against GitHub
  Pages' 1 GB limit, and grow by about 125 MB a year (a whole half-year file is about
  60 MB). The column sizes measured before the port were of the old files and have not been
  measured again on `fct_summary`. A smaller column (`time` as hour and minute, `mw` rounded
  to 0.1 MW, which changes the data) would now be a change to the `mart` model and to
  `model.bim`, and would not be enough against the growth: the real choice is where the
  5-minute history lives (another host for the half-year files, or only recent years at
  5 minutes and the rest from the daily aggregate). A decision for the owner, not a code
  change.
- [ ] **Emissions** — AEMO MMSDM `GENUNITS` has a CO2 factor per genset (`DUALLOC` maps it to
  a DUID): an emissions-intensity KPI and chart. A unit without a factor stays out; no
  guessed factor.

## Waiting on upstream

- [ ] duckdb-wasm build on DuckDB 2.0 → move the dashboard and the write venv of
  `import_data.yml` and `import_onelake.yml` together.
- [ ] duckdb-iceberg#1341 (snapshot expiry) merged → replace pyiceberg in
  `scripts/expire_snapshots.py`.
- [ ] AEMO publishes `ROOFTOP_PV_ACTUAL_PRED`/`_RUN` (5-minute rooftop estimate) → move
  `fct_rooftop_pv` to it; the half-hourly record it replaces is to be removed (see AGENTS.md).
