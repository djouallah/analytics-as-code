// =============================================================================
// perflog.js — in-memory timing log for the Logs tab (debugging only)
// =============================================================================
// The same file on every host. This session only: nothing is stored, written to a file or
// uploaded; events live in this page's memory and vanish on reload.
//
// Sources:
//   - main thread: a host's data.js logs what it fetches, attaches and runs
//     (perf.log / perf.time / perf.query; on Fabric also the SAS calls)
//   - DuckDB worker: every HTTP request DuckDB makes (seeks = Range reads) arrives over a
//     BroadcastChannel from the trace shim that data.js prepends to the worker (HTTP_TRACE_SHIM).
//   - the browser: how the page loaded (the navigation, the slow downloads before the page's
//     code ran) and the main thread's long tasks in its first 20 s.
// Timestamps are absolute (performance.timeOrigin + now) so worker and page events line up.
// =============================================================================

// Stamped at deploy (build.yml: the git sha; fabric_app/common/build.mjs: sha + build time). Shown in the
// Logs tab so a cached bundle is obvious.
export const BUILD = '__BUILD__';

const CHANNEL = 'perflog-http';
const MAX_EVENTS = 5000;
const events = [];
const listeners = new Set();

// When the DuckDB worker finished its last logged operation (a query or an ATTACH). The
// worker runs its messages one at a time, in the order sent, so a query starts when the one
// before it ends: the time between its call and then is its wait in the queue. Worker work
// that is never logged (the SETs at init, before any query) is not seen, and would count as
// the next query's run.
let _workerFreeAt = 0;

function push(e) {
  events.push(e);
  if (events.length > MAX_EVENTS) events.shift();
  for (const fn of listeners) fn();
}

export const perf = {
  log(kind, what, { ms = null, wait = null, status = '', bytes = null, range = '', dax = '' } = {}) {
    if (kind === 'attach') _workerFreeAt = performance.now();
    push({ at: performance.timeOrigin + performance.now(), kind, what, ms, wait, status, bytes, range, dax });
  },
  // Time an async step: await perf.time('attach', file, () => conn.query(...))
  async time(kind, what, fn) {
    const t = performance.now();
    try {
      const r = await fn();
      perf.log(kind, what, { ms: performance.now() - t, status: 'ok' });
      return r;
    } catch (e) {
      perf.log(kind, what, { ms: performance.now() - t, status: 'error: ' + (e?.message || e) });
      throw e;
    }
  },
  // Time a query: perf.query(sql, () => conn.query(sql)). A failure is logged and rethrown.
  // `what` is the SQL that ran, always: it is what a change is checked against. `dax` is the
  // query as the page wrote it, when it wrote it in DAX (the compiler passes it on).
  // Its `ms` is the time it ran and `wait` the time it queued behind the worker's earlier
  // work. `queued: false` is a host with no queue (the VertiPaq app's queries are concurrent
  // calls): no wait, and `ms` is the call's whole time.
  async query(sql, run, dax = '', { queued = true } = {}) {
    const flat = s => s.replace(/\s+/g, ' ').trim();
    const what = flat(sql);
    dax = flat(dax);
    const t = performance.now();
    const timing = () => {
      const end = performance.now();
      if (!queued) return { ms: end - t };
      const wait = Math.max(0, _workerFreeAt - t);
      _workerFreeAt = end;
      return { ms: end - t - wait, wait };
    };
    try {
      const result = await run();
      perf.log('query', what, { ...timing(), status: `${result.numRows} rows`, dax });
      return result;
    } catch (e) {
      // Dropped by the queue before it ran (storage/queue.js): not an error, and no run.
      if (e?.skipped) perf.log('skip', what, { status: 'replaced by a newer render', dax });
      else perf.log('error', what, { ...timing(), status: String(e?.message || e), dax });
      throw e;
    }
  },
  events,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  clear() { events.length = 0; for (const fn of listeners) fn(); },
};

try {
  new BroadcastChannel(CHANNEL).onmessage = ({ data }) => push({ ...data, kind: 'http' });
} catch (e) { /* no BroadcastChannel: worker reads just won't be traced */ }

