# What this project taught

Written on 2026-10-07 by the AI agent that wrote the code, at the owner's request. It covers
about 600 commits (2026-03-11 to 2026-10-07) and the corrections that came with them. Every
line of code here was written by AI. These notes are about where that worked, where it
didn't, and what would make each stage better: ingestion, storage, modelling, the semantic
model, serving and the clients.

[AGENTS.md](AGENTS.md) says how things are. This file says what they cost and what was
learned. Where the two overlap, AGENTS.md is the reference.

## The short version

1. **A durable archive plus an append-only log removes reconciliation code.** An interrupted
   run is just picked up by the next one.
2. **A catalog that refuses an upsert in one commit shapes everything downstream.** OneLake
   takes a DELETE, but not a commit that mixes delete files with data files. Hence
   insert-only merges, values that are never revised, rebuilds by DROP and CTAS. Probe the
   catalog's write path and design for it from day one.
3. **Decide time semantics on day one.** A wall-clock time stored as UTC is now a rule every
   reader has to follow forever, because fixing it at the writer means rebuilding seven
   facts.
4. **One `NULL` in a `NOT IN` silently stops a pipeline, or makes a test permanently
   green.** `NOT EXISTS` always.
5. **An engine that can't prune on a subquery makes you write dates as literals.** That
   trick took the mart step from 16 minutes to 3.5.
6. **Direct Lake has no views, so every table a reader needs is a dbt model.** The rules
   move out of the export and into the models, and the import becomes a plain copy.
7. **A measure written once, read by every client, is the point of a semantic model, and
   the hardest thing to keep.** The client always has a shortcut that works locally.
8. **There is no open-source language and runtime with DAX's semantics.** Without one, a
   client's "semantic layer" is SQL with WHERE clauses, and an AI agent drifts to it even
   when told not to.
9. **Prose rules slow an agent down. Mechanical checks stop it.** What stopped the drift
   was a second engine running the same DAX, not the instructions.
10. **Testing stays human.** Every serious drift here passed every automated check and was
    caught by the owner.

## 1. Ingestion and ETL

### What worked
- **Archive first, then load.** A dbt Python model downloads AEMO's files and archives them,
  gzipped, to OneLake `Files/`, with a durable log (`Files/csv_archive_log.parquet`). Because
  the archive outlives the runner, there is no reconciliation code: a run that dies halfway
  leaves nothing to repair.
- **Work comes from the log, not from a glob.** Each fact's pre-hook asks the log which files
  it hasn't processed yet. DuckDB's `read_csv` takes a constant list or a glob, not a
  subquery, and a glob lists the whole folder whatever the filter, so the list goes through
  a DuckDB `VARIABLE`.
- **A table of processed files instead of an anti-join on the fact.** Until 2026-10-06 the
  "what is pending" check compared the log to the fact's own `file` column: a full scan of
  `fct_scada` over OneLake, 80-175 s, twice per model per run, usually to find nothing.
  `landing.processed_files` replaced it, and a fact with nothing to do now takes 5 s.
- **Self-gated on the data, not on a schedule.** No daily or intraday split: every hourly
  pass does every feed, and a backfill runs only when AEMO returned fewer new files than the
  limit.
- **A source that fails skips itself, not the run.** Every fact `ref`s the download model,
  so one unreachable site would otherwise skip all seven facts. A failed write to OneLake
  still raises.

### What it cost (each one a bug that shipped first)
- **`NOT IN` against a column holding a `NULL` returns nothing.** One NULL `file` would have
  stopped every load. In the sibling repo the same pattern makes the completeness tests
  permanently green.
- **`MERGE` dedupes against the target, never within a batch.** The log is append-only and
  can list a file twice, so without a `DISTINCT` a backlog is read 2-N times and turns into
  duplicate keys.
- **Appending the whole log every run.** The log table grew by its own size 48 times a day
  until the OneLake catalog answered HTTP 500 to every load and commit. Now only the missing
  rows are appended, and the parquet file is the source of truth: the Iceberg table can be
  rebuilt from it.

