# Fabric app on VertiPaq

Not deployed. This is the page with the deployed semantic model as its engine: the compiler
writes each query's DAX (`engine: 'dax'` in `site/storage/data.js`), and Power BI runs it
over the Iceberg tables (Direct Lake), with no copy of the data. The DAX reaches the model
through a Rayfin connector of type `fabric-semanticmodel`, which is `delegated` only: each
call runs as the signed-in user, through on-behalf-of, in the app's own tenant.

So the app has to be in the model's tenant, and neither place it could go works yet:
- **The model's workspace (`power`)** is on a capacity in Australia Southeast, which does
  not have Fabric apps (preview). Fabric refuses to create the app there:
  `403 The feature is not available` (microsoft/rayfin#8).
- **The app's tenant (fabriccat, workspace `app`, West Europe)** has Fabric apps, but it
  cannot see the model. Probe of 2026-10-08, signed in to fabriccat: the Fabric API answers
  `404 EntityNotFound` for the `power` workspace, and
  `rayfin connector add --type fabric-semanticmodel --workspace-id <power>` answers
  `Item not found. Verify the workspace ID and artifact ID are correct.`

It becomes possible when Fabric apps reach Australia Southeast, or with a workspace for the
app in the model's tenant on a capacity in a region that has them. The connector can name
the model's workspace, so the app's workspace can be a different one.

The Fabric app on DuckDB-WASM ([`../wasm/`](../wasm/)) works: it reads a copy of the tables
from a lakehouse in fabriccat, so the model's tenant and region do not matter to it.
