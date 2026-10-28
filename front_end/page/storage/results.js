// =============================================================================
// results.js — a query's result kept in this browser across visits
// =============================================================================
// IndexedDB, as Arrow IPC (through the apache-arrow module duckdb-wasm itself imports: the
// same URL, the same module). A reload answers every query already seen without an engine.
// The key is the SQL and what the host says identifies the data it reads (`versions`: for
// the Iceberg app, the metadata location of every table it names), so new data is a new key
// and a result is never served over it. Not kept: a query that reads the clock or today's
// date (current_date, now(), random(), ...), one that is not a read, a result over
// RESULT_MAX; past RESULTS_MAX in all the least recently used go. Best-effort: storage
// refused or failing, a query just runs.
// Shared by the DuckDB hosts; which data a query reads, and its version, is the host's.
// =============================================================================

import { tableToIPC, tableFromIPC } from "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm";
import { perf } from "../frontend/perflog.js";

const RESULT_MAX = 8 * 1024 * 1024, RESULTS_MAX = 256 * 1024 * 1024;
const VOLATILE = /\bcurrent_(date|time|timestamp)\b|\b(now|today|random|uuid|gen_random_uuid|setseed|nextval|get_current_time|timezone)\s*\(/i;
const asPromise = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// `name`: the IndexedDB database, one per host.
export function createResults(name) {
  let db = null;
  const store = () => db ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    // `bytes`: key -> the IPC; `meta`: key -> its size and when last used (for the cap).
    open.onupgradeneeded = () => { open.result.createObjectStore('bytes'); open.result.createObjectStore('meta').createIndex('at', 'at'); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).catch(() => null);

  // The least recently used results out, past RESULTS_MAX in all.
  async function prune(idb) {
    const all = [];
    await new Promise(resolve => {
      const cur = idb.transaction('meta').objectStore('meta').index('at').openCursor(null, 'prev');
      cur.onsuccess = () => { const c = cur.result; if (!c) return resolve(); all.push([c.primaryKey, c.value.size]); c.continue(); };
      cur.onerror = () => resolve();
    });
    let total = 0;
    const out = all.filter(([, size]) => (total += size) > RESULTS_MAX).map(([k]) => k);
    if (!out.length) return;
    const tx = idb.transaction(['bytes', 'meta'], 'readwrite');
    for (const k of out) { tx.objectStore('bytes').delete(k); tx.objectStore('meta').delete(k); }
    perf.log('info', `saved results: ${out.length} dropped (over ${RESULTS_MAX / 1048576} MB)`);
  }
  let pruning = null;

  return {
    // The key of `sql` over data of these `versions` (strings), or null if it is not kept.
    key(sql, versions) {
      if (!/^\s*(select|with|from)\b/i.test(sql) || VOLATILE.test(sql)) return null;
      return [sql, ...versions].join('\n');
    },
    async get(key) {
      try {
        const idb = await store();
        if (!idb) return null;
        const bytes = await asPromise(idb.transaction('bytes').objectStore('bytes').get(key));
        if (!bytes) return null;
        const meta = idb.transaction('meta', 'readwrite').objectStore('meta');
        meta.get(key).onsuccess = ev => { const m = ev.target.result; if (m) meta.put({ ...m, at: Date.now() }, key); };
        return tableFromIPC(bytes);
      } catch (e) { return null; }
    },
    async put(key, table) {
      try {
        const bytes = tableToIPC(table);
        if (bytes.byteLength > RESULT_MAX) return;
        const idb = await store();
        if (!idb) return;
        const tx = idb.transaction(['bytes', 'meta'], 'readwrite');
        tx.objectStore('bytes').put(bytes, key);
        tx.objectStore('meta').put({ size: bytes.byteLength, at: Date.now() }, key);
        pruning ??= new Promise(r => setTimeout(r, 5000)).then(() => prune(idb)).finally(() => { pruning = null; });
      } catch (e) {}
    },
  };
}
