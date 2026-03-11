{% macro confirm_log_entries() %}

  {% set pending_path = get_root_path() ~ '/pending_log_entries.csv' %}

  {% set check_sql %}
    SELECT count(*) FROM glob('{{ pending_path }}')
  {% endset %}
  {% set file_exists = run_query(check_sql).rows[0][0] > 0 %}

  {% if file_exists %}
    {% set count_sql %}
      SELECT count(*) FROM read_csv('{{ pending_path }}')
    {% endset %}
    {% set pending_count = run_query(count_sql).rows[0][0] %}
    {{ log("Confirming " ~ pending_count ~ " pending log entries", info=True) }}

    {% set insert_sql %}
      INSERT INTO {{ ref('stg_csv_archive_log') }}
      SELECT
        source_type, source_filename, archive_path,
        archived_at::TIMESTAMP AS archived_at,
        NULL::BIGINT AS row_count,
        source_url, NULL::VARCHAR AS etag, csv_filename
      FROM read_csv('{{ pending_path }}')
    {% endset %}
    {% do run_query(insert_sql) %}

    {% set after = run_query("SELECT source_type, count(*) FROM " ~ ref('stg_csv_archive_log') ~ " GROUP BY source_type ORDER BY source_type") %}
    {% for row in after.rows %}
      {{ log("  " ~ row[0] ~ ": " ~ row[1], info=True) }}
    {% endfor %}
  {% else %}
    {{ log("No pending log entries to confirm", info=True) }}
  {% endif %}

{% endmacro %}
