// =============================================================================
// queue.js — the engines' queries, in the page's order
// =============================================================================
// DuckDB-WASM runs one query at a time (one worker thread). Sent together, a render's
// queries would queue in the worker, where nothing can drop or reorder them: a render that a
// newer one replaced kept the engine busy with queries nobody would draw, and the hero's
// cheap queries waited behind every chart. So every DuckDB data.js sends through here:
// `early` ones first, `later` ones once no other is waiting, and one whose `stale()` holds
// when its turn comes is dropped, never run (it rejects with `skipped` set).
// One queue feeds all of a host's engines (GitHub Pages has one, the Iceberg app a pool): a
// free engine takes the next job, so a long query holds up only its own engine. A query is
// not given an engine when it is sent: one sent to an engine behind an 18 s scan waited 14 s
// there while the other engine sat idle (2026-10-28). A job bound to an engine (its setup)
// runs on that one.
// The same file on every DuckDB host. Losing nothing: an engine cannot run two at once.
// =============================================================================

export class Skipped extends Error {
  constructor() { super('skipped: a newer render replaced the one that asked'); this.skipped = true; }
}

// add(engine): an engine in service (any object; the queue keeps its `busy`).
// submit(fn, options): fn(engine) on a free engine. options: the page's `stale`, `early`,
// `later`; `engine`, to run on that one; anything else is the host's, for `pick(job, free)`,
// which chooses among the free engines (the first by default).
export function engineQueue({ pick = (job, free) => free[0] } = {}) {
  const engines = [];
  const jobs = { early: [], normal: [], later: [] };
  function dispatch() {
    for (;;) {
      const free = engines.filter(e => !e.busy);
      if (!free.length) return;
      let job = null;
      for (const k of ['early', 'normal', 'later']) {
        const i = jobs[k].findIndex(j => !j.engine || free.includes(j.engine));
        if (i >= 0) { [job] = jobs[k].splice(i, 1); break; }
      }
      if (!job) return;
      if (job.stale?.()) { job.reject(new Skipped()); continue; }
      const e = job.engine ?? pick(job, free);
      e.busy = true;
      (async () => {
        try { job.resolve(await job.fn(e)); } catch (err) { job.reject(err); }
        finally { e.busy = false; dispatch(); }
      })();
    }
  }
  return {
    add(engine) { engine.busy = false; engines.push(engine); dispatch(); },
    submit: (fn, { stale = null, early = false, later = false, engine = null, ...host } = {}) => new Promise((resolve, reject) => {
      jobs[early ? 'early' : later ? 'later' : 'normal'].push({ ...host, fn, engine, stale, resolve, reject });
      dispatch();
    }),
  };
}

// One engine: serial(run, options) runs run() in its turn.
export function serialQueue() {
  const queue = engineQueue();
  queue.add({});
  return (run, options) => queue.submit(() => run(), options);
}
