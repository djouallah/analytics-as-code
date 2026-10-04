// =============================================================================
// logs.js — the Logs panel: in-memory timings (perflog.js), newest first
// =============================================================================
// The same file on every host. index.html imports it and knows nothing else of it: the
// import adds a "Logs" button (bottom right) and the panel it opens. This session only
// (perflog.js); the one way out is the Copy button. Re-rendered on new events while the
// panel is open (throttled to one render per animation frame). The classes are the page's.
// =============================================================================

import { perf, BUILD } from './perflog.js';

const _pageStart = performance.timeOrigin;
let _logsFrame = 0;

const panel = document.createElement('div');
panel.id = 'view-logs';
panel.style.cssText = 'display:none;position:fixed;inset:0;z-index:9000;overflow:auto;padding:1rem 1.5rem 3.5rem;background:var(--bg, #0d1117);color:var(--text, #e6edf3)';
panel.innerHTML = `
  <div class="analyze-controls">
    <button class="btn-analyze" id="logsCopy" type="button">Copy</button>
    <button class="btn-analyze" id="logsClear" type="button">Clear</button>
    <span class="analyze-info" style="padding:0">This session only — kept in memory, nothing is stored. "http" rows are the DuckDB worker's own requests (Range = a seek in a remote file).</span>
  </div>
  <div class="analyze-info" id="logsSummary" style="white-space:pre;font-family:ui-monospace,Consolas,monospace"></div>
  <div class="analyze-table-wrap">
    <table class="analyze-table" id="logsTable">
      <thead><tr><th>t (s)</th><th>Type</th><th>What</th><th>Range</th><th>Status</th><th>KB</th><th>ms</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>`;
const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'btn-analyze';
toggle.textContent = 'Logs';
toggle.title = "Timings of this page's reads and queries";
toggle.style.cssText = 'position:fixed;right:0.75rem;bottom:0.75rem;z-index:9001;opacity:0.75';
toggle.onclick = () => {
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  toggle.textContent = open ? 'Close logs' : 'Logs';
  if (open) renderLogs();
};
document.body.append(panel, toggle);

function renderLogs() {
  _logsFrame = 0;
  if (panel.style.display === 'none') return;
  const ev = perf.events;
  const sum = (k) => ev.filter(e => e.kind === k);
  const http = sum('http'), reads = http.filter(e => e.range);
  const ms = (a) => a.reduce((s, e) => s + (e.ms || 0), 0);
  const kb = (a) => a.reduce((s, e) => s + (e.bytes || 0), 0) / 1024;
  const pct = (a, p) => { const v = a.map(e => e.ms).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0; };
  const fetches = sum('fetch'), sas = sum('sas');
  // The seek and SAS lines only where there are any: a host that downloads its files whole
  // seeks nothing, and only the Fabric host signs.
  document.getElementById('logsSummary').textContent = [
    `build         : ${BUILD.startsWith('__') ? 'not stamped (a local copy)' : BUILD}`,
    `files         : ${fetches.length} fetched  (${(ms(fetches) / 1000).toFixed(1)} s)    ATTACH: ${ms(sum('attach')).toFixed(0)} ms`,
    // Summed, not elapsed: a render sends its queries together and they queue in one thread,
    // so each one's time includes its wait.
    `queries       : ${sum('query').length}  (${(ms(sum('query')) / 1000).toFixed(1)} s summed, waits included)    errors: ${sum('error').length}`,
    `worker HTTP   : ${http.length}  (Range reads/seeks: ${reads.length})   ${(kb(http) / 1024).toFixed(1)} MB`,
    ...(reads.length ? [`seek latency  : avg ${(ms(reads) / reads.length).toFixed(0)} ms   p50 ${pct(reads, 0.5).toFixed(0)} ms   p95 ${pct(reads, 0.95).toFixed(0)} ms   max ${pct(reads, 1).toFixed(0)} ms   sum ${(ms(reads) / 1000).toFixed(1)} s`] : []),
    ...(sas.length ? [`SAS calls     : ${sas.length}  (${ms(sas).toFixed(0)} ms)`] : []),
  ].join('\n');
  const esc = (t) => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  document.querySelector('#logsTable tbody').innerHTML = ev.slice().reverse().map(e =>
    `<tr><td>${((e.at - _pageStart) / 1000).toFixed(2)}</td><td>${e.kind}</td><td>${esc(e.what)}</td>` +
    `<td>${esc(e.range || '')}</td><td>${esc(e.status ?? '')}</td>` +
    `<td>${e.bytes == null ? '' : (e.bytes / 1024).toFixed(0)}</td><td>${e.ms == null ? '' : e.ms.toFixed(0)}</td></tr>`).join('');
}

perf.log('info', `build ${BUILD}`);
perf.onChange(() => { _logsFrame ||= requestAnimationFrame(renderLogs); });
document.getElementById('logsClear').onclick = () => perf.clear();
// Copy: summary + table as TSV (pastes cleanly into chat or a spreadsheet).
document.getElementById('logsCopy').onclick = async (e) => {
  const rows = [...document.querySelectorAll('#logsTable tr')].map(tr => [...tr.cells].map(c => c.textContent).join('\t'));
  const text = document.getElementById('logsSummary').textContent + '\n' + rows.join('\n');
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch {
    // Fabric iframe may deny the Clipboard API — fall back to a selected textarea + execCommand.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    btn.textContent = document.execCommand('copy') ? 'Copied' : 'Copy failed';
    ta.remove();
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
};