### Could be better
- **Downloading lives inside dbt.** It makes dbt the orchestrator of I/O to third-party
  sites. The sibling repo downloads outside dbt and reads the log straight from parquet,
  which is simpler to reason about.
- **The file list goes through a `VARIABLE`** because DuckDB has no "scan these files from a
  manifest" (asked upstream in duckdb/duckdb-aws-glue#37). A manifest scan would remove the
  pre-hooks.
- **The empty `MERGE`.** A fact with no new file still builds its temp table and runs a MERGE
  (5-7 s each, seven facts a run). Skipping it needs a custom incremental strategy.
- **Intraday tables are never trimmed.** The catalog takes a DELETE, but the pipeline was
  designed never to need one. Their scans are bounded now, but the tables grow by a month of
  intervals a month. A scheduled DELETE of the rows older than the newest daily date, with a
  re-count to confirm it landed, would trim them.
- **The refill path is not exercised by CI.** The next `rebuild=` of a mart fact is the
  first time it runs on the real catalog.

## 2. Storage: Iceberg on the OneLake REST catalog

### What worked
- **One persistent layer.** The catalog and the archive next to it are the only state. The
  runner, dbt and DuckDB are ephemeral, and nothing depends on a server or on the runner's
  disk.
- **OIDC, no secrets.** Every job mints a short-lived storage token from a federated
  credential. The one real secret is the gh-pages deploy token.
- **A capability probe as evidence.** CREATE/INSERT/DELETE/UPDATE/MERGE/DROP against a
  fresh table, kept in a separate repo. Claims about what the catalog does are checked
  against its matrix, not remembered.

### What it cost
- **One add-snapshot per commit; a commit mixing delete files with data files is rejected
  (400).** A DELETE on its own is accepted. What is refused is an upsert: a `MERGE` that
  updates matched rows. Every write became an insert-only merge (`WHEN MATCHED DO NOTHING`),
  and the consequences go all the way to the dashboard:
  - a stored value is never revised, so a late correction from AEMO never lands;
  - `dim_duid`'s attributes never change in place, so a changed rule needs a
    `rebuild=dim_duid`;
  - a rebuild is a scripted DROP and a CTAS that refills at `process_limit` files per run;
  - `dbt run --full-refresh` is off-limits, because dbt-duckdb RENAMEs a temp table into
    place and RENAME was never probed.
- **The time zone.** `SETTLEMENTDATE` is AEST wall clock, stored as a TIMESTAMPTZ labelled
  UTC, so the instant is 10 hours early. The `date` and `time` columns next to it are right.
  Every reader must run its session in UTC, and fixing it at the writer means rebuilding all
  seven facts. A day-one decision that is now a rule forever.
- **Two DuckDB lines at once.** A 2.0 pre-release writes the catalog (because compaction
  needs `iceberg_rewrite_data_files()`, not yet in a stable release). 1.5 writes the files
  the browser reads, because DuckDB-WASM is on 1.5 and the file format must match. Parquet
  is the handoff, because 1.5 can't read tables that 2.0 compaction rewrote.
- **Maintenance needs two tools.** Compaction is DuckDB. Snapshot expiry is pyiceberg,
  because duckdb-iceberg has no `expire_snapshots` yet, and the pyiceberg script reaches
  into a private attribute in case the catalog doesn't advertise the commit endpoint.
  Maintenance must never fail its workflow, so a compaction that has stopped working shows
  only in a log.

### Could be better
- **A catalog that accepts a `MERGE` with updates in one commit** would remove most of the
  workarounds above: corrections and attribute updates. Until then, a DELETE commit followed
  by an INSERT commit could do a correction. It is not atomic, so it needs a re-count after
  each step.
- **Write the instant correctly from the start** (a TIMESTAMP in the market's zone, or
  real UTC) and the "every reader in UTC" rule disappears.
- **One DuckDB version end to end** once 2.0 is stable and DuckDB-WASM follows.
- **An alert when compaction or expiry stops doing anything**, not just a log line.

## 3. Modelling the mart

