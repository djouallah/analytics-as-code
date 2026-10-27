// =============================================================================
// snapshots.js — the client's own catalog: each table's snapshot, as it was planned, kept
// =============================================================================
// Planning a table from Iceberg (data.js, PLAN) reads its metadata.json, the manifest list and
// every manifest, one request at a time, and what comes out is small: the snapshot's live data
// files, its delete files, and the manifests read. That is kept here, per
// table, keyed by the table's metadata location: an Iceberg commit always writes a new
// metadata.json, so the same location is the same snapshot, and a table whose location the
// function gives again is opened from its record with nothing read from OneLake. A new
// location is planned again, and the record's manifests tell the prefetch which ones the
// worker already holds (blockcache.js keeps manifests too).
//
//   { location, bytes, scan, files: [{ path, size }], deleteFiles: [{ path, size }],
//     manifests: [path], savedAt }
//
// Paths only, no URL: the SAS is never stored. localStorage, this browser's, best-effort: a
// browser that blocks it plans every table every visit, as before.
// =============================================================================

const KEY = 'iceberg_snapshots';
const VERSION = 4;   // a record of another version is not used (4: delete files listed, applied by the view)

export function createSnapshots() {
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = all => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {} };
  return {
    // The table's record if it is of this location, else null.
    get(name, location) { const r = load()[name]; return r?.v === VERSION && r.location === location && Array.isArray(r.files) ? r : null; },
    // The table's record whatever its location (the manifests and files already seen).
    previous(name) { return load()[name] ?? null; },
    put(name, record) { const all = load(); all[name] = { ...record, v: VERSION, savedAt: new Date().toISOString() }; save(all); },
    drop(name) { const all = load(); delete all[name]; save(all); },
  };
}
