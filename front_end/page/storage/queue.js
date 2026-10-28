// =============================================================================
// queue.js — the engine's queries one at a time, in the page's order
// =============================================================================
// DuckDB-WASM runs one query at a time (one worker thread). Sent together, a render's
// queries would queue in the worker, where nothing can drop or reorder them: a render that a
// newer one replaced kept the engine busy with queries nobody would draw, and the hero's
// cheap queries waited behind every chart. So both DuckDB data.js send through here: one at
// a time, `early` ones first, `later` ones once no other is waiting, and one whose `stale()` holds
// when its turn comes is dropped, never run (it rejects with `skipped` set).
// The same file on every DuckDB host. Losing nothing: the engine could not run two at once.
// =============================================================================

export class Skipped extends Error {
  constructor() { super('skipped: a newer render replaced the one that asked'); this.skipped = true; }
}

export function serialQueue() {
  const early = [], normal = [], later = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (let job; (job = early.shift() ?? normal.shift() ?? later.shift());) {
        if (job.stale?.()) { job.reject(new Skipped()); continue; }
        try { job.resolve(await job.run()); } catch (e) { job.reject(e); }
      }
    } finally { busy = false; }
  }
  // run: () => Promise (the query); options: { stale: () => boolean, early, later: boolean }
  return (run, { stale = null, early: high = false, later: low = false } = {}) => new Promise((resolve, reject) => {
    (high ? early : low ? later : normal).push({ run, stale, resolve, reject });
    pump();
  });
}
