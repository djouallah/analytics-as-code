// =============================================================================
// explore.js — Analyze's Explore page: a pivot of a semantic model, built by dragging its
// fields onto shelves (Rows, Columns, Values, Filters), drawn as a table or a chart
// =============================================================================
// General purpose: it knows no table, column or measure of any model. It reads the fields
// off the model it is given (TMSL: tables, columns, measures, relationships; hidden ones left
// out), and every view is one query in the page's words (`select`, `where`, `totals`,
// `orderBy`, `top`), run as a SELECT over the model (modelSql, the SQL page's form): the
// figures are the model's measures, a total is a ROLLUP row. What it
// does with the rows is layout: a row of the result goes in a cell of the pivot or a point of
// a chart. The host passes in how to run a query and how to draw (createExplorer's `ctx`).
// =============================================================================

import { formatValue, shade, extent, stackedGrids, shiftDate } from './draw.js';

const CAP = 5000;             // rows asked for at most
const SERIES_CAP = 24;        // series a chart draws at most
const MULTIPLES = 4;          // measures a chart draws, one plot each
const ROW_TOTAL = '__rows_total', COL_TOTAL = '__columns_total';
const TYPES = { string: 'text', int64: 'number', double: 'number', decimal: 'number', dateTime: 'date', boolean: 'bool' };
const ICONS = { text: 'Abc', number: '#', date: '▦', bool: '◐', measure: 'Σ' };
const MARKS = [['auto', 'Automatic'], ['table', 'Table'], ['highlight', 'Highlight'], ['bar', 'Bar'], ['stacked', 'Stacked'],
  ['line', 'Line'], ['area', 'Area'], ['heatmap', 'Heatmap'], ['scatter', 'Scatter']];
const SHELVES = [['rows', 'Rows'], ['cols', 'Columns'], ['values', 'Values'], ['filters', 'Filters']];
const EMPTY = () => ({ rows: [], cols: [], values: [], filters: [], mark: 'auto', totals: true, sort: 'fields' });

// =============================================================================
// The model's fields, the query, the pivot: no DOM (tested in scripts/parity/repo.test.mjs)
// =============================================================================

// Tables with their visible columns and measures, dimensions first (a dimension is a table a
// relationship points to: the model says it, not the names).
export function modelFields(model) {
  const dims = new Set(model.relationships.map(r => r.toTable));
  const tables = model.tables.map(t => ({
    name: t.name, dimension: dims.has(t.name),
    columns: t.columns.filter(c => !c.isHidden).map(c => ({ id: `${t.name}.${c.name}`, kind: 'column', table: t.name,
      name: c.name, type: TYPES[c.dataType] ?? 'text', format: c.formatString, description: c.description })),
    measures: (t.measures ?? []).filter(m => !m.isHidden).map(m => ({ id: m.name, kind: 'measure', table: t.name,
      name: m.name, type: 'measure', format: m.formatString, description: m.description })),
  })).filter(t => t.columns.length || t.measures.length)
    .sort((a, b) => Number(b.dimension) - Number(a.dimension) || a.name.localeCompare(b.name));
  const byId = new Map(tables.flatMap(t => [...t.columns, ...t.measures]).map(f => [f.id, f]));
  return { tables, byId };
}

const nameOf = id => id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;

// A filter as conditions of the query's `where`. "Last n days" ends today, as Tableau's
// relative dates do (a calendar may run into the future, so not its newest date).
function conditions(f, today) {
  switch (f.op) {
    case 'in': case 'notIn': return f.values?.length ? [[f.field, f.op, f.values]] : [];
    case 'range': return [...(f.min != null && f.min !== '' ? [[f.field, '>=', f.min]] : []),
      ...(f.max != null && f.max !== '' ? [[f.field, '<=', f.max]] : [])];
    case 'last': {
      return f.n > 0 ? [[f.field, 'between', shiftDate(today, 1 - f.n), today]] : [];
    }
    case 'blank': case 'notBlank': return [[f.field, f.op]];
  }
  return [];
}

// The shelves as one query. `cap`: the rows asked for at most (0: all, for the CSV).
const localToday = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD
export function buildQuery(s, { cap = CAP, today = localToday() } = {}) {
  const dims = [...s.rows, ...s.cols];
  if (!dims.length && !s.values.length) return null;
  const select = {};
  for (const id of [...dims, ...s.values]) {
    const name = nameOf(id);
    if (name in select) throw new Error(`two fields are named ${name}: keep one of them`);
    select[name] = id;
  }
  const q = { select };
  const where = s.filters.flatMap(f => conditions(f, today));
  if (where.length) q.where = where;
  if (s.totals && s.values.length && dims.length) {
    q.totals = {};
    if (s.rows.length) q.totals[ROW_TOTAL] = [...s.rows];
    if (s.cols.length) q.totals[COL_TOTAL] = [...s.cols];
  }
  const order = s.sort === 'desc' && s.values.length ? [[nameOf(s.values[0]), 'desc'], ...dims.map(nameOf)] : dims.map(nameOf);
  if (order.length) q.orderBy = order;
  if (cap && order.length) q.top = cap;
  return q;
}

