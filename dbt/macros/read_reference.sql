{#-- A reference file of Files/csv/duid/ (source duid_reference) read as text, or no rows with
     the given columns while the file is not there: the MMSDM tables (genunits, dualloc,
     interconnector) come from nemweb, and a new lakehouse whose first downloads failed has
     no previous copy to keep (stg_csv_archive_log). The run says so. dim_duid and
     dim_interconnector are insert-only: a unit added while dualloc/genunits were missing keeps
     a NULL CO2eFactor until a rebuild=dim_duid. --#}
{% macro read_reference(name, columns) -%}
{%- set path = source('duid_reference', name) -%}
{%- if execute and flags.WHICH in ('run', 'build', 'retry')
      and run_query("SELECT count(*) FROM glob(" ~ path ~ ")").columns[0].values()[0] == 0 -%}
  {{- log(name ~ ".csv is not there yet: read as no rows (" ~ this.identifier ~ ")", info=true) -}}
(SELECT {% for c in columns %}NULL::VARCHAR AS {{ c }}{{ ", " if not loop.last }}{% endfor %} WHERE FALSE)
{%- else -%}
read_csv({{ path }}, all_varchar = true)
{%- endif -%}
{%- endmacro %}
