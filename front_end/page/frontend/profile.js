// =============================================================================
// profile.js — a query's profile, as DuckDB measured it: where the time went
// =============================================================================
// General purpose: it reads DuckDB's own profile (EXPLAIN (ANALYZE, FORMAT json), with the
// metrics PROFILE_SQL asks for) and knows no table, column or model. Three views of it, as a
// warehouse's query profile shows them:
//   - the totals: the time, its planning and its execution, the rows scanned and returned,
//     the peak memory;
//   - a timeline: the phases in the order DuckDB runs them (binding and planning, the
//     optimizer, physical planning), then every operator's own time, laid end to end in the
//     order its pipelines run (a join's build side before its probe side, a child before its
//     parent). On one thread the operators' times add up to the execution; operators of one
//     pipeline run interleaved, a vector at a time, so a bar is the operator's share of that
//     time, not its start and end;
//   - the most expensive operators: time, share, rows out against DuckDB's estimate, rows
//     scanned, and what each does (its table, filters, join condition, groups).
// The host passes in how to run SQL and how to draw the plan tree (createPlanView's `ctx`);
// the arithmetic of the layout is here, not in the page.
// =============================================================================

// What the profile is asked to measure: the operators, and the phases before them.
const METRICS = ['LATENCY', 'OPERATOR_TIMING', 'OPERATOR_CARDINALITY', 'OPERATOR_ROWS_SCANNED', 'OPERATOR_TYPE',
  'OPERATOR_NAME', 'EXTRA_INFO', 'CUMULATIVE_ROWS_SCANNED', 'PLANNER', 'PHYSICAL_PLANNER', 'ALL_OPTIMIZERS',
  'SYSTEM_PEAK_BUFFER_MEMORY'];
// The SQL that profiles a query: the metrics, then EXPLAIN ANALYZE, which runs it. One row,
// its `explain_value` the profile as JSON.
export const profileSql = sql =>
  `SET custom_profiling_settings = '${JSON.stringify(Object.fromEntries(METRICS.map(m => [m, 'true'])))}';\nEXPLAIN (ANALYZE, FORMAT json) ${sql}`;

// An operator's kind, for its colour: what it does, read off DuckDB's operator name.
const KINDS = [['scan', /SCAN|READ_|PARQUET|CSV|COLUMN_DATA|DUMMY|EMPTY_RESULT|CHUNK_SCAN|DELIM_SCAN|CTE_SCAN/],
  ['join', /JOIN|CROSS_PRODUCT/], ['aggregate', /GROUP_BY|AGGREGATE|DISTINCT/], ['sort', /ORDER|TOP_N|SORT/],
  ['window', /WINDOW/], ['filter', /FILTER|PROJECTION|LIMIT|UNNEST/]];
export const KIND_NAMES = { plan: 'Planning', scan: 'Scan', join: 'Join', aggregate: 'Aggregate', sort: 'Sort',
  window: 'Window', filter: 'Filter, project', other: 'Other' };
const kindOf = name => KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other';
const SKIP = new Set(['EXPLAIN_ANALYZE', 'RESULT_COLLECTOR', 'QUERY']);
const JOIN = /JOIN|CROSS_PRODUCT/, CTE = /^(RECURSIVE_)?CTE$|MATERIALIZED_CTE/;

// What an operator does, in a line: its table or function, then its conditions.
const DETAIL_KEYS = ['Table', 'Function', 'Text', 'Join Type', 'Conditions', 'Filters', 'Expression', 'Groups',
  'Aggregates', 'Order By', 'Top', 'Projections'];
const detailOf = info => DETAIL_KEYS.filter(k => info[k] != null && info[k] !== '')
  .map(k => `${k === 'Table' || k === 'Function' || k === 'Text' ? '' : `${k}: `}${[info[k]].flat().join(', ')}`).join(' · ');

