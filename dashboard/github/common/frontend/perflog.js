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
// Timestamps are absolute (performance.timeOrigin + now) so worker and page events line up.
// =============================================================================

// Stamped at deploy (build.yml: the git sha; fabric_app/common/build.mjs: sha + build time). Shown in the
// Logs tab so a cached bundle is obvious.
export const BUILD = '__BUILD__';

const CHANNEL = 'perflog-http';
const MAX_EVENTS = 5000;
const events = [];
const listeners = new Set();

function push(e) {
  events.push(e);
  if (events.length > MAX_EVENTS) events.shift();
  for (const fn of listeners) fn();
}

export const perf = {
  log(kind, what, { ms = null, status = '', bytes = null, range = '', dax = '' } = {}) {
    push({ at: performance.timeOrigin + performance.now(), kind, what, ms, status, bytes, range, dax });
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
  async query(sql, run, dax = '') {
    const flat = s => s.replace(/\s+/g, ' ').trim();
    const what = flat(sql);
    dax = flat(dax);
    const t = performance.now();
    try {
      const result = await run();
      perf.log('query', what, { ms: performance.now() - t, status: `${result.numRows} rows`, dax });
      return result;
    } catch (e) {
      perf.log('error', what, { ms: performance.now() - t, status: String(e?.message || e), dax });
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
