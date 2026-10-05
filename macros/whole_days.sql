{#-- The days a per-day table has still to write: the ones the next-day files hold whole.

     A daily row is written ONCE (insert-only merge: a stored value is not revised), so a day
     is only taken when fct_scada holds its 288 intervals. A calendar date straddles two daily
     files, and a day summed from one of them could not be completed afterwards. Days not in
     the table yet, newest first, process_limit per run, like the facts: fct_scada is 300M
     rows. `also` is one more condition on fct_scada's DATE. --#}
{% macro whole_days(also=none) -%}
  SELECT DATE AS date
  FROM {{ ref('fct_scada') }}
  WHERE INTERVENTION = 0
    {%- if also %}
    AND {{ also }}
    {%- endif %}
    {%- if is_incremental() %}
    AND DATE NOT IN (SELECT DISTINCT date FROM {{ this }})
    {%- endif %}
  GROUP BY DATE
  HAVING COUNT(DISTINCT SETTLEMENTDATE) = 288
  ORDER BY date DESC
  LIMIT {{ env_var('process_limit', '1000') }}
{%- endmacro %}
