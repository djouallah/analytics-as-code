{%- macro get_root_path() -%}
{{ env_var('ROOT_PATH', '/tmp') | trim }}
{%- endmacro -%}