// The query as a SELECT over the model, in dax-sql's SQL (the SQL page's form): the model's
// columns (table.column) and its measures as AGG("name"), FROM model, WHERE, GROUP BY ALL or
// ROLLUP for a total (GROUPING names it), ORDER BY, FETCH FIRST n ROWS WITH TIES. What
// Explore runs and shows: the compiler builds the same plan from it as from the query object.
const isColumn = x => /^\w+\.\w+$/.test(x);
const sqlStr = v => `'${String(v).replace(/'/g, "''")}'`;
const sqlVal = v => v == null ? 'NULL' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v)
  : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `DATE ${sqlStr(v)}` : sqlStr(v);
function sqlCondition([col, op, ...a]) {
  const named = vs => vs.filter(v => v != null), blank = vs => vs.some(v => v == null);
  const list = vs => `(${vs.map(sqlVal).join(', ')})`;
  switch (op) {
    case 'between': return `${col} BETWEEN ${sqlVal(a[0])} AND ${sqlVal(a[1])}`;
    case 'blank': return `${col} IS NULL`;
    case 'notBlank': return `${col} IS NOT NULL`;
    case 'in': {
      const n = named(a[0]);
      if (!blank(a[0])) return `${col} IN ${list(n)}`;
      return n.length ? `(${col} IS NULL OR ${col} IN ${list(n)})` : `${col} IS NULL`;
    }
    case 'notIn': {
      const n = named(a[0]);
      return [...(n.length ? [`(${col} NOT IN ${list(n)} OR ${col} IS NULL)`] : []), ...(blank(a[0]) ? [`${col} IS NOT NULL`] : [])].join(' AND ');
    }
    default: return `${col} ${op} ${sqlVal(a[0])}`;
  }
}
export function modelSql(q) {
  const rollup = q.totals ?? {}, rolled = Object.values(rollup).flat();
  const items = [...Object.entries(q.select).map(([n, x]) => `${isColumn(x) ? x : `AGG(${JSON.stringify(x)})`} AS "${n}"`),
    ...Object.entries(rollup).map(([n, cols]) => `GROUPING(${cols[0]}) AS "${n}"`)];
  const keys = Object.values(q.select).filter(isColumn).filter(c => !rolled.includes(c));
  const group = rolled.length
    ? `GROUP BY ${[...keys, ...Object.values(rollup).map(cols => `ROLLUP(${cols.length > 1 ? `(${cols.join(', ')})` : cols[0]})`)].join(', ')}`
    : Object.values(q.select).some(isColumn) ? 'GROUP BY ALL' : '';
  const order = (q.orderBy ?? []).map(o => Array.isArray(o) ? `"${o[0]}" ${o[1].toUpperCase()}` : `"${o}"`);
  return [`SELECT ${items.join(', ')}`, 'FROM model',
    q.where?.length ? `WHERE ${q.where.map(sqlCondition).join('\n  AND ')}` : '', group,
    order.length ? `ORDER BY ${order.join(', ')}` : '',
    q.top != null ? `FETCH FIRST ${q.top} ROWS WITH TIES` : ''].filter(Boolean).join('\n');
}

// Order of the keys of an axis: numbers as numbers, text as a person sorts it.
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x == null) return -1;
    if (y == null) return 1;
    const c = typeof x === 'number' && typeof y === 'number' ? Math.sign(x - y) : String(x).localeCompare(String(y), undefined, { numeric: true });
    if (c) return c;
  }
  return 0;
};

// The rows of the query laid out: the row keys (in the query's order), the column keys
// (sorted), and the row of the result at a pair of them (null for a total).
export function pivot(rows, s) {
  const rowNames = s.rows.map(nameOf), colNames = s.cols.map(nameOf);
  const key = a => a ? JSON.stringify(a) : '*';
  const rowKeys = new Map(), colKeys = new Map(), cells = new Map();
  for (const r of rows) {
    const a = r[ROW_TOTAL] ? null : rowNames.map(n => r[n]);
    const b = r[COL_TOTAL] ? null : colNames.map(n => r[n]);
    if (a) rowKeys.set(key(a), a);
    if (b) colKeys.set(key(b), b);
    cells.set(`${key(a)}|${key(b)}`, r);
  }
  return {
    rowKeys: [...rowKeys.values()],
    colKeys: [...colKeys.values()].sort(compare),
    cell: (a, b) => cells.get(`${key(a)}|${key(b)}`),
    hasRowTotal: rows.some(r => r[ROW_TOTAL]),
    hasColTotal: rows.some(r => r[COL_TOTAL]),
  };
}

