{#-- The archived files a fact model still has to read, from the log table. One definition
     for the four fact models' pre-hooks and their "anything to do?" check.

     - NOT EXISTS, not NOT IN: a single NULL `file` in the target turns `NOT IN` into "never
       true", which silently stops every load (the same trap the assert_all_* tests avoid).
     - DISTINCT is load-bearing: the log is append-only and can list a file more than once,
       and MERGE dedupes against the target, never within a batch.
     - ORDER BY archive_path DESC before LIMIT (ported from the sibling's new_source_files):
       a backlog or a rebuild=<table> refill takes the newest files first, deterministically,
       instead of an arbitrary process_limit subset.
     - source_type is one type or a list of them (fct_interconnector_today reads the
       DispatchIS files and the monthly archive). --#}

{% macro pending_archive_filter(log_relation, source_type) -%}
{%- set source_types = [source_type] if source_type is string else source_type -%}
FROM {{ log_relation }} l
WHERE l.source_type IN ('{{ source_types | join("', '") }}')
{%- if is_incremental() %}
  AND NOT EXISTS (SELECT 1 FROM {{ this }} t WHERE t.file = l.csv_filename)
{%- endif %}
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
