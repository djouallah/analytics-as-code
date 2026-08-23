{% macro report_unprocessed_files(max_rows=50) %}
{#
  Read-only diagnostic for the assert_all_*_files_processed tests.

  Those tests only ever report a row count, so a red Tests workflow says "FAIL 1" and
  nothing else -- which is how one orphaned file
  (PUBLIC_DAILY_202604130000_20260414040503) kept CI red for two weeks without anyone
  being able to see which file it was. This prints the names.

  Wired into test.yml as an `if: always()` step so it runs whether dbt test passed or
  failed. Deliberately not `--store-failures`, which would write audit tables into the
  production Iceberg catalog from the test workflow.

  Usage: dbt run-operation report_unprocessed_files --target prod --profiles-dir .
#}

  {% set pairs = [
      ('daily',       'fct_scada',       load_relation(ref('fct_scada'))),
      ('daily',       'fct_price',       load_relation(ref('fct_price'))),
      ('scada_today', 'fct_scada_today', load_relation(ref('fct_scada_today'))),
      ('price_today', 'fct_price_today', load_relation(ref('fct_price_today'))),
  ] %}
  {% set log_rel = load_relation(ref('stg_csv_archive_log')) %}

  {% if log_rel is none %}
    {{ log("report_unprocessed_files: stg_csv_archive_log not present yet, skipping", info=True) }}
  {% else %}
    {% for source_type, model_name, fact_rel in pairs %}
      {% if fact_rel is none %}
        {{ log(model_name ~ ": not present yet, skipping", info=True) }}
      {% else %}
        {% set find_sql %}
          SELECT DISTINCT l.csv_filename
          FROM {{ log_rel }} l
          WHERE l.source_type = '{{ source_type }}'
            AND NOT EXISTS (
              SELECT 1 FROM {{ fact_rel }} f WHERE f.file = l.csv_filename
            )
          ORDER BY 1
        {% endset %}
        {% set rows = run_query(find_sql).rows %}
        {% if rows | length == 0 %}
          {{ log(model_name ~ ": all '" ~ source_type ~ "' files processed", info=True) }}
        {% else %}
          {{ log(model_name ~ ": " ~ rows | length ~ " unprocessed '" ~ source_type ~ "' file(s)", info=True) }}
          {% for row in rows[:max_rows] %}
            {{ log("  " ~ row[0], info=True) }}
          {% endfor %}
          {% if rows | length > max_rows %}
            {{ log("  ... and " ~ rows | length - max_rows ~ " more", info=True) }}
          {% endif %}
        {% endif %}
      {% endif %}
    {% endfor %}
  {% endif %}

{% endmacro %}
