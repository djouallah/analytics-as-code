-- The files each landing fact has loaded: (model, csv_filename, processed_at), appended by
-- the fact's post-hook once its batch's MERGE has committed
-- (macros/record_processed_files.sql). The pending check of every fact is the archive log
-- minus this table (macros/pending_archive_files.sql): two small tables, where until
-- 2026-10-06 it was the log minus the fact's own `file` column, a full scan of the fact
-- over OneLake twice per model per run (fct_scada: 80-175 s each) to find, most runs,
-- nothing to do.
--
-- A reset row (csv_filename NULL) for a model, appended by scripts/rebuild_table.py after
-- it drops that fact, makes every file older than it pending again: a rebuild refills the
-- fact from the archive at process_limit files per run, as before.
--
-- The first build seeds it from the facts' `file` columns, once: a table missing (the ci
-- target, a fresh catalog) contributes nothing, and its files are pending, as they should
-- be. No ref() to the facts: their hooks ref this table, and a ref back would be a cycle;
-- the facts run after it because of those hooks. Incremental runs send nothing here
-- (macros/nothing_to_do.sql): the hooks write the rows. rebuild=processed_files drops it and
-- the next run reseeds it.
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    schema='landing'
) }}

{%- set facts = ['fct_scada', 'fct_price', 'fct_scada_today', 'fct_price_today',
                 'fct_regionsum_today', 'fct_interconnector_today', 'fct_rooftop_pv'] %}

{% if is_incremental() %}
{{ nothing_to_do() }}
{% else %}
SELECT
  CAST(NULL AS VARCHAR) AS model,
  CAST(NULL AS VARCHAR) AS csv_filename,
  CAST(NULL AS TIMESTAMPTZ) AS processed_at
WHERE FALSE
{%- if execute %}
{%- for name in facts %}
{%- set rel = adapter.get_relation(database=this.database, schema=this.schema, identifier=name) %}
{%- if rel %}
UNION ALL
SELECT '{{ name }}', file, now()
FROM (SELECT DISTINCT file FROM {{ rel }})
{%- endif %}
{%- endfor %}
{%- endif %}
{% endif %}
