// =============================================================================
// catalog.js — where the model's tables are, from the app's function
// =============================================================================
// The browser never holds a token: the openCatalog function (rayfin/functions) asks the
// OneLake Iceberg catalog, server side, where each table is now (its metadata.json) and
// signs a read-only SAS on the lakehouse's Tables/ folder, valid ~55 min.
//
// The answer is kept in localStorage until shortly before its SAS expires, so a viewer calls
// the function about once an hour, not on every load; a page open past that is given a new
// one (`renew`). This browser's alone, like the page's memory: nothing is shared.
//
//   const catalog = createCatalog(() => auth.client());
//   await catalog.open(['<schema>.<table>', ...])
//     -> { metadata: { '<schema>.<table>': 'abfss://...metadata.json' }, missing: [...], sas, expiresOn }
//   catalog.fresh()     true while the kept answer is good: the page can start without a session
//   catalog.renewAt()   when to ask again (ms since the epoch)
// =============================================================================

import { perf } from '../frontend/perflog.js';

const KEY = 'rayfin_catalog';
const RENEW_MARGIN_MS = 2 * 60 * 1000;   // ask again this long before the SAS expires

export function createCatalog(client) {
  // localStorage can be unavailable (private mode, blocked storage): the cache is best-effort.
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  const renewAt = (a = load()) => a ? Date.parse(a.expiresOn) - RENEW_MARGIN_MS : 0;
  const good = (a, tables) => !!a && Date.now() < renewAt(a) && tables.every(t => t in a.metadata || a.missing.includes(t));

  async function call(tables) {
    const rayfin = await client();
    // The function returns its failure as { error }, naming the step that failed.
    const r = await perf.time('sas', `openCatalog (${tables.length} tables)`, async () => {
      const r = await rayfin.functions.openCatalog.invoke({ tables: tables.join(',') }, { timeoutMs: 240000 });
      if (r?.error) throw new Error(`openCatalog failed at ${r.error}`);
      return r;
    });
    perf.log('info', `catalog: ${Object.keys(r.metadata).length} tables located in ${r.catalogMs} ms` +
      (r.missing.length ? `, not in the catalog: ${r.missing.join(', ')}` : '') + `; SAS until ${r.expiresOn}`);
    save(r);
    return r;
  }

  // The kept answer if it is still good for these tables, else a new one. `renew`: a new one.
  async function open(tables, { renew = false } = {}) {
    const kept = load();
    if (!renew && good(kept, tables)) {
      perf.log('info', `catalog: kept answer, SAS until ${kept.expiresOn}`);
      return kept;
    }
    return call(tables);
  }

  return { open, renewAt: () => renewAt(), fresh: () => Date.now() < renewAt() };
}
