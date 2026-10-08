# Power BI

A client of the semantic model (`semantic_model/`), next to `github/`, `fabric_app/wasm/` and
`fabric_app/vertipaq/`:
a Power BI report, reading the Iceberg tables through the model in Direct Lake.

`nem.Report/` is the report, in PBIR: a JSON file per page and per visual, so a chart is a
diff like any other code. It holds no measure and no logic of its own. Every number on it is
a measure of the model, the same ones the page asks for in DAX.

One page, "Overview", over the last 30 days (a page filter, which the filter pane changes):

| Visual | Reads |
|---|---|
| Slicers | `dim_calendar[date]`, `dim_region[Region]` |
| Cards | `[Generation MWh]`, `[Renewable share]`, `[Average price]`, `[Latest update]` |
| Generation by fuel | `[Generation MWh]` by day and `dim_duid[FuelSourceDescriptor]` |
| Price by region | `[Average price]` by day and `dim_region[Region]` |
| Stations | `[Generation MWh]`, `[Capture price]`, `[Capacity factor]`, `[Revenue]` per station and fuel |

The filters are on the dimensions, so the measures read the daily tables.

## Deploy

`deploy_model.yml` (dispatch only) publishes the report with the model, into the workspace of
the catalog's lakehouse (`scripts/deploy_model.py`, fabric-cicd). `definition.pbir` names the
model by its path in this repo, and fabric-cicd binds the report to the deployed model.

There is no `.pbip` to open in Power BI Desktop: the model's lakehouse ids are placeholders
in the repo, filled in at deploy. To change the report, edit the JSON, or edit it in the
Fabric workspace and bring the definition back here.
