{#-- (min, max) of a DATE column of a table, as Python dates, without scanning it: from the
     Iceberg manifests' per-file column bounds (iceberg_column_stats). A model calls it at
     compile time (run_query) and writes the dates it decides on as literals, so that the
     scans that follow carry constant filters, which duckdb-iceberg prunes data files on; a
     subquery (MAX(DATE) FROM ...) does not prune, and over OneLake a full scan of fct_scada
     is 80-175 s. (none, none) for a table that is missing or has no data file.

     If a data file carries no bound for the column (a writer that recorded none), the
     manifests cannot answer and the plain MIN/MAX is read instead, with a warning in the
     log: slow, never wrong. The ci target (plain DuckDB, no Iceberg, tiny tables) always
     reads MIN/MAX. Each read is logged with its time: dbt's own "SQL status" line times the
     execute, not the fetch, and the fetch is where a scan spends its time. --#}
{% macro date_bounds(relation, column) -%}
  {#- Only when the tables are there to ask: not at parse, and not in `dbt compile`. #}
  {%- if not execute or relation is none or flags.WHICH not in ('run', 'build', 'retry') -%}
    {{ return((none, none)) }}
  {%- endif -%}
  {%- set started = modules.datetime.datetime.now() -%}
  {%- set sql -%}
    {%- if target.name == 'ci' -%}
      SELECT CAST(MIN({{ column }}) AS VARCHAR), CAST(MAX({{ column }}) AS VARCHAR), 0
      FROM {{ relation }}
    {%- else -%}
      SELECT
        CAST(MIN(lo) AS VARCHAR), CAST(MAX(hi) AS VARCHAR),
        COUNT(*) FILTER (WHERE lo IS NULL OR hi IS NULL)
      FROM (
        SELECT TRY_CAST(CAST(lower_bound AS VARCHAR) AS DATE) AS lo,
               TRY_CAST(CAST(upper_bound AS VARCHAR) AS DATE) AS hi
        FROM iceberg_column_stats({{ relation.database }}.{{ relation.schema }}.{{ relation.identifier }})
        WHERE column_name = '{{ column }}'
      )
    {%- endif -%}
  {%- endset -%}
  {%- set row = run_query(sql).rows[0] -%}
  {%- set lo, hi, unbounded = row[0], row[1], row[2] -%}
  {%- if unbounded and unbounded > 0 -%}
    {%- do log("::warning::" ~ relation.identifier ~ ": " ~ unbounded ~ " data file(s) carry no bound for "
               ~ column ~ ", reading MIN/MAX instead", info=True) -%}
    {%- set row = run_query("SELECT CAST(MIN(" ~ column ~ ") AS VARCHAR), CAST(MAX(" ~ column ~ ") AS VARCHAR) FROM " ~ relation).rows[0] -%}
    {%- set lo, hi = row[0], row[1] -%}
  {%- endif -%}
  {%- set elapsed = (modules.datetime.datetime.now() - started).total_seconds() -%}
  {%- do log(relation.identifier ~ "." ~ column ~ ": " ~ lo ~ " .. " ~ hi ~ " (" ~ "%.1f" | format(elapsed) ~ "s)", info=True) -%}
  {%- set parse = modules.datetime.datetime.strptime -%}
  {{ return((parse(lo, '%Y-%m-%d').date() if lo else none, parse(hi, '%Y-%m-%d').date() if hi else none)) }}
{%- endmacro %}

{#-- The SQL of a range list [(from, to), ...] on a column: from inclusive, to exclusive,
     either side none for open. Dates are literals. No range at all is FALSE. --#}
{% macro date_ranges_sql(ranges, column) -%}
  {%- if ranges | length == 0 -%}
    FALSE
  {%- else -%}
    ({%- for lo, hi in ranges -%}
      {%- if not loop.first %} OR {% endif -%}
      ({%- if lo %}{{ column }} >= DATE '{{ lo }}'{% endif -%}
       {%- if lo and hi %} AND {% endif -%}
       {%- if hi %}{{ column }} < DATE '{{ hi }}'{% endif -%}
       {%- if not lo and not hi %}TRUE{% endif -%})
    {%- endfor -%})
  {%- endif -%}
{%- endmacro %}

{#-- The ranges as text for a log line: "2026-09-30 .. open, 2018-01-01 .. 2018-10-28". --#}
{% macro ranges_text(ranges) -%}
  {%- set parts = [] -%}
  {%- for lo, hi in ranges -%}
    {%- do parts.append((lo | string if lo else 'open') ~ ' .. ' ~ (hi | string if hi else 'open')) -%}
  {%- endfor -%}
  {{ return(parts | join(', ') if parts else 'nothing') }}
{%- endmacro %}

{#-- The months of dim_month an hour-of-day table (fct_summary_hourly, fct_region_hourly)
     does not hold yet, from the manifests: (to_write, this_min, this_max). Both hold a
     contiguous run of dim_month's months (dim_month is the whole months, contiguous, and the
     tables are filled from it), so a month is missing exactly when dim_month reaches above
     this_max or below this_min. Nothing missing: the model renders nothing_to_do(). A first
     build, or outside a run: (true, none, none). --#}
{% macro pending_months() -%}
  {%- if not is_incremental() -%}
    {{ return((true, none, none)) }}
  {%- endif -%}
  {%- set dim_min, dim_max = date_bounds(ref('dim_month'), 'month') -%}
  {%- set this_min, this_max = date_bounds(this, 'month') -%}
  {%- if not (dim_min and dim_max and this_min and this_max) -%}
    {{ return((true, none, none)) }}
  {%- endif -%}
  {%- set to_write = dim_max > this_max or dim_min < this_min -%}
  {%- do log(this.identifier ~ ": dim_month " ~ dim_min ~ " .. " ~ dim_max ~ ", this " ~ this_min ~ " .. " ~ this_max
             ~ "; " ~ ("months to write" if to_write else "nothing to write"), info=True) -%}
  {{ return((to_write, this_min, this_max)) }}
{%- endmacro %}
