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
  (`deploy_fabric.yml`, dispatch-only, into its own item `nemtracker`), but Fabric answers
  500 to every function call on an item owned by a service principal, and only an item's
  owner can deploy to it. When it is fixed: dispatch the workflow and open `nemtracker`.
  Until then the app is deployed from the laptop (`cd dashboard/fabric_app && npx rayfin up`).
- [ ] **What the mart step costs once the backfill is over** — read the model timings of a
  Process Data run when `fct_summary_daily` reaches back to 2018-03. During the backfill
  (run 37312125168, 2026-10-05, dispatched with `debug`): `fct_summary` 460 s,
  `fct_summary_daily` 79 s, `fct_curtailment` 67 s, nearly all of it the model's SELECT, not
  the MERGE (10 s on `fct_summary`). If they stay there with one new day to write, it is a
  problem: `whole_days` reads all of `fct_scada` to find the whole days, and
  `fct_summary_daily` filters `fct_summary` with a subquery, not constants (not measured
  whether the scan skips files on it). A pre-hook that puts the days to write in a variable,
  as the fact models do with their files, would make the filter constants, but first find
  out whether duckdb-iceberg skips data files on a filter at all: in Import Data the copy of
  the newest 14 days (1.1M rows of `fct_summary`, `WHERE date >= ...`) takes 28 s and the
  copy of all four tables whole (162M rows) 32 s, about 10 s of each being start-up
  (2026-10-05, before the first compaction of these tables). If it does not, the days have
  to come from a small table instead of a filter on a big one.

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