// The page's main thread blocked 100 ms or more (a long task: rendering, parsing, a large
// result turned into rows): one line, 20 s after the page started, with how many, their
// total and the longest (a line each was noise).
try {
  const blocks = [];
  new PerformanceObserver(list => { for (const t of list.getEntries()) if (t.duration >= 100) blocks.push(t); })
    .observe({ type: 'longtask', buffered: true });
  setTimeout(() => {
    if (!blocks.length) return;
    const longest = blocks.reduce((a, b) => b.duration > a.duration ? b : a);
    perf.log('info', `main thread: ${blocks.length} blocks of 100 ms or more in the first 20 s, ${(blocks.reduce((s, b) => s + b.duration, 0) / 1000).toFixed(1)} s in all, the longest ${longest.duration.toFixed(0)} ms from ${(longest.startTime / 1000).toFixed(2)} s`);
  }, Math.max(20000 - performance.now(), 0));
} catch (e) {}

// What happened before the page's code ran (its long tasks are not kept by the browser): the
// navigation, and every download of 200 ms or more until now, in the order they started.
try {
  const at = s => `${(s / 1000).toFixed(2)} s`;
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) perf.log('info', `page: HTML in at ${at(nav.responseEnd)}, DOM parsed at ${at(nav.domInteractive)}, its code running at ${at(performance.now())}`);
  for (const r of performance.getEntriesByType('resource').filter(r => r.duration >= 200).sort((a, b) => a.startTime - b.startTime))
    perf.log('info', `loaded ${r.name.split('?')[0].split('/').slice(-2).join('/')} (${r.initiatorType}): ${at(r.startTime)} to ${at(r.responseEnd)}, ${(r.transferSize / 1024).toFixed(0)} KB${r.transferSize === 0 ? ' (cache)' : ''}`, { ms: r.duration });
} catch (e) {}

// Prepended to the DuckDB worker (before importScripts). Wraps XMLHttpRequest and fetch to post
// one event per HTTP request: method, file name (no query string — it holds the SAS), Range
// header, status, bytes received, duration. Works for sync and async XHR.
export const HTTP_TRACE_SHIM = `(() => {
  let bc; try { bc = new BroadcastChannel(${JSON.stringify(CHANNEL)}); } catch (e) { return; }
  const now = () => performance.timeOrigin + performance.now();
  const fileOf = (u) => { try { return new URL(u, self.location.href).pathname.split('/').pop(); } catch (e) { return String(u).split('?')[0]; } };
  const X = self.XMLHttpRequest;
  if (X) self.XMLHttpRequest = class extends X {
    open(m, u, async = true, ...r) { this.__m = m; this.__u = u; this.__async = async; return super.open(m, u, async, ...r); }
    setRequestHeader(k, v) { if (String(k).toLowerCase() === 'range') this.__range = v; return super.setRequestHeader(k, v); }
    send(body) {
      const t = now();
      const report = () => {
        let bytes = null;
        try {
          if (this.__m === 'HEAD') bytes = 0;
          else if (this.response && this.response.byteLength != null) bytes = this.response.byteLength;
          else bytes = Number(this.getResponseHeader('content-length')) || null;
        } catch (e) {}
        bc.postMessage({ at: t, what: this.__m + ' ' + fileOf(this.__u), range: this.__range || '',
                         status: this.status, bytes, ms: now() - t });
      };
      if (this.__async === false) { try { return super.send(body); } finally { report(); } }
      this.addEventListener('loadend', report);
      return super.send(body);
    }
  };
  const F = self.fetch;
  if (F) self.fetch = async (input, init = {}) => {
    const t = now(); const u = typeof input === 'string' ? input : input.url;
    const h = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    const r = await F(input, init);
    bc.postMessage({ at: t, what: (init.method || 'GET') + ' ' + fileOf(u), range: h.get('range') || '',
                     status: r.status, bytes: Number(r.headers.get('content-length')) || null, ms: now() - t });
    return r;
  };
})();`;