### What worked
- **Every table a reader needs is a dbt model.** The raw facts can't be read by Direct Lake
  as they are: two dispatch runs, an interval under two files, regional data over three
  tables, no curtailment table. Direct Lake has no views to fix that in. So the rules that
  used to live in the export (`INTERVENTION = 0`, 0 MW rows out, one row per key, `MWFLOW`
  for interconnectors, energy as `SUM(mw) / 12`) became models in `mart`, and the import
  became a copy with no logic.
- **Shape for the query, not for normal form.** MW and price sit on one row at 5 minutes
  (`fct_summary`), because joining two facts at query time was too slow.
- **Aggregates are tables, written once when whole.** A day is written when its 288
  intervals exist, a month when its days do. "Whole" is a property of the row, not a filter
  every reader has to repeat.
- **Dates from the Iceberg manifests, written into the SQL as literals.** duckdb-iceberg
  prunes data files on a constant `DATE` filter, not on a subquery (`MAX(DATE) FROM ...`).
  Reading `MIN`/`MAX` from the manifests and writing the chosen dates as literals took
  `fct_summary` from 450-700 s to 47 s, and the mart step from 16 minutes to 3.5.
- **Sort order is storage.** `fct_summary` is written by date, time, price, DUID: the price
  is the region's, so in that order the column is runs and costs nothing. In key order the
  files were 60% larger, and the site has a 1 GB ceiling.

### Could be better
- **The literal-dates trick works around the engine.** Pruning on a runtime value (dynamic
  filter pushdown into Iceberg manifests) would make a plain `WHERE date > (SELECT MAX ...)`
  as cheap, and the macros could go.
- **`fct_region` is recomputed whole every run** (4.5M rows). It is cheap today but scales
  with history.
- **Insert-only means "first value wins".** The intraday feed lands first and the next-day
  files only add missing keys, so `fct_summary` holds a mix of two AEMO columns from two
  reports. That is documented, but a reader comparing with AEMO's settled data will see it.

## 4. The semantic model and measures

### What worked
- **One model, the file Power BI runs.** `semantic_model/model.bim` (TMSL) is deployed to
  Fabric in Direct Lake over the `mart` tables, and the page writes its queries in DAX
  against the same file. A measure is defined once.
- **A quantity is one measure, and the measure picks the table.** Direct Lake has no
  user-defined aggregations, so the switch is DAX: `IF([Reads 5 minutes], 5-minute table,
  daily table)`. It is not only a VertiPaq optimisation: it is what lets the browser ask the
  same measure over ten years, where it can't hold the 5-minute rows. It was removed once,
  for a few hours, because it looked unnecessary from Power BI's side alone; judged by all
  clients, it stays.