// The profile JSON as one object: totals, phases, and the operators in execution order.
// DuckDB 1.5's keys (operator_timing, operator_cardinality, children) and 2.0's (timing,
// intermediate_rows, an `operator` list) are both read.
export function parseProfile(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  const secs = v => (Number(v) || 0) * 1000;
  const operators = [];
  let id = 0;
  const nameOf = n => String(n.operator_name ?? n.operator_type ?? n.type ?? n.name ?? '').trim();
  const rowsOf = n => Number(n.operator_cardinality ?? n.intermediate_rows ?? 0);
  // An operator's inputs before it. A join builds its second child (the build side) before
  // it reads its first (the probe side); a CTE materializes its first child (the CTE's query)
  // before its second (the query that reads it) runs; any other operator takes its children
  // in order.
  const visit = (n, depth) => {
    const name = nameOf(n);
    const kids = n.children ?? [];
    const skip = SKIP.has(name);
    const me = skip ? null : { id: id++, name, depth, kind: kindOf(name), ms: secs(n.operator_timing ?? n.timing),
      rows: rowsOf(n), scanned: Number(n.operator_rows_scanned ?? 0),
      estimate: Number(n.extra_info?.['Estimated Cardinality']) || null, info: n.extra_info ?? {},
      detail: detailOf(n.extra_info ?? {}) };
    for (const k of JOIN.test(name) ? [...kids].reverse() : kids) visit(k, skip ? depth : depth + 1);
    if (me) operators.push(me);
  };
  const roots = p.operator ?? p.children ?? [];
  for (const n of roots) visit(n, 0);
  // The rows the query returns: its top operator's, below EXPLAIN ANALYZE and through a CTE to
  // the query that reads it (its last child).
  const result = n => n && (SKIP.has(nameOf(n)) || CTE.test(nameOf(n)) ? result((n.children ?? []).at(-1)) : n);
  const execution = operators.reduce((s, o) => s + o.ms, 0);
  const phases = [['Bind and plan', secs(p.planner)], ['Optimize', secs(p.all_optimizers)],
    ['Physical plan', secs(p.physical_planner)]].filter(([, ms]) => ms > 0).map(([name, ms]) => ({ name, ms, kind: 'plan' }));
  const planning = phases.reduce((s, f) => s + f.ms, 0);
  const total = Math.max(secs(p.latency), planning + execution);
  const top = result(roots.at(-1));
  return { total, planning, execution, other: Math.max(0, total - planning - execution), phases, operators,
    rows: top ? rowsOf(top) : 0, scanned: Number(p.cumulative_rows_scanned ?? operators.reduce((s, o) => s + o.scanned, 0)),
    memory: Number(p.system_peak_buffer_memory ?? 0) || null };
}

