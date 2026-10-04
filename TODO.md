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

## Bigger

- [ ] **`rebuild=dim_duid` once the fixed `duid_unregistered.csv` is downloaded** — the file
  in aemo_data now gives TORRB1 "Natural Gas / Fuel Oil" and ADPBA1L "Grid" (from the older
  AEMO list, `duid_data.csv`). The pipeline re-downloads it 24 hours after its last copy
  (2026-10-05 after ~07:15 UTC); `dim_duid` holds the old values until a rebuild after that.
- [ ] **Interconnectors from the data** — the Flows page types each link's two regions and
  its name (`INTERCONNECTORS` in `dashboard/index.html`); the facts carry only the id. AEMO's
  MMSDM `INTERCONNECTOR` table should have them (`REGIONFROM`, `REGIONTO`, a description;
  not checked against the archive): a small `dim_interconnector`, exported with the dims.
- [ ] **Site size** — the deployed data files total about 984 MB against GitHub Pages' 1 GB
  limit, and grow by about 140 MB a year (a half-year file is 65-75 MB). Measured on the
  2026 H1 file (13.0M scada rows): `mw` is 38.5 MB, `time` 26.8 MB, `DUID` 5.5 MB, `date`
  0.8 MB. Storing `time` as hour and minute (two UTINYINT, `data.js` rebuilding HHMM) saves
  13% losslessly; rounding `mw` to 0.1 MW saves a further ~25% but changes the data. Neither
  is enough against the growth: the real choice is where the 5-minute history lives (another
  host for the half-year files, or only recent years at 5 minutes and the rest from the
  daily aggregate). A decision for the owner, not a code change.
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
