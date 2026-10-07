// =============================================================================
// history.js — the half-year files of the 5-minute history, on the page's side
// =============================================================================
// The same file for every host: both data.js download the half-year files a date range
// needs (periodsForRange) whole into OPFS and attach them from there (attachCached). Read in
// place over HTTP instead, every block is a round trip, and on OneLake one costs ~700 ms.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev65.0/+esm";

// The half-year periods ('2024_h1', ...) a date range ('YYYY-MM-DD' to 'YYYY-MM-DD') touches.
export function periodsForRange(from, to) {
  const periods = [];
  let d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    const y = d.getUTCFullYear();
    const h = d.getUTCMonth() < 6 ? 1 : 2;
    const tag = `${y}_h${h}`;
    if (!periods.includes(tag)) periods.push(tag);
    d = new Date(h === 1 ? `${y}-07-01` : `${y + 1}-01-01`);
  }
  return periods;
}

// ATTACH a cached file READ_ONLY. Preferred: DuckDB reads it in place from OPFS, pulling
// only the pages a query touches, instead of the whole file being copied into the WASM heap.
// That needs an exclusive sync access handle, which a second tab on the same origin can't
// get, so fall back to copying the file into memory. `buffer` is set when the file couldn't
// be written to OPFS. Returns 'in place' or 'in memory'.
export async function attachCached(db, conn, filename, alias, buffer) {
  if (!buffer) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename);
    try {
      // Registered under the plain name, not opfs://: an opfs:// ATTACH also opens
      // opfs://<file>.wal, which is never registered, and the ATTACH fails.
      await db.registerFileHandle(filename, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      await conn.query(`ATTACH '${filename}' AS ${alias} (READ_ONLY);`);
      return 'in place';
    } catch (e) {
      console.log(`[OPFS] In-place read failed for ${filename} (${e}), loading into memory`);
      try { await db.dropFile(filename); } catch (_) {}
      buffer = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    }
  }
  await db.registerFileBuffer(filename, buffer);
  await conn.query(`ATTACH '${filename}' AS ${alias} (READ_ONLY);`);
  return 'in memory';
}
