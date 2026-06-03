{% macro heal_orphaned_daily_files() %}
{#
  Self-heal a log<->fact desync: delete `daily` rows from stg_csv_archive_log
  whose file never actually landed in fct_scada / fct_price. Once the marker is
  gone the next daily pass re-downloads (via the GitHub backfill) and reprocesses
  the file, so the data hole closes on its own.

  Without this, a single orphaned marker (a) is permanently undownloadable because
  the dedup in stg_csv_archive_log.py skips anything already logged, and (b) keeps
  the daily assert_all_daily_files_processed_scada/price tests red forever.

  Run this BEFORE the main `dbt run` (against prod) so the deleted markers are
  re-downloaded in the same pass.
#}

  {% set log_rel = load_relation(ref('stg_csv_archive_log')) %}
  {% set scada_rel = load_relation(ref('fct_scada')) %}
  {% set price_rel = load_relation(ref('fct_price')) %}

  {% if log_rel is none or scada_rel is none or price_rel is none %}
    {{ log("heal_orphaned_daily_files: log/fact tables not present yet, skipping", info=True) }}
  {% else %}
    {% set find_sql %}
      SELECT count(*) FROM {{ log_rel }}
      WHERE source_type = 'daily'
        AND (
          csv_filename NOT IN (SELECT DISTINCT file FROM {{ scada_rel }})
          OR csv_filename NOT IN (SELECT DISTINCT file FROM {{ price_rel }})
        )
    {% endset %}
    {% set orphan_count = run_query(find_sql).rows[0][0] %}
    {{ log("heal_orphaned_daily_files: " ~ orphan_count ~ " orphaned daily log entries", info=True) }}

    {% if orphan_count > 0 %}
      {% set delete_sql %}
        DELETE FROM {{ log_rel }}
        WHERE source_type = 'daily'
          AND (
            csv_filename NOT IN (SELECT DISTINCT file FROM {{ scada_rel }})
            OR csv_filename NOT IN (SELECT DISTINCT file FROM {{ price_rel }})
          )
      {% endset %}
      {% do run_query(delete_sql) %}
      {{ log("heal_orphaned_daily_files: deleted " ~ orphan_count ~ " entries; they will re-download next pass", info=True) }}
    {% endif %}
  {% endif %}

{% endmacro %}
