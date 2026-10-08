{#-- The archived files a fact model still has to read: the log minus processed_files. One
     definition for every fact model's pre-hook and its "anything to do?" check.

     - Both sides are small tables. Until 2026-10-06 the anti-join was against the fact's own
       `file` column, a full scan of the fact over OneLake (fct_scada: 300M rows, 80-175 s),
       and it ran twice per model per run (the count, then the SET VARIABLE) to find, most
       runs, nothing to do. processed_files is appended by the fact's post-hook
       (macros/record_processed_files.sql) once its batch's MERGE has committed.
     - A file is processed once its batch committed, whether or not it yielded a row. Before,
       a file that yielded no row (an empty file, a record version the model doesn't select)
       was read again every run forever. The assert_all_*files_processed_* tests still
       compare the log to the fact's `file` column, so a file the fact lacks is still seen.
     - A rebuild=<table> appends a reset row (csv_filename NULL) for the model
       (scripts/rebuild_table.py): only files processed after it count, so the refill starts
       over at process_limit files per run.
     - NOT EXISTS, not NOT IN: a single NULL would turn `NOT IN` into "never true".
     - DISTINCT is load-bearing: the log is append-only and can list a file more than once,
       and MERGE dedupes against the target, never within a batch.
     - ORDER BY archive_path DESC before LIMIT (ported from the sibling's new_source_files):
       a backlog or a rebuild=<table> refill takes the newest files first, deterministically,
       instead of an arbitrary process_limit subset. It is the path that is ordered: newest
       first within a source folder, and one folder after the other for a model that reads
       several (rooftop_weekly, then rooftop_today, then rooftop_monthly).
     - source_type is one type or a list of them (fct_interconnector_today reads the
       DispatchIS files and the monthly archive). --#}

{% macro processed_files_reset(model_name) -%}
COALESCE((SELECT MAX(processed_at) FROM {{ ref('processed_files') }}
          WHERE model = '{{ model_name }}' AND csv_filename IS NULL),
         TIMESTAMPTZ '1900-01-01 00:00:00+00')
{%- endmacro %}

{% macro pending_archive_filter(log_relation, source_type) -%}
{%- set source_types = [source_type] if source_type is string else source_type -%}
FROM {{ log_relation }} l
WHERE l.source_type IN ('{{ source_types | join("', '") }}')
  AND NOT EXISTS (
    SELECT 1 FROM {{ ref('processed_files') }} p
    WHERE p.model = '{{ this.identifier }}'
      AND p.csv_filename = l.csv_filename
      AND p.processed_at > {{ processed_files_reset(this.identifier) }}
  )
{%- endmacro %}

{% macro set_pending_archive_paths(var_name, log_relation, source_type) -%}
SET VARIABLE {{ var_name }} = (
  SELECT COALESCE(NULLIF(list('{{ get_csv_archive_path() }}' || archive_path), []), [''])
  FROM (
    SELECT DISTINCT l.archive_path
    {{ pending_archive_filter(log_relation, source_type) }}
    ORDER BY l.archive_path DESC
    LIMIT {{ env_var('process_limit', '1000') }}
  )
)
{%- endmacro %}

{% macro pending_archive_count(log_relation, source_type) -%}
SELECT COUNT(*) AS cnt
{{ pending_archive_filter(log_relation, source_type) }}
{%- endmacro %}

{#-- The mart tables' pending files (2026-10-08): the same rule one level up. A mart reads
     landing facts, and what it can have to write is what their newly loaded files hold. Until
     then fct_region and fct_summary recomputed six days and fct_interconnector, fct_rooftop
     and fct_curtailment_region all their history every hour, mostly to write nothing.

     - A mart's watermark is a row of processed_files: model = the mart, csv_filename NULL,
       processed_at = the newest processed_at of its upstream facts' rows when it last
       committed. record_mart_watermark appends it, as the mart's post-hook, once its MERGE
       has committed. A run that fails before that leaves the files pending for the next.
     - Pending: the upstream rows processed after the watermark. A file a landing fact reads
       again (its rebuild=<fact> refill) is pending again for the marts.
     - No watermark (the first run with this, or processed_files rebuilt): the mart recomputes
       `otherwise` once, what it recomputed every run before (fct_summary: six days; the
       others: everything), and its post-hook records the watermark.
     - The dates a file covers, from its name: a next-day file PUBLIC_DAILY_<D> covers D and
       D+1 (it runs 04:05 to 04:00); an intraday file (..._<YYYYMMDDHHMM[SS]>_<id>) its day;
       a weekly rooftop archive (..._MEASUREMENT_<D>) D-1 to D+7; a monthly MMSDM archive its
       month and the next day. A name that matches none of these makes the mart recompute
       `otherwise`, with a warning.
     - `before`/`after` widen every file's days, for a mart whose row reads a neighbouring
       day (fct_rooftop's half hour ending 00:00 averages the five intervals before it).
     Returns [(from, to)] like pending_day_ranges ([] when nothing is pending, the mart then
     renders nothing_to_do()); [(none, none)], everything, outside a run. --#}
{% macro pending_file_ranges(upstream, before=0, after=0, otherwise=[(none, none)]) -%}
  {%- set processed = ref('processed_files') -%}
  {%- if not execute or flags.WHICH not in ('run', 'build', 'retry') -%}
    {{ return([(none, none)]) }}
  {%- endif -%}
  {%- set models = "'" ~ (upstream | join("', '")) ~ "'" -%}
  {%- set sql -%}
    WITH
    watermark AS (
      SELECT MAX(processed_at) AS wm_at FROM {{ processed }}
      WHERE model = '{{ this.identifier }}' AND csv_filename IS NULL
    ),
    files AS (
      SELECT DISTINCT csv_filename AS f
      FROM {{ processed }}
      WHERE model IN ({{ models }}) AND csv_filename IS NOT NULL
        AND processed_at > (SELECT wm_at FROM watermark)
    ),
    spans AS (
      SELECT f,
        CASE
          WHEN regexp_matches(f, '^PUBLIC_DAILY_\d{12}_')
            THEN [strptime(substr(f, 14, 8), '%Y%m%d'), strptime(substr(f, 14, 8), '%Y%m%d') + INTERVAL 2 DAY]
          WHEN regexp_matches(f, '^PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_\d{8}$')
            THEN [strptime(right(f, 8), '%Y%m%d') - INTERVAL 1 DAY, strptime(right(f, 8), '%Y%m%d') + INTERVAL 8 DAY]
          WHEN regexp_matches(f, '(DVD_|ARCHIVE).*\d{6}010000$')
            THEN [strptime(regexp_extract(f, '(\d{6})010000$', 1), '%Y%m'),
                  strptime(regexp_extract(f, '(\d{6})010000$', 1), '%Y%m') + INTERVAL 1 MONTH + INTERVAL 1 DAY]
          WHEN regexp_matches(f, '_\d{12}(\d{2})?_\d+$')
            THEN [strptime(regexp_extract(f, '_(\d{8})\d{4}(\d{2})?_\d+$', 1), '%Y%m%d'),
                  strptime(regexp_extract(f, '_(\d{8})\d{4}(\d{2})?_\d+$', 1), '%Y%m%d') + INTERVAL 1 DAY]
        END AS span
      FROM files
    )
    SELECT CAST(d AS DATE) AS d, NULL AS unknown
    FROM (
      SELECT unnest(generate_series(span[1] - INTERVAL {{ before }} DAY,
                                    span[2] + INTERVAL {{ after }} DAY - INTERVAL 1 DAY,
                                    INTERVAL 1 DAY)) AS d
      FROM spans WHERE span IS NOT NULL
    )
    GROUP BY 1
    UNION ALL
    SELECT NULL, f FROM spans WHERE span IS NULL
    UNION ALL
    SELECT NULL, '' FROM watermark WHERE wm_at IS NULL
    ORDER BY 1
  {%- endset -%}
  {%- set rows = run_query(sql).rows -%}
  {%- set unknown = [] -%}
  {%- for row in rows if row[1] is not none %}{% do unknown.append(row[1]) %}{% endfor -%}
  {%- if '' in unknown -%}
    {%- do log(this.identifier ~ ": no watermark yet, recomputing " ~ ranges_text(otherwise), info=True) -%}
    {{ return(otherwise) }}
  {%- endif -%}
  {%- if unknown -%}
    {%- do log("::warning::" ~ this.identifier ~ ": " ~ unknown | length ~ " pending file name(s) not understood ("
               ~ unknown[0] ~ "), recomputing " ~ ranges_text(otherwise), info=True) -%}
    {{ return(otherwise) }}
  {%- endif -%}
  {#- Consecutive days into ranges [from, to). #}
  {%- set day = modules.datetime.timedelta(days=1) -%}
  {%- set ranges = [] -%}
  {%- for row in rows -%}
    {%- if ranges and ranges[-1][1] == row[0] -%}
      {%- set lo = ranges.pop()[0] -%}
      {%- do ranges.append((lo, row[0] + day)) -%}
    {%- else -%}
      {%- do ranges.append((row[0], row[0] + day)) -%}
    {%- endif -%}
  {%- endfor -%}
  {%- do log(this.identifier ~ ": pending files of " ~ upstream | join(', ') ~ "; recomputing " ~ ranges_text(ranges), info=True) -%}
  {{ return(ranges) }}
{%- endmacro %}

{#-- A mart's post-hook: its watermark (pending_file_ranges above), the newest upstream file it
     has now read. Outside the model's transaction, like record_processed_files: if this
     INSERT fails, the next run reads the same files again, which the insert-only MERGE
     dedupes. --#}
{% macro record_mart_watermark(upstream) -%}
INSERT INTO {{ ref('processed_files') }} (model, csv_filename, processed_at)
SELECT '{{ this.identifier }}', NULL, MAX(processed_at)
FROM {{ ref('processed_files') }}
WHERE model IN ('{{ upstream | join("', '") }}') AND csv_filename IS NOT NULL
HAVING MAX(processed_at) IS NOT NULL
{%- endmacro %}
