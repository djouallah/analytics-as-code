{#-- A fact model's post-hook: record the files its batch just merged in processed_files,
     so that the next run's pending check (macros/pending_archive_files.sql) does not read
     the fact. The batch is the pre-hook's variable; its paths become the same `file` the
     fact stores (parse_filename). Run outside the model's transaction
     (post_hook={"sql": ..., "transaction": false}): the MERGE has committed by then, and
     if this INSERT fails the files stay pending and the next run re-reads them, which the
     insert-only MERGE dedupes. With nothing in the batch (['']) it issues no INSERT, so a
     run with no new file commits nothing to this table. --#}
{% macro record_processed_files(var_name) -%}
{%- if execute -%}
  {%- set paths = run_query("SELECT unnest(getvariable('" ~ var_name ~ "'))").columns[0].values() -%}
  {%- set files = paths | reject('equalto', '') | list -%}
  {%- if files | length > 0 -%}
INSERT INTO {{ ref('processed_files') }} (model, csv_filename, processed_at)
SELECT '{{ this.identifier }}', {{ parse_filename('p') }}, now()
FROM (VALUES {% for f in files %}('{{ f }}'){{ ", " if not loop.last }}{% endfor %}) AS t(p)
  {%- else -%}
SELECT 1
  {%- endif -%}
{%- else -%}
SELECT 1
{%- endif -%}
{%- endmacro %}
