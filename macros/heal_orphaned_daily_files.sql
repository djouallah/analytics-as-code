{% macro heal_orphaned_daily_files(max_force=20) %}
{#
  Self-heal a log<->fact desync: find `daily` rows in stg_csv_archive_log whose file never
  actually landed in fct_scada / fct_price, and arrange for them to be downloaded and
  reprocessed on the pass that follows.

  Without this, an orphaned marker is permanently undownloadable, because the dedup in
  stg_csv_archive_log.py skips anything already logged -- so the hole in the fact table
  never closes and assert_all_daily_files_processed_scada/price stay red forever.

  WHY THIS NO LONGER DELETES THE MARKER

  It used to just DELETE the marker and trust the dedup to re-discover the file. That never
  worked. Four consecutive daily passes (runs 32291425738 / 32407578561 / 32517194584 /
  32592795274) each logged "1 orphaned ... deleted 1" and then "Daily files: 0 new", while
  the `daily` row count still climbed +1/day -- exactly the one new AEMO file, with no
  decrement for the delete. The orphan (PUBLIC_DAILY_202604130000_20260414040503) *is*
  present in the GitHub archive, so had the row really gone, the backfill 30 seconds later
  would have picked it up. DELETE against this Iceberg table reports success but does not
  remove the row when the predicate contains subqueries over other Iceberg tables.

  Deleting was the wrong move regardless. The marker is not the problem -- it is the
  *evidence*. It only blocks the re-download, and that is now solved directly: we write the
  orphaned source_filenames to $ROOT_PATH/force_download.txt and stg_csv_archive_log.py
  downloads exactly those, ignoring the dedup. Once the file is reprocessed the marker is
  valid again and the assert goes green on its own. Had we deleted it and the file turned
  out to be ungettable (pulled upstream, say), the test would have gone green over a
  permanent hole in fct_scada. So this macro is now purely additive: detect, name, hand off.

  Whether Iceberg DELETE works on this table is still worth knowing; the duid_* cleanup in
  stg_csv_archive_log.py reports before/after counts on this same table every daily pass.

  Run this BEFORE the main `dbt run` (against prod) so the force list is in place when the
  staging model runs.
#}

  {% set log_rel = load_relation(ref('stg_csv_archive_log')) %}
  {% set scada_rel = load_relation(ref('fct_scada')) %}
  {% set price_rel = load_relation(ref('fct_price')) %}

  {% if log_rel is none or scada_rel is none or price_rel is none %}
    {{ log("heal_orphaned_daily_files: log/fact tables not present yet, skipping", info=True) }}
  {% else %}

    {#- NOT EXISTS, not NOT IN: a single NULL `file` in either fact table would make a
        NOT IN predicate evaluate to NULL for every row, silently finding zero orphans. -#}
    {% set find_sql %}
      SELECT DISTINCT l.source_filename, l.csv_filename
      FROM {{ log_rel }} l
      WHERE l.source_type = 'daily'
        AND (
          NOT EXISTS (SELECT 1 FROM {{ scada_rel }} f WHERE f.file = l.csv_filename)
          OR NOT EXISTS (SELECT 1 FROM {{ price_rel }} f WHERE f.file = l.csv_filename)
        )
      ORDER BY 1
    {% endset %}
    {% set orphans = run_query(find_sql).rows %}

    {{ log("heal_orphaned_daily_files: " ~ orphans | length ~ " orphaned daily log entries", info=True) }}

    {% if orphans | length > 0 %}
      {% for row in orphans %}
        {{ log("  orphaned: " ~ row[1], info=True) }}
      {% endfor %}

      {#- Cap the force list. A mass-orphan event (a bad compaction, say) should not turn the
          next pass into a thousand-file download; heal the first batch and let subsequent
          passes work through the rest. -#}
      {% set forced = orphans[:max_force] %}
      {% if orphans | length > max_force %}
        {{ log("heal_orphaned_daily_files: capping force list at " ~ max_force ~ " of "
               ~ orphans | length ~ "; the remainder heal on later passes", info=True) }}
      {% endif %}

      {% set force_path = get_root_path() ~ '/force_download.txt' %}
      {% set force_values %}
        {%- for row in forced -%}
          {% if not loop.first %}, {% endif %}('{{ row[0] }}')
        {%- endfor -%}
      {% endset %}
      {% set write_sql %}
        COPY (SELECT * FROM (VALUES {{ force_values }}) v(source_filename))
        TO '{{ force_path }}' (FORMAT CSV, HEADER)
      {% endset %}
      {% do run_query(write_sql) %}
      {{ log("heal_orphaned_daily_files: wrote " ~ forced | length ~ " entries to "
             ~ force_path ~ "; they re-download on this pass", info=True) }}
    {% endif %}
  {% endif %}

{% endmacro %}