// =============================================================================
// The page
// =============================================================================

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter(k => k != null));
  return n;
};
const ms = v => v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
const count = v => Number(v).toLocaleString();
const bytes = v => v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(2)} GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`;
const pct = (v, of) => of ? `${(100 * v / of).toFixed(v / of < 0.1 ? 1 : 0)}%` : '';
// DuckDB's estimate against the rows that came out: off by ten times or more is worth a look
// (a join order or a plan chosen on a wrong guess).
const misestimate = o => o.estimate != null && Math.max(o.rows, 1) / Math.max(o.estimate, 1) >= 10 ? 'under'
  : o.estimate != null && Math.max(o.estimate, 1) / Math.max(o.rows, 1) >= 10 ? 'over' : null;

// The profile drawn into `root`. `colors`: kind -> colour.
export function renderProfile(root, prof, colors) {
  const color = k => colors[k] ?? colors.other;
  const tile = (label, value, sub) => el('div', { class: 'pf-tile' }, el('div', { class: 'pf-label' }, label),
    el('div', { class: 'pf-value' }, value), sub ? el('div', { class: 'pf-sub' }, sub) : null);
  const tiles = el('div', { class: 'pf-tiles' },
    tile('Total', ms(prof.total)),
    tile('Planning', ms(prof.planning), pct(prof.planning, prof.total)),
    tile('Execution', ms(prof.execution), pct(prof.execution, prof.total)),
    tile('Rows returned', count(prof.rows)),
    tile('Rows scanned', count(prof.scanned)),
    prof.memory ? tile('Peak memory', bytes(prof.memory)) : null);

  // The timeline: the phases, the operators in execution order, and what is left of the total.
  const steps = [...prof.phases, ...prof.operators.map(o => ({ ...o, label: o.name })),
    ...(prof.other >= 0.05 * prof.total && prof.other > 1 ? [{ name: 'Other (result, scheduling)', ms: prof.other, kind: 'other' }] : [])];
  let at = 0;
  const rows = steps.map(s => {
    const left = prof.total ? 100 * at / prof.total : 0, width = prof.total ? 100 * s.ms / prof.total : 0;
    at += s.ms;
    return el('div', { class: 'pf-row', title: s.detail ? `${s.name}\n${s.detail}` : s.name },
      el('div', { class: 'pf-name', style: `padding-left:${0.2 + 0.6 * Math.min(s.depth ?? 0, 8)}rem` },
        el('span', { class: 'pf-dot', style: `background:${color(s.kind)}` }), s.name,
        s.detail ? el('span', { class: 'pf-detail' }, s.detail) : null),
      el('div', { class: 'pf-track' },
        el('div', { class: 'pf-bar', style: `left:${left}%;width:max(2px, ${width}%);background:${color(s.kind)}` })),
      el('div', { class: 'pf-ms' }, ms(s.ms)));
  });
  const used = [...new Set(steps.map(s => s.kind))];
  const legend = el('div', { class: 'pf-legend' }, used.map(k => el('span', {}, el('span', { class: 'pf-dot', style: `background:${color(k)}` }), KIND_NAMES[k])));
  // Operators under half a percent of the total are folded away until asked for: a plan has
  // tens of them at a fraction of a millisecond. Their place on the time axis is kept.
  const small = steps.map(s => s.kind !== 'plan' && s.ms < 0.005 * prof.total);
  const folded = small.filter(Boolean).length;
  const fold = hide => rows.forEach((r, i) => { r.hidden = hide && small[i]; });
  const toggle = folded ? el('button', { type: 'button', class: 'btn-tool pf-fold' }) : null;
  const setFold = hide => { fold(hide); toggle.textContent = hide ? `Show all ${steps.length} steps` : `Hide the ${folded} under 0.5%`; toggle.onclick = () => setFold(!hide); };
  if (toggle) setFold(true);
  const timeline = el('section', { class: 'pf-section' },
    el('h4', {}, 'Timeline', el('span', { class: 'pf-note' }, 'phases in order, then each operator’s own time in the order its pipelines run (one thread)'), toggle),
    legend, el('div', { class: 'pf-gantt' }, rows));

  // The most expensive operators.
  const costly = [...prof.operators].sort((a, b) => b.ms - a.ms).slice(0, 8).filter(o => o.ms > 0);
  const table = el('table', { class: 'data-table pf-top' },
    el('thead', {}, el('tr', {}, ['Operator', 'Time', 'Share', 'Rows out', 'Estimated', 'Rows scanned', 'What it does']
      .map((h, i) => el('th', { class: i && i < 6 ? 'pf-num' : '' }, h)))),
    el('tbody', {}, costly.map(o => {
      const off = misestimate(o);
      return el('tr', {},
        el('td', {}, el('span', { class: 'pf-dot', style: `background:${color(o.kind)}` }), o.name),
        el('td', { class: 'pf-num' }, ms(o.ms)),
        el('td', { class: 'pf-num' }, el('span', { class: 'pf-share', style: `--w:${prof.execution ? 100 * o.ms / prof.execution : 0}%` }, pct(o.ms, prof.execution))),
        el('td', { class: 'pf-num' }, count(o.rows)),
        el('td', { class: `pf-num${off ? ' pf-off' : ''}`, title: off ? `DuckDB ${off === 'under' ? 'underestimated' : 'overestimated'} this by ten times or more` : '' },
          o.estimate == null ? '' : `${count(o.estimate)}${off ? (off === 'under' ? ' ▲' : ' ▼') : ''}`),
        el('td', { class: 'pf-num' }, o.scanned ? count(o.scanned) : ''),
        el('td', { class: 'pf-what', title: o.detail }, o.detail));
    })));
  const top = el('section', { class: 'pf-section' },
    el('h4', {}, 'Most expensive operators', el('span', { class: 'pf-note' }, 'share of the execution time; ▲ ▼ an estimate off by ten times or more')), table);

  root.replaceChildren(el('div', { class: 'pf' }, tiles, timeline, top));
}

// Show plan's view: Profile (the default) and Tree, DuckDB's own plan page. `ctx`:
//   profile()   the profile's JSON (runs the query: EXPLAIN ANALYZE)
//   tree()      the plan tree, an element (EXPLAIN (FORMAT html))
//   colors()    kind -> colour, in the page's theme
//   elapsed(t0) a running timer's text
export function createPlanView(ctx) {
  const body = el('div', { class: 'pf-body' });
  const tabs = [['profile', 'Profile'], ['tree', 'Tree']];
  const buttons = tabs.map(([k, t]) => el('button', { type: 'button', class: 'pf-tab', 'data-view': k, onclick: () => show(k) }, t));
  const root = el('div', { class: 'pf-view' }, el('div', { class: 'pf-tabs', role: 'tablist' }, buttons), body);
  const done = {};
  async function show(k) {
    for (const b of buttons) b.classList.toggle('active', b.dataset.view === k);
    if (done[k]) { body.replaceChildren(done[k]); return; }
    const t0 = performance.now(), wait = el('span', { class: 'pf-wait-time' });
    body.replaceChildren(el('div', { class: 'pf-wait' }, el('span', { class: 'ex-spinner', 'aria-hidden': 'true' }),
      k === 'profile' ? 'Profiling (the query runs once more)' : 'Planning', wait));
    const timer = setInterval(() => { wait.textContent = ctx.elapsed(t0); }, 100);
    try {
      let node;
      if (k === 'profile') { node = el('div'); renderProfile(node, parseProfile(await ctx.profile()), ctx.colors()); }
      else node = await ctx.tree();
      done[k] = node;
      if (buttons.find(b => b.classList.contains('active'))?.dataset.view === k) body.replaceChildren(node);
    } catch (e) {
      body.replaceChildren(el('div', { class: 'ex-error' }, `Error: ${e.message}`));
    } finally { clearInterval(timer); }
  }
  show('profile');
  return root;
}
