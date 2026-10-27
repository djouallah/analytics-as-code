// =============================================================================
// catalog.js — where the model's tables are, from the app's function
// =============================================================================
// The browser never holds a token: the openCatalog function (rayfin/functions) asks the
// OneLake Iceberg catalog, server side, where each table is now (its metadata.json) and
// signs a read-only SAS on the lakehouse's Tables/ folder, valid ~55 min.
//
//   const catalog = createCatalog(() => auth.client());
//   await catalog.open(['mart.fct_summary', ...])
//     -> { metadata: { 'mart.fct_summary': 'abfss://...metadata.json' }, missing: [...], sas, expiresOn }
// =============================================================================

import { perf } from '../frontend/perflog.js';

export function createCatalog(client) {
  async function open(tables) {
    const rayfin = await client();
    // The function returns its failure as { error }, naming the step that failed.
    const r = await perf.time('sas', `openCatalog (${tables.length} tables)`, async () => {
      const r = await rayfin.functions.openCatalog.invoke({ tables: tables.join(',') }, { timeoutMs: 240000 });
      if (r?.error) throw new Error(`openCatalog failed at ${r.error}`);
      return r;
    });
    perf.log('info', `catalog: ${Object.keys(r.metadata).length} tables located in ${r.catalogMs} ms` +
      (r.missing.length ? `, not in the catalog: ${r.missing.join(', ')}` : '') + `; SAS until ${r.expiresOn}`);
    return r;
  }
  return { open };
}
