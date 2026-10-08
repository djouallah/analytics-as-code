{#-- The days a per-day table has still to write: the ones the next-day files hold whole.

     A daily row is written ONCE (insert-only merge: a stored value is not revised), so a day
     is only taken when fct_scada holds its 288 intervals. A calendar date straddles two daily
     files, and a day summed from one of them could not be completed afterwards.

     Which dates to look at is decided at compile time from the Iceberg manifests
     (macros/date_bounds.sql) and written as literals, so that the scans carry constant DATE
     filters and prune data files. Until 2026-10-06 this grouped all of fct_scada by date
     every run (300M rows over OneLake, 75-100 s per model) and anti-joined the table's own
     dates. Two kinds of range, [from, to) with to exclusive:
       * every run: the days after the newest one the table holds, up to the day before
         fct_scada's newest: the newest is never whole (the last next-day file stops at 04:00
         on it), so with no new daily file the range is empty and no query is sent;
       * refill (a first build, or after rebuild=<table>): process_limit days below the
         oldest one the table holds, newest first, until it reaches the oldest the source
         has. The refill is contiguous downward, so MIN(date) is the frontier.
     A day that never reaches 288 intervals in fct_scada is passed over once a later day is
     written; before, it was retried every run and never written either. fct_scada's oldest
     date (2018-03-06) is one: the refill stops at the day after it, so a table that reached
     it sends no query (until 2026-10-08 that day was asked for every hour, 15 s each).
     `floor` is a date below which no day is taken (fct_summary_daily: the oldest day
     fct_summary holds, which it fills newest first). --#}

{% macro pending_day_ranges(floor=none) -%}
  {%- set process_limit = env_var('process_limit', '1000') | int -%}
  {%- set day = modules.datetime.timedelta(days=1) -%}
  {%- set scada_min, scada_max = date_bounds(ref('fct_scada'), 'DATE') -%}
  {%- set this_min, this_max = date_bounds(this, 'date') if is_incremental() else (none, none) -%}
  {%- set ranges = [] -%}
  {%- if scada_max -%}
    {#- fct_scada's oldest date is never whole either: its first next-day file starts at 04:05. #}
    {%- set oldest = scada_min + day if floor is none or floor < scada_min + day else floor -%}
    {%- if this_max -%}
      {%- do ranges.append((this_max + day, scada_max)) -%}
      {%- if this_min and this_min > oldest -%}
        {%- do ranges.append((this_min - process_limit * day, this_min)) -%}
      {%- endif -%}
    {%- else -%}
      {%- do ranges.append((scada_max - process_limit * day, scada_max)) -%}
    {%- endif -%}
    {#- Nothing below the floor; a range that ends up empty is dropped. #}
    {%- set kept = [] -%}
    {%- for lo, hi in ranges -%}
      {%- set lo = oldest if lo < oldest else lo -%}
      {%- if lo < hi %}{% do kept.append((lo, hi)) %}{% endif -%}
    {%- endfor -%}
    {%- set ranges = kept -%}
  {%- endif -%}
  {%- if execute -%}
    {%- do log(this.identifier ~ ": fct_scada " ~ scada_min ~ " .. " ~ scada_max ~ ", this " ~ this_min ~ " .. "
               ~ this_max ~ (", floor " ~ floor if floor else "") ~ "; looking at " ~ ranges_text(ranges), info=True) -%}
  {%- endif -%}
  {{ return(ranges) }}
{%- endmacro %}

{% macro whole_days(ranges) -%}
  SELECT DATE AS date
  FROM {{ ref('fct_scada') }}
  WHERE INTERVENTION = 0
    AND {{ date_ranges_sql(ranges, 'DATE') }}
  GROUP BY DATE
  HAVING COUNT(DISTINCT SETTLEMENTDATE) = 288
{%- endmacro %}

{#-- Whether the ranges hold a whole day yet: false when there are none, or none of their days
     has its 288 intervals in fct_scada yet. A model with no whole day has nothing to write
     and renders nothing_to_do() (macros/nothing_to_do.sql). The query is whole_days()
     itself, on literal ranges, so it prunes like the model's own scan. True outside a run
     (compile, docs), so the model's SQL is shown whole. --#}
{% macro has_whole_days(ranges) -%}
  {%- if not execute or flags.WHICH not in ('run', 'build', 'retry') -%}
    {{ return(true) }}
  {%- endif -%}
  {%- if ranges | length == 0 -%}
    {{ return(false) }}
  {%- endif -%}
  {%- set n = run_query("SELECT COUNT(*) FROM (" ~ whole_days(ranges) ~ ")").rows[0][0] -%}
  {%- do log(this.identifier ~ ": " ~ n ~ " whole day(s) to write", info=True) -%}
  {{ return(n > 0) }}
{%- endmacro %}
