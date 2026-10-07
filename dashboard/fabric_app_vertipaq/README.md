# Fabric app on VertiPaq

Not available yet. This app sends its DAX to the deployed model, so it has to be a Fabric
app in the model's tenant, on a capacity in a region that has Fabric apps (preview). The
model's workspace (`power`) is on a capacity in Australia Southeast, which does not have
them: Fabric refuses to create the app there (`403 The feature is not available`).

The Fabric app on DuckDB-WASM ([`../fabric_app_wasm/`](../fabric_app_wasm/)) works: it
reads a copy of the tables from a lakehouse in another tenant, so the model's region does
not matter to it.
