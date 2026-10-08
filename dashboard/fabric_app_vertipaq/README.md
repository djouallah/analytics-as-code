# Fabric app on VertiPaq

Not built. This app would be the page with the deployed semantic model as its engine: its
queries run by Power BI over the Iceberg tables (Direct Lake), no copy of the data. It has to
be a Fabric app in the model's tenant, on a capacity in a region that has Fabric apps
(preview). The model's workspace (`power`) is on a capacity in Australia Southeast, which
does not have them: Fabric refuses to create the app there (`403 The feature is not
available`).

It becomes possible when Fabric apps reach Australia Southeast, or with a workspace for the
app on a capacity in a region that has them (the app's connector can name the model's
workspace).

The Fabric app on DuckDB-WASM ([`../fabric_app_wasm/`](../fabric_app_wasm/)) works: it
reads a copy of the tables from a lakehouse in another tenant, so the model's region does
not matter to it.