- **Aggregates store the sums the 5-minute measure sums.** `output_mwh`, `charging_mwh`,
  `revenue` per day, so either table gives the same number. A day's net energy and its
  average price are not the same figures (a battery's day nets out), and no measure reads
  them.
- **An average MW is energy over hours** (`[Hours]`, nights included), not an average of
  intervals that happen to have rows.
- **Parity before the port.** The model was compared with the old dashboard's files at
  every grain it draws: 25,737 values equal, none different (2026-10-05).

### What it cost
- **Every mistake in a measure cost a deploy.** A measure that didn't parse because of its
  variable names (which one was never found out). A fixed-decimal division that kept 4
  decimals. A `CALCULATE` filter on one column of a dimension that left the query's filter
  on another column in place. A recreated table that Direct Lake couldn't see for about 7
  minutes.
- **The REST query API refuses a service principal on this model** (401). The check runs
  its DAX over XMLA instead, through ADOMD.NET under pythonnet on a Linux runner.

### Could be better
- **A local DAX engine for tests.** There is no way to evaluate a measure before deploying
  it, so the feedback loop is a deploy plus a refresh. That is the biggest gap in the whole
  workflow.
- **The model is a vendor format.** TMSL is open JSON, but only one engine runs it. The
  browser path needs a hand-written compiler to read it (next section).
- **JSON has no comments**, so the why of a measure goes in its `description`, and a long
  expression is an array of lines. Readable, but a real source format would be better.

## 5. Serving

### What worked
- **The import is a copy.** `scripts/cache_catalog.py` does `SELECT *` per table into
  `.duckdb` files and only decides the split: a half-year per file (GitHub's 100 MB limit),
  the newest 14 days hourly, the dimensions and aggregates whole.
- **The browser is the server.** DuckDB-WASM, single-threaded, files downloaded whole into
  OPFS and attached in place.
  - Reading a remote file in place costs three round trips per block, and OneLake answers
    one in about 700 ms: one 2024 day took 38 s that way. Downloading whole is faster.
  - The threaded build couldn't load ICU (so no `SET TimeZone`) or share the OPFS handle,
    and gained only about 1.4x.
  - An `opfs://` ATTACH also opens a `.wal` that was never registered, so the plain
    filename is registered instead.
- **The compiler is a toy on purpose.** `compiler.js` turns the model into views and the
  page's DAX into one SQL query per question, by fixed cases, and throws on anything it
  doesn't know. Throwing is what kept fixes going into the language and not around it.
- **Performance comes from what the compiler writes**, measured in the browser:
  - a measure from another fact as a CTE read once: 0.25 s against 1.3 s inline;
  - capacity per unit in two levels: 0.8 s against 2.7 s;
  - `MAX(col, 0)` read as DOUBLE, not a 128-bit decimal: 335 ms against 623 ms.

### What it cost
- **The site is near GitHub Pages' 1 GB limit**: about 880 MB, growing about 125 MB a year.
  The real question is where the 5-minute history lives, and that is a decision, not code.
- **The deploy repo is redeployed every hour**, and its history grew by gigabytes a week.
  It is squashed to one commit weekly.
- **The compiler had to implement, by hand, everything DAX gives for free**: measures
  inlined at every use; a filter reaching another fact only along relationships (one
  subquery per fact, with only the filters that reach it); `ISFILTERED` answered from the
  query's columns so the grain switch works; `KEEPFILTERS`; blank against NULL.

### Could be better
- **An open semantic runtime would delete the compiler.** See section 9.
- **Another host for the half-year files**, or 5-minute history for recent years only.
- **Two `data.js` files with the same members** are fine, but a third (VertiPaq) shows the
  interface is the real contract. It could be written down as one.

## 6. Clients

### What each one proved
- **The GitHub page** is public and must never break, so every shared change is checked
  there first.
- **The Fabric app on DuckDB-WASM** proved the host is just `storage/data.js`: the same page
  reads a lakehouse behind a sign-in with a short-lived read-only SAS, and the browser
  never holds a storage token.
- **The Fabric app on VertiPaq** sends the page's DAX to the deployed model as written.
  Requiring it forced the page's DAX to be checked against real DAX semantics, which found
  two queries that were right only through the compiler (`KEEPFILTERS` on a filter by the
  grouped fuel; a unit attribute grouped by the fact's column). It has never run in a
  browser.
- **The Power BI report** (PBIR, a JSON file per visual) holds no measure of its own. No CI
  sees a chart draw: a change to a visual is checked by opening it.

### What it cost
- **Preview platform features decided the architecture.** Rayfin lets only an item's owner
  deploy to it. An item owned by a service principal answers 500 to every function call
  (microsoft/rayfin#89). Fabric apps aren't available in Australia Southeast, where the
  model's capacity is. Three blockers, none fixable from this repo.

### Could be better
- **Deploy everything from CI.** The DuckDB-WASM Fabric app is still deployed from a laptop
  because of rayfin#89.
- **Run the VertiPaq client in CI** against the deployed model, with the page's queries, and
  compare its rows with the compiler's. That would turn "the page's DAX is DAX" from a rule
  into a check.

## 7. Verification

### What worked
- **A `ci` target on plain DuckDB** that downloads real files (two per feed) and runs every
  model and test: broken SQL never reaches the catalog.
- **Tests that can actually fail.** The `relationships → dim_duid` test on the facts could
  never be zero (history back to 2018, units only ever at 0 MW), so it was replaced by
  `assert_recent_scada_duids_registered`. A test that is always red is as useless as one
  that is always green.
- **The dashboard check:** the page before and after, in headless Chrome, on one copy of the
  deployed files. It compares what each chart draws (its ECharts series) and the SQL that
  ran, reads `EXPLAIN` for a new join, and times old against new alternately in the same
  page (two sessions differ by more than most changes).
- **`check_model.py` at every model deploy:** a refresh, a row count per table, each
  measure per day, the grain switch timed (0.43 s from the daily table, 1.9 s from the
  5-minute one, the same total).

### What only a human caught
- The page working out its own figures instead of calling the measures (twice).
- A grain switch that always took the same branch.
- DAX that was right only through the compiler.
- Hand-made rows proposed to fill a data gap; a failing piece proposed for deletion instead
  of a fix.
- Layout regressions: a page that scrolled, a legend that moved on hover.

Every one of these passed the automated checks. The checks compare a figure before and
after; none asks where the figure is defined.

### Could be better
- **A lint on the page:** fail when `index.html` does arithmetic on measure results or
  names a view outside the Analyze tab.
- **Golden DAX queries through both engines:** the page's queries run by the compiler and
  by the deployed model, rows compared. That is the real test of the compiler, and today it
  doesn't exist.
- **The layout measured, not eyeballed:** element boxes before and after a hover or drag.

## 8. Working with an AI agent

### The drift
The rule since 2026-10-05: the page writes DAX, every figure is a measure of the model, and
the page only groups, filters and names measures. The history after that:

| When | What happened |
|---|---|
| 10-05 | The page "queries the model in DAX" |
| 10-06 morning | Six figures still worked out in the page, now made measures |
| 10-06 morning | Again: what the model can express, the page now asks the model for |
| 10-06 late morning | Page DAX that real DAX would answer differently, fixed |
| 10-07 | Each chart's DAX had been scattered through its renderer, gathered at the top of the page |

Why it happened, even with the rule written down:
- **The agent works chart by chart; the rule is about the whole page.** "The chart draws the
  right number" is the finish line of each task, and JS arithmetic reaches it faster than
  extending the compiler.
- **SQL dressed as DAX.** The compiler's founding choice, "a filter is a boolean argument of
  `CALCULATETABLE`; there is no filter context", is WHERE-clause thinking in DAX syntax.
  The page's DAX was then written to fit the translation, not DAX.
- **The checks couldn't see it.** They compare a figure, not where it is defined.

What stopped it was a mechanical constraint: a second engine that runs the same DAX, where
SQL-dressed DAX gives different answers.

### Other patterns
- **Working around instead of through.** Proposing hand-made rows for a gap, improvising
  when a tool's documented path failed, theorising before searching the tool's issue
  tracker, deleting what fails instead of diagnosing it. Each is now a standing rule.
- **Diagnosing from inference.** A root cause has to rest on a CI log, a test or the git
  history, not on what a table "probably" holds.
- **Scope creep in plans.** A SQL query often beats a built feature.

### What the instruction file became
`AGENTS.md` is about 860 lines, and it is the real specification. It records not only how
things are but why, with dates and the owner's words when a rule came from a correction.
That provenance stops a later session from undoing a decision it doesn't understand: the
grain switch, the `NOT EXISTS`, the literal dates. The cost is that it only grows, and a
prose rule is only as good as the agent's attention on the day.

### Could be better
- **Turn each prose rule into a check where possible** (the lint, golden queries, layout
  measurements). An instruction slows drift; a failing check ends it.
- **Keep testing human.** An agent's tests match the agent's model of the code. Here, the
  owner's review was the test that mattered.

## 9. What SQL would need

The drift has a structural cause: there is no open-source language and runtime with DAX's
semantics, so SQL with WHERE parameters is always the shortest path. These are the five
things SQL would need for the right path to also be the easy one, each mapped to what it
would remove from `compiler.js`:

1. **Measures in the catalog.** `CREATE MEASURE fct_summary.capacity_factor AS ...`,
   called by name from any query and evaluated in that query's context. *Removes:* inlining,
   and the reason a client does its own division.
2. **Relationships that carry filters.** Declared once; a filter on a dimension reaches
   every related fact, and a filter on one fact's column stays on that fact. *Removes:* the
   per-fact subqueries and `whereAll`, the most hand-written part of the compiler.
3. **Context modifiers.** Calcite's `AT` ("Measures in SQL", Hyde, 2024):
   `revenue AT (SET date = date - 1)`, `AT (ALL region)`, `AT (VISIBLE)`. *Removes:*
   `KEEPFILTERS` and previous-period queries built in the page.
4. **Grain inside the measure.** "Sum capacity per unit that has rows, then roll up", and
   aggregate tables declared to the engine so it routes to the daily table on its own.
   *Removes:* `perUnit`, `[Reads 5 minutes]`, the `ISFILTERED` answers, `wholeDays`.
5. **A query surface for visuals:** group, filter, name measures, and nothing else. No
   arithmetic on measure results, and filters bound as structured values, not concatenated
   strings. *Removes:* the drift itself. If a visual query can't divide two measures, the
   only way through is a measure in the model.

A chart's query would then be:

```sql
SELECT region, date, capacity_factor, renewable_share,
       revenue AT (SET date = date - 1) AS revenue_prev
FROM SEMANTIC nem
WHERE date BETWEEN ? AND ?          -- reaches every fact through relationships
GROUP BY region, date;
```

Points 1 to 4 make the right path easy. Point 5 makes the wrong one impossible. Calcite's
proposal covers 1, 3 and part of 4 as a paper; Malloy, dbt MetricFlow and Cube cover pieces
of 1 and 2. None ships all five in an embeddable engine. DuckDB would be the natural home:
it already runs in the browser.

## 10. If starting again

- Decide the time semantics of every timestamp before the first write.
- Probe the catalog first (the capability matrix), and design the write path around what
  it refuses.
- Put the rules in the models from the start; make the import a copy from the start.
- Write the semantic model before the first chart, and have the first chart call a measure.
- Run two engines on the same queries from the first day: the second engine is the test.
- Write the page lint and the golden queries before the page grows.
- Keep the AGENTS.md habit of dates and reasons. Turn what can be checked into checks.

## 11. Still open

Carried over from the former `TODO.md`; the rest of it is in the "Could be better" lists
above.

**Waiting on upstream**
- OneLake accepting a commit that mixes delete files with data files (fixed upstream,
  rolling out): re-run the capability probe, and once a `MERGE` with `WHEN MATCHED UPDATE`
  passes, the merges no longer have to be insert-only. AEMO's late corrections can land,
  `dim_duid` can update in place, `fct_summary` can take the next-day value over the
  intraday one, and AGENTS.md's "insert-only" sections change with it.
- DuckDB 2.0.0 stable (due 2026-10-21): replace `2.0.0.dev2609250715` everywhere it is
  pinned and re-run the capability probe against it.
- A duckdb-wasm build on DuckDB 2.0: move the dashboard and the import's write venv together.
- duckdb-iceberg#1341 (snapshot expiry): replace pyiceberg in `scripts/expire_snapshots.py`.
- microsoft/rayfin#89: deploy the DuckDB-WASM Fabric app from CI (`deploy_fabric.yml`,
  `app=wasm`, item `nemtracker`).
- AEMO publishing `ROOFTOP_PV_ACTUAL_PRED`/`_RUN`: move `fct_rooftop_pv` to the 5-minute
  estimate.

**Ideas**
- `rebuild=dim_duid` once the corrected `duid_unregistered.csv` (TORRB1, ADPBA1L) has been
  downloaded.
- Interconnectors from the data: a `dim_interconnector` from MMSDM `INTERCONNECTOR` instead
  of the names typed in `index.html`.
- Emissions: CO2 factor per unit from `GENUNITS`/`DUALLOC`; a unit without a factor stays
  out.
