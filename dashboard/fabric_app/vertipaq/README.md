# Fabric app on VertiPaq

The page with the deployed semantic model as its engine: the compiler writes each query's
DAX (`engine: 'dax'` in `site/storage/data.js`), and Power BI runs it over the Iceberg tables
(Direct Lake), with no copy of the data. The DAX reaches the model through a Rayfin
connector of type `fabric-semanticmodel` (delegated: each call runs as the signed-in user).

`deploy_fabric.yml` installs it with the rest of the project into one workspace (the
lakehouse, the dbt notebook and pipeline, the model and the report), and writes the
connector to the model of that workspace at deploy. The workspace's capacity has to be in a
region that has Fabric apps (preview).

The Fabric app on DuckDB-WASM ([`../wasm/`](../wasm/)) is the other backend; both are built
by [`../common/build.mjs`](../common/build.mjs).