// The mark drawn when none is picked, as Tableau's Show Me picks it.
export function autoMark(s, fields) {
  if (!s.values.length || (!s.rows.length && !s.cols.length)) return 'table';
  if (s.rows.length && s.cols.length) return s.values.length === 1 ? 'highlight' : 'table';
  const x = fields.byId.get(s.rows[0] ?? s.cols[0]);
  return x?.type === 'date' || x?.type === 'number' ? 'line' : 'bar';
}

// =============================================================================
// The page
// =============================================================================

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter(k => k != null));
  return n;
};
const label = a => a.length ? a.map(v => v == null ? '(blank)' : String(v)).join(' · ') : 'All';

// `root`: the element the page is built in. `ctx`:
//   model()          the model, TMSL (a promise)
//   run(sql, where)  the rows of a SELECT over the model (modelSql), as objects keyed by the
//                    select's names; `where`: its conditions, for the host's date range
//   chart(el)        an ECharts instance on el, in the page's theme
//   palette()        the colours of series, in order
//   css(name)        a CSS token's value (the chart's tints)
//   storageKey       where the shelves are kept between visits (localStorage)
//   onPlan(shown)    the plan was put in place of the view (true) or taken away (false)
export function createExplorer(root, ctx) {
  let fields = null, state = load(), drag = null, seq = 0, timer = null, result = null, pop = null;

  function load() {
    try { return { ...EMPTY(), ...JSON.parse(localStorage.getItem(ctx.storageKey) ?? 'null') }; } catch { return EMPTY(); }
  }
  function save() { try { localStorage.setItem(ctx.storageKey, JSON.stringify(state)); } catch {} }

  // --- The frame ---
  const search = el('input', { type: 'search', class: 'ex-search', placeholder: 'Search fields', 'aria-label': 'Search fields' });
  const list = el('div', { class: 'ex-list' });
  const pane = el('aside', { class: 'ex-fields' }, search, list);
  const shelfEls = Object.fromEntries(SHELVES.map(([k, t]) => [k, el('div', { class: 'ex-drop', 'data-shelf': k })]));
  const shelves = el('div', { class: 'ex-shelves' }, SHELVES.map(([k, t]) =>
    el('div', { class: 'ex-shelf' }, el('span', { class: 'ex-shelf-name' }, t), shelfEls[k])));
  const marks = el('div', { class: 'ex-marks', role: 'radiogroup', 'aria-label': 'Show me' });
  const totals = el('input', { type: 'checkbox' });
  const sort = el('select', { 'aria-label': 'Sort' }, el('option', { value: 'fields' }, 'Sort by fields'),
    el('option', { value: 'desc' }, 'Sort by first value ↓'));
  const info = el('span', { class: 'ex-info' });
  const tools = el('div', { class: 'ex-tools' }, marks,
    el('label', { class: 'ex-check' }, totals, 'Totals'), sort,
    el('button', { type: 'button', class: 'btn-analyze', title: 'Swap rows and columns', onclick: () => {
      [state.rows, state.cols] = [state.cols, state.rows]; changed(); } }, '⇄ Swap'),
    el('button', { type: 'button', class: 'btn-analyze', onclick: () => { state = { ...EMPTY(), mark: state.mark }; changed(); } }, 'Clear'), info);
  const table = el('div', { class: 'ex-table' });
  const chartBox = el('div', { class: 'ex-chart', id: 'exploreChart' });
  const out = el('div', { class: 'ex-out' }, table, chartBox);
  // The query's SQL and its plan, in place of the view, when the page's Show plan asks for it
  // (showPlan); the next draw (a change of the shelves) puts the view back.
  const plan = el('div', { class: 'ex-plan', hidden: true });
  out.append(plan);
  root.replaceChildren(el('div', { class: 'ex' }, pane, el('section', { class: 'ex-main' }, shelves, tools, out)));

  search.addEventListener('input', renderFields);
  totals.addEventListener('change', () => { state.totals = totals.checked; changed(); });
  sort.addEventListener('change', () => { state.sort = sort.value; changed(); });
  for (const [k, m] of MARKS) {
    marks.append(el('button', { type: 'button', class: 'ex-mark', role: 'radio', 'data-mark': k,
      onclick: () => { state.mark = k; save(); renderControls(); draw(); } }, m));
  }

  // --- Drag and drop: a field onto a shelf, a chip along or between shelves, or off them ---
  const accepts = (shelf, f) => f && (shelf === 'values' ? f.kind === 'measure' : f.kind === 'column');
  for (const [k, box] of Object.entries(shelfEls)) {
    box.addEventListener('dragover', e => {
      const f = drag && fields.byId.get(drag.id);
      if (!accepts(k, f) && !(f?.kind === 'measure' && k !== 'filters')) return;
      e.preventDefault();
      box.classList.add('ex-over');
    });
    box.addEventListener('dragleave', () => box.classList.remove('ex-over'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      box.classList.remove('ex-over');
      if (!drag) return;
      const f = fields.byId.get(drag.id);
      const to = f.kind === 'measure' ? 'values' : k;   // a measure dropped on Rows goes to Values
      const chip = e.target.closest('.ex-chip');
      const at = chip && to === k ? Number(chip.dataset.index) : null;
      place(drag, to, at);
      drag = null;
    });
  }
  pane.addEventListener('dragover', e => { if (drag?.from) e.preventDefault(); });
  pane.addEventListener('drop', e => { e.preventDefault(); if (drag?.from) { removeAt(drag.from, drag.index); drag = null; } });

  function entry(shelf, i) { return shelf === 'filters' ? state.filters[i].field : state[shelf][i]; }
  function removeAt(shelf, i) { state[shelf].splice(i, 1); changed(); }
  function place({ id, from, index }, to, at) {
    let item = to === 'filters' ? { field: id, op: fields.byId.get(id).type === 'text' || fields.byId.get(id).type === 'bool' ? 'in' : 'range', values: [] } : id;
    if (from) {
      const [moved] = state[from].splice(index, 1);
      if (from === to && at != null && at > index) at--;
      if (from === to) item = moved;
      else if (from === 'filters') item = moved.field;
    }
    if (to !== 'filters') {
      const already = state[to].indexOf(item);
      if (already >= 0) state[to].splice(already, 1);
    }
    // Rows and Columns hold a column once between them.
    if (to === 'rows' || to === 'cols') {
      const other = to === 'rows' ? 'cols' : 'rows';
      state[other] = state[other].filter(x => x !== item);
    }
    const list = state[to];
    list.splice(at == null || at > list.length ? list.length : at, 0, item);
    changed();
    if (to === 'filters' && from !== 'filters') {
      const chips = shelfEls.filters.querySelectorAll('.ex-chip');
      editFilter(list.indexOf(item), chips[list.indexOf(item)]);
    }
  }
  // A click on a field puts it on its shelf: a measure on Values, a column on Rows.
  function add(f) {
    const shelf = f.kind === 'measure' ? 'values' : 'rows';
    if (state.values.includes(f.id) || state.rows.includes(f.id) || state.cols.includes(f.id)) return;
    place({ id: f.id }, shelf, null);
  }

  // --- Rendering the controls ---
  function renderFields() {
    if (!fields) return;
    const term = search.value.trim().toLowerCase();
    const used = new Set([...state.rows, ...state.cols, ...state.values]);
    const item = f => {
      const b = el('button', { type: 'button', class: `ex-field${used.has(f.id) ? ' ex-used' : ''}`, draggable: 'true',
        title: f.description ?? f.id, onclick: () => add(f) },
        el('span', { class: `ex-icon ex-${f.type}` }, ICONS[f.type]), f.name);
      b.addEventListener('dragstart', e => { drag = { id: f.id }; e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'copyMove'; });
      b.addEventListener('dragend', () => { drag = null; });
      return b;
    };
    list.replaceChildren(...fields.tables.map(t => {
      const cols = t.columns.filter(f => !term || `${t.name} ${f.name}`.toLowerCase().includes(term));
      const ms = t.measures.filter(f => !term || `${t.name} ${f.name}`.toLowerCase().includes(term));
      if (!cols.length && !ms.length) return null;
      return el('details', { class: 'ex-table-group', open: term || t.dimension ? true : null },
        el('summary', {}, t.name, el('span', { class: 'ex-kind' }, t.dimension ? 'dimension' : 'fact')),
        cols.map(item), ms.map(item));
    }));
  }
  function chipText(shelf, i) {
    if (shelf !== 'filters') return nameOf(state[shelf][i]);
    const f = state.filters[i], n = nameOf(f.field);
    if (f.op === 'in') return f.values.length ? `${n}: ${f.values.length > 2 ? `${f.values.length} values` : f.values.join(', ')}` : `${n}: all`;
    if (f.op === 'notIn') return `${n}: not ${f.values.length > 2 ? `${f.values.length} values` : f.values.join(', ')}`;
    if (f.op === 'last') return `${n}: last ${f.n} days`;
    if (f.op === 'blank') return `${n}: blank`;
    if (f.op === 'notBlank') return `${n}: not blank`;
    if (f.min !== '' && f.min != null && f.max !== '' && f.max != null) return `${n}: ${f.min} – ${f.max}`;
    if (f.min !== '' && f.min != null) return `${n} ≥ ${f.min}`;
    if (f.max !== '' && f.max != null) return `${n} ≤ ${f.max}`;
    return `${n}: all`;
  }
  function renderShelves() {
    for (const [k, box] of Object.entries(shelfEls)) {
      const items = state[k];
      box.replaceChildren(...items.map((_, i) => {
        const f = fields?.byId.get(entry(k, i));
        const chip = el('span', { class: `ex-chip${f?.kind === 'measure' ? ' ex-measure' : ''}${f ? '' : ' ex-missing'}`,
          draggable: 'true', 'data-index': i, title: f ? entry(k, i) : `${entry(k, i)}: not in the model` },
          el('button', { type: 'button', class: 'ex-chip-name', onclick: e => k === 'filters' && editFilter(i, e.currentTarget.parentNode) }, chipText(k, i)),
          el('button', { type: 'button', class: 'ex-x', 'aria-label': `Remove ${chipText(k, i)}`, onclick: () => removeAt(k, i) }, '×'));
        chip.addEventListener('dragstart', e => { drag = { id: entry(k, i), from: k, index: i }; e.dataTransfer.setData('text/plain', entry(k, i)); });
        chip.addEventListener('dragend', () => { drag = null; });
        return chip;
      }));
      if (!items.length) box.append(el('span', { class: 'ex-hint' },
        k === 'values' ? 'Drop measures here' : k === 'filters' ? 'Drop a column to filter on it' : 'Drop columns here'));
    }
  }
  function renderControls() {
    totals.checked = state.totals;
    sort.value = state.sort;
    const auto = fields ? autoMark(state, fields) : 'table';
    for (const b of marks.children) {
      const on = b.dataset.mark === state.mark;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('ex-auto', state.mark === 'auto' && b.dataset.mark === auto);
    }
  }

  // --- The filter editor ---
  function closePop() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); }
  function outside(e) { if (pop && !pop.contains(e.target)) closePop(); }
  async function editFilter(i, anchor) {
    closePop();
    const f = state.filters[i], fd = fields.byId.get(f.field);
    if (!fd) return;
    const draft = { ...f, values: [...(f.values ?? [])] };
    const body = el('div', { class: 'ex-pop-body' });
    const apply = () => { state.filters[i] = draft; closePop(); changed(); };
    pop = el('div', { class: 'ex-pop', role: 'dialog', 'aria-label': `Filter ${fd.name}` },
      el('div', { class: 'ex-pop-head' }, fd.id), body,
      el('div', { class: 'ex-pop-foot' },
        el('button', { type: 'button', class: 'btn-analyze', onclick: closePop }, 'Cancel'),
        el('button', { type: 'button', class: 'btn-analyze primary', onclick: apply }, 'Apply')));
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') apply(); });
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    setTimeout(() => document.addEventListener('pointerdown', outside, true));

    const modes = fd.type === 'text' || fd.type === 'bool'
      ? [['in', 'Keep only'], ['notIn', 'Exclude'], ['blank', 'Blank'], ['notBlank', 'Not blank']]
      : [['range', 'Range'], ...(fd.type === 'date' ? [['last', 'Last n days']] : []), ['blank', 'Blank'], ['notBlank', 'Not blank']];
    const mode = el('select', { 'aria-label': 'Condition' }, modes.map(([v, t]) => el('option', { value: v }, t)));
    mode.value = modes.some(([v]) => v === draft.op) ? draft.op : modes[0][0];
    draft.op = mode.value;
    const detail = el('div');
    body.append(mode, detail);
    mode.addEventListener('change', () => { draft.op = mode.value; fill(); });
    let values = null;
    async function fill() {
      if (draft.op === 'blank' || draft.op === 'notBlank') { detail.replaceChildren(); return; }
      if (draft.op === 'range') {
        const input = k => {
          const box = el('input', { type: fd.type === 'date' ? 'date' : 'number', step: 'any', value: draft[k] ?? '', 'aria-label': k });
          box.addEventListener('input', () => { draft[k] = box.value === '' ? '' : fd.type === 'number' ? Number(box.value) : box.value; });
          return box;
        };
        detail.replaceChildren(el('label', {}, 'From', input('min')), el('label', {}, 'To', input('max')));
        return;
      }
      if (draft.op === 'last') {
        draft.n ??= 7;
        const box = el('input', { type: 'number', min: 1, step: 1, value: draft.n, 'aria-label': 'days' });
        box.addEventListener('input', () => { draft.n = Math.max(1, Math.round(Number(box.value) || 1)); });
        detail.replaceChildren(el('label', {}, 'Days up to today', box));
        return;
      }
      // A list of the column's values to tick.
      detail.replaceChildren(el('div', { class: 'ex-hint' }, 'Reading values…'));
      try {
        values ??= (await ctx.run(modelSql({ select: { v: fd.id }, orderBy: ['v'], top: 1000 }))).map(r => r.v);
      } catch (e) { detail.replaceChildren(el('div', { class: 'ex-error' }, e.message)); return; }
      const picked = new Set(draft.values);
      const find = el('input', { type: 'search', placeholder: 'Search values' });
      const boxes = el('div', { class: 'ex-values' });
      const show = () => boxes.replaceChildren(...values.filter(v => String(v).toLowerCase().includes(find.value.toLowerCase())).map(v => {
        const c = el('input', { type: 'checkbox', checked: picked.has(v) });
        c.addEventListener('change', () => { if (c.checked) picked.add(v); else picked.delete(v); draft.values = values.filter(x => picked.has(x)); });
        return el('label', {}, c, v == null ? '(blank)' : String(v));
      }));
      find.addEventListener('input', show);
      const all = on => () => { picked.clear(); if (on) values.filter(v => String(v).toLowerCase().includes(find.value.toLowerCase())).forEach(v => picked.add(v)); draft.values = values.filter(x => picked.has(x)); show(); };
      detail.replaceChildren(find, el('div', { class: 'ex-row' },
        el('button', { type: 'button', class: 'btn-analyze', onclick: all(true) }, 'All'),
        el('button', { type: 'button', class: 'btn-analyze', onclick: all(false) }, 'None'),
        values.length >= 1000 ? el('span', { class: 'ex-hint' }, 'first 1,000 values') : null), boxes);
      show();
    }
    fill();
  }

  // --- Running ---
  function changed() {
    save();
    renderShelves();
    renderFields();
    renderControls();
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  }
  async function run() {
    const my = ++seq;
    let q;
    try {
      q = buildQuery(state);
    } catch (e) { result = null; info.textContent = e.message; info.className = 'ex-info ex-error'; draw(); return; }
    if (!q) { result = null; info.textContent = ''; draw(); return; }
    info.className = 'ex-info';
    info.textContent = 'Running…';
    try {
      const rows = await ctx.run(modelSql(q), q.where);
      if (my !== seq) return;
      result = { state: structuredClone(state), rows };
      const n = rows.filter(r => !r[ROW_TOTAL] && !r[COL_TOTAL]).length;
      info.textContent = rows.length >= CAP ? `${n.toLocaleString()} rows (the first ${CAP.toLocaleString()}: add a filter for all of them)`
        : `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
      draw();
    } catch (e) {
      if (my !== seq) return;
      result = null;
      info.className = 'ex-info ex-error';
      info.textContent = e.message?.includes('Out of Memory') ? 'Out of memory: add a filter.' : `Error: ${e.message}`;
      draw();
    }
  }
  // --- Drawing ---
  function draw() {
    if (!plan.hidden) { plan.hidden = true; plan.replaceChildren(); ctx.onPlan?.(false); }
    if (!result) {
      chartBox.hidden = true;
      table.hidden = false;
      table.replaceChildren(el('div', { class: 'ex-empty' }, fields
        ? 'Drag columns onto Rows and Columns and measures onto Values, or click a field to add it.' : 'Reading the model…'));
      return;
    }
    const s = result.state, mark = state.mark === 'auto' ? autoMark(s, fields) : state.mark;
    const piv = pivot(result.rows, s);
    if (mark === 'table' || mark === 'highlight' || !s.values.length) {
      chartBox.hidden = true;
      table.hidden = false;
      drawTable(s, piv, mark === 'highlight');
      return;
    }
    const option = chartOption(s, piv, mark);
    if (typeof option === 'string') {
      chartBox.hidden = true;
      table.hidden = false;
      table.replaceChildren(el('div', { class: 'ex-empty' }, option));
      return;
    }
    table.hidden = true;
    chartBox.hidden = false;
    const chart = ctx.chart(chartBox);
    chart.setOption(option, true);
    chart.resize();
  }

  const fmt = (id, v) => formatValue(v, fields.byId.get(id)?.format);
  function drawTable(s, piv, highlight) {
    const measures = s.values, rowNames = s.rows.map(nameOf);
    const colKeys = [...piv.colKeys, ...(s.cols.length && piv.hasColTotal ? [null] : [])];
    const rowKeys = [...piv.rowKeys, ...(piv.hasRowTotal ? [null] : [])];
    const tint = ctx.palette()[0];
    const ranges = Object.fromEntries(measures.map(m => [m, extent(piv.rowKeys.flatMap(a => piv.colKeys.map(b => piv.cell(a, b)?.[nameOf(m)])))]));
    const t = el('table', { class: 'analyze-table ex-pivot' });
    const head = el('thead');
    // One header line per column field, then the measures' names when there are several (or no column field).
    const lead = text => el('th', { class: 'ex-rowhead', scope: 'col' }, text);
    for (let level = 0; level < s.cols.length; level++) {
      const tr = el('tr');
      // The column field's name, before its values.
      rowNames.forEach((n, i) => tr.append(lead(i === rowNames.length - 1 ? `${nameOf(s.cols[level])} →` : '')));
      if (!rowNames.length) tr.append(lead(`${nameOf(s.cols[level])} →`));
      for (const b of colKeys) tr.append(el('th', { colspan: measures.length || 1, class: 'ex-colhead' }, b ? label([b[level]]) : level ? '' : 'Total'));
      head.append(tr);
    }
    // The row fields' names, and the measure each column holds.
    if (measures.length || !s.cols.length) {
      const tr = el('tr');
      rowNames.forEach(n => tr.append(lead(n)));
      if (!rowNames.length && s.cols.length) tr.append(lead(''));
      for (const b of s.cols.length ? colKeys : [[]]) for (const m of measures) tr.append(el('th', { class: 'ex-num' }, m));
      head.append(tr);
    }
    const body = el('tbody');
    let prev = [];
    for (const a of rowKeys) {
      const tr = el('tr', { class: a ? '' : 'ex-total' });
      if (a) {
        a.forEach((v, i) => {
          const same = prev.length > i && a.slice(0, i + 1).every((v2, j) => prev[j] === v2);
          tr.append(el('th', { scope: 'row', class: same ? 'ex-repeat' : '' }, v == null ? '(blank)' : String(v)));
        });
        prev = a;
      } else if (rowNames.length) {
        tr.append(el('th', { scope: 'row', colspan: rowNames.length }, 'Total'));
      }
      if (!rowNames.length && s.cols.length) tr.append(el('th', { scope: 'row' }, ''));
      for (const b of s.cols.length ? colKeys : [[]]) {
        const r = piv.cell(a, b);
        for (const m of measures) {
          const v = r?.[nameOf(m)];
          const td = el('td', { class: 'ex-num' }, fmt(m, v));
          if (highlight && a && b) {
            const [lo, hi] = ranges[m], p = shade(v, lo, hi);
            if (p) td.style.background = `color-mix(in srgb, ${tint} ${p}%, transparent)`;
          }
          tr.append(td);
        }
      }
      body.append(tr);
    }
    t.append(head, body);
    table.replaceChildren(t);
  }

  function chartOption(s, piv, mark) {
    const colors = ctx.palette();
    const color = i => colors[i % colors.length];
    // The categories are the row keys; with no row field, the column keys are.
    const byCols = !s.rows.length;
    const cats = byCols ? piv.colKeys : piv.rowKeys;
    const series = byCols ? [[]] : piv.colKeys.length ? piv.colKeys : [[]];
    const at = (cat, ser) => byCols ? piv.cell([], cat) : piv.cell(cat, ser);
    const shown = series.slice(0, SERIES_CAP);
    const cut = series.length > SERIES_CAP ? ` (the first ${SERIES_CAP} of ${series.length} series)` : '';

    if (mark === 'heatmap') {
      if (!s.rows.length || !s.cols.length) return 'A heatmap needs a field on Rows and one on Columns.';
      const m = s.values[0], n = nameOf(m);
      const cells = [];
      piv.rowKeys.forEach((a, y) => piv.colKeys.forEach((b, x) => { const v = piv.cell(a, b)?.[n]; if (v != null) cells.push([x, y, v]); }));
      const [lo, hi] = extent(cells.map(c => c[2]));
      return {
        title: { text: m + cut, left: 4, top: 0, textStyle: { fontSize: 12, fontWeight: 600 } },
        tooltip: { position: 'top', formatter: p => `${label(piv.rowKeys[p.value[1]])} · ${label(piv.colKeys[p.value[0]])}<br><b>${fmt(m, p.value[2])}</b>` },
        grid: { left: 4, right: 16, top: 28, bottom: 44, containLabel: true },
        xAxis: { type: 'category', data: piv.colKeys.map(label), splitArea: { show: true } },
        yAxis: { type: 'category', data: piv.rowKeys.map(label), inverse: true, splitArea: { show: true } },
        visualMap: { min: lo, max: hi, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120,
          inRange: { color: [ctx.css('--raised'), color(0)] }, formatter: v => fmt(m, v) },
        series: [{ type: 'heatmap', data: cells, label: { show: cells.length <= 150, formatter: p => fmt(m, p.value[2]), fontSize: 10 } }],
      };
    }
    if (mark === 'scatter') {
      if (s.values.length < 2) return 'A scatter needs two measures on Values: the first across, the second up.';
      const [mx, my] = s.values, [nx, ny] = [nameOf(mx), nameOf(my)];
      return {
        tooltip: { trigger: 'item', formatter: p => `${p.data.name}<br>${mx}: <b>${fmt(mx, p.data.value[0])}</b><br>${my}: <b>${fmt(my, p.data.value[1])}</b>` },
        legend: shown.length > 1 ? { type: 'scroll', top: 0 } : undefined,
        grid: { left: 4, right: 16, top: shown.length > 1 ? 56 : 32, bottom: 24, containLabel: true },
        xAxis: { type: 'value', name: mx + cut, nameLocation: 'middle', nameGap: 26, scale: true, axisLabel: { formatter: v => fmt(mx, v) } },
        yAxis: { type: 'value', name: my, scale: true, axisLabel: { formatter: v => fmt(my, v) } },
        series: shown.map((b, i) => ({
          type: 'scatter', name: label(b), symbolSize: 8, itemStyle: { color: color(i), opacity: 0.8 },
          data: cats.map(a => { const r = at(a, b); return r?.[nx] != null && r?.[ny] != null ? { name: label(a), value: [r[nx], r[ny]] } : null; }).filter(Boolean),
        })),
      };
    }
    // Bar, stacked bar, line, area: one plot per measure, the series the column keys.
    const ms = s.values.slice(0, MULTIPLES);
    const xField = fields.byId.get(byCols ? s.cols[0] : s.rows[0]);
    const flat = (mark === 'bar' || mark === 'stacked') && xField?.type === 'text';   // names read across, bars lie down
    const legend = shown.length > 1;
    const grids = stackedGrids(ms.length, legend ? 7 : 0);
    const catAxis = (i, more) => ({ type: 'category', gridIndex: i, data: cats.map(label), inverse: flat,
      axisLabel: { show: flat || i === ms.length - 1, hideOverlap: true }, ...more });
    const valAxis = (i, m) => ({ type: 'value', gridIndex: i,
      axisLabel: { formatter: v => fmt(m, v), hideOverlap: true }, splitNumber: ms.length > 2 ? 2 : 4 });
    return {
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: mark === 'line' || mark === 'area' ? 'line' : 'shadow' },
        formatter: ps => [ps[0]?.axisValueLabel, ...ps.filter(p => p.value != null).map(p => {
          const m = ms[Math.floor(p.seriesIndex / shown.length)];
          return `${p.marker}${shown.length > 1 ? `${p.seriesName} · ` : ''}${m}: <b>${fmt(m, p.value)}</b>`;
        })].join('<br>') },
      legend: legend ? { type: 'scroll', top: 0, data: shown.map(label) } : undefined,
      title: ms.map((m, i) => ({ text: i ? m : m + cut, top: grids[i].title, left: 4, textStyle: { fontSize: 12, fontWeight: 600 } })),
      grid: grids.map(g => g.grid),
      dataZoom: !flat && cats.length > 60 ? [{ type: 'inside', xAxisIndex: ms.map((_, i) => i) }] : [],
      xAxis: ms.map((m, i) => flat ? valAxis(i, m) : catAxis(i, { boundaryGap: mark === 'bar' || mark === 'stacked' })),
      yAxis: ms.map((m, i) => flat ? catAxis(i) : valAxis(i, m)),
      series: ms.flatMap((m, i) => shown.map((b, j) => ({
        type: mark === 'line' || mark === 'area' ? 'line' : 'bar', name: label(b), xAxisIndex: i, yAxisIndex: i,
        stack: mark === 'stacked' || mark === 'area' ? `s${i}` : undefined,
        areaStyle: mark === 'area' ? { opacity: 0.85 } : undefined, showSymbol: false, connectNulls: false,
        itemStyle: { color: color(j) }, lineStyle: mark === 'line' ? { width: 1.6 } : undefined,
        barMaxWidth: 28, large: cats.length > 400,
        data: cats.map(a => at(a, b)?.[nameOf(m)] ?? null),
      }))),
    };
  }

  // --- Start ---
  renderControls();
  draw();
  const ready = ctx.model().then(model => {
    fields = modelFields(model);
    renderFields();
    renderShelves();
    renderControls();
    run();
  }, e => { table.replaceChildren(el('div', { class: 'ex-error' }, `Could not read the model: ${e.message}`)); });

  return {
    ready,
    // The theme changed: the chart is drawn again in the new one.
    redraw: () => { if (fields) draw(); },
    // The shelves as one SELECT over the model, all its rows, and its date filter (the page's
    // Download CSV and Show plan), or null.
    query: () => { const q = buildQuery(state, { cap: 0 }); return q && { sql: modelSql(q), where: q.where }; },
    // The query's SQL and plan shown in place of the view (the page's Show plan); null puts
    // the view back.
    // `shown`: the SELECT over the model, and the plan, an element the page builds.
    showPlan: shown => {
      if (shown == null) { draw(); return; }
      plan.replaceChildren(el('pre', { class: 'ex-plan-sql' }, shown.sql), shown.plan);
      table.hidden = true; chartBox.hidden = true; plan.hidden = false;
      ctx.onPlan?.(true);
    },
    planShown: () => !plan.hidden,
  };
}
