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

    {#- Anti-join the existing log: a forced re-download (see
        heal_orphaned_daily_files) reprocesses a file whose marker is usually still
        present, and the log is append-only, so a blind INSERT would double the row. -#}
    {% set insert_sql %}
      INSERT INTO {{ ref('stg_csv_archive_log') }}
      SELECT
        p.source_type, p.source_filename, p.archive_path,
        p.archived_at::TIMESTAMP AS archived_at,
        NULL::BIGINT AS row_count,
        p.source_url, NULL::VARCHAR AS etag, p.csv_filename
      FROM read_csv('{{ pending_path }}') p
      WHERE NOT EXISTS (
        SELECT 1 FROM {{ ref('stg_csv_archive_log') }} l
        WHERE l.source_type = p.source_type
          AND l.source_filename = p.source_filename
          AND l.csv_filename = p.csv_filename
      )
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
