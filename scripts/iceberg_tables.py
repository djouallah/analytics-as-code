"""The catalog's tables, in maintenance order.

Shared by compact_iceberg.py and expire_snapshots.py so the two halves of the daily
maintenance can't drift apart when a model is added.

Hand-ordered. We know the tables; discovering them costs a metadata scan each and buys
nothing. A new model just gets added here.

Order by expected MANIFEST count, not data size — compaction's prime() enumerates
manifests, so that's the cost driver. The dashboard tables go first because they matter
most.
"""

TABLES = [
    "landing.fct_price_today",
    "landing.fct_scada_today",
    "mart.dim_calendar",
    "mart.dim_duid",
    "landing.stg_csv_archive_log",
    "landing.fct_price",
    "landing.fct_scada",
]
