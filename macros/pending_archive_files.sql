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
