// =============================================================================
// logs.js — the Logs tab: in-memory timings (perflog.js), newest first; a click on a column
// header sorts by it (numbers largest first, text A-Z), a second click reverses
// =============================================================================
// A query the page wrote in DAX is shown as written, with the SQL it became under it; one
// written in SQL (the Analyze tab, the compiler's own) is the SQL alone.
// The same file on every host. This session only (perflog.js); the one way out is the Copy
// button. index.html has the tab and its panel and calls renderLogs() when the tab is opened;
// after that it is re-rendered on new events while the tab is visible (throttled to one
// render per animation frame).
// =============================================================================

import { perf, BUILD } from './perflog.js';

const _pageStart = performance.timeOrigin;
let _logsFrame = 0;
// The table's columns, in header order: the event field each one sorts on.
const COLS = ['at', 'kind', 'what', 'range', 'status', 'bytes', 'ms'];
let _sort = { col: 'at', desc: true };

export function renderLogs() {
  _logsFrame = 0;
  if (document.getElementById('view-logs').style.display === 'none') return;
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
  const { col, desc } = _sort;
  // Empty cells last, whichever the direction.
  const rows = ev.filter(e => e[col] != null && e[col] !== '').sort((a, b) => {
    const x = a[col], y = b[col];
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return desc ? -c : c;
  }).concat(ev.filter(e => e[col] == null || e[col] === ''));
  document.querySelectorAll('#logsTable thead th').forEach((th, i) => {
    th.dataset.label ??= th.textContent;
    th.style.cursor = 'pointer';
    th.textContent = th.dataset.label + (COLS[i] === col ? (desc ? ' ▼' : ' ▲') : '');
  });
  const what = e => e.dax ? `<div>${esc(e.dax)}</div><div style="color:var(--muted)">${esc(e.what)}</div>` : esc(e.what);
  document.querySelector('#logsTable tbody').innerHTML = rows.map(e =>
    `<tr><td>${((e.at - _pageStart) / 1000).toFixed(2)}</td><td>${e.kind}</td><td>${what(e)}</td>` +
    `<td>${esc(e.range || '')}</td><td>${esc(e.status ?? '')}</td>` +
    `<td>${e.bytes == null ? '' : (e.bytes / 1024).toFixed(0)}</td><td>${e.ms == null ? '' : e.ms.toFixed(0)}</td></tr>`).join('');
}

perf.log('info', `build ${BUILD}`);
perf.onChange(() => { _logsFrame ||= requestAnimationFrame(renderLogs); });
document.getElementById('logsClear').onclick = () => perf.clear();
document.querySelector('#logsTable thead').onclick = (e) => {
  const col = COLS[e.target.closest('th')?.cellIndex];
  if (!col) return;
  // A new column starts largest first for numbers (time, KB, ms), A-Z for text.
  _sort = col === _sort.col ? { col, desc: !_sort.desc } : { col, desc: ['at', 'bytes', 'ms'].includes(col) };
  renderLogs();
};
// Copy: summary + table as TSV (pastes cleanly into chat or a spreadsheet). A DAX query and
// its SQL stay in one cell: "<DAX>  =>  <SQL>".
document.getElementById('logsCopy').onclick = async (e) => {
  const cell = c => c.children.length ? [...c.children].map(d => d.textContent).join('  =>  ') : c.textContent;
  const rows = [...document.querySelectorAll('#logsTable tr')].map(tr => [...tr.cells].map(cell).join('\t'));
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
