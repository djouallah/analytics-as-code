// =============================================================================
// data.js — DataSource: the GitHub page's .duckdb files, from a lakehouse's Files/
// =============================================================================
// The Fabric app `duckdb`. Its data source is the GitHub page's (storage/github.js, staged
// from dashboard/github/data.js by `build.mjs github`): the same files (mart_dim, mart_today,
// mart_agg, the half-years and mart_manifest.json, scripts/cache_catalog.py), downloaded whole
// into OPFS and attached, the half-years a range needs only. They are written by
// import_data.yml into the folder FILES_URL names (scripts/upload_onelake.py), and read with a
// read-only SAS from the app's function (files.js). Nothing else differs from the GitHub page.
// =============================================================================

import { createDataSource as createFilesSource } from './github.js';
import { createAuth } from './auth.js';
import { createFiles } from './files.js';

export function createDataSource(options = {}) {
  const files = createFiles(() => auth.client());
  // A kept SAS needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: files.fresh });
  const source = createFilesSource(options);
  async function init(o = {}) {
    await auth.signIn();
    await files.open();
    return source.init({ ...o, url: files.url });
  }
  return { ...source, init };
}
