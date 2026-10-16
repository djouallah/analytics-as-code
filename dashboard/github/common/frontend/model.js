// =============================================================================
// model.js — the Analyze tab's Model page: the semantic model (ossie.yaml) as a star, and
// what the model says of the table picked
// =============================================================================
// The same file on every host. It reads semantic/ossie.json (the repo's ossie.yaml, staged
// next to semantic/query.js) with this module's own ?v= as query.js does, as the TMSL it
// stands for (dax-sql's formats/ossie.js), the model Power BI runs. A dimension is a
// table a relationship points to, a fact any other: the model says it, not the names. Where
// each card and line goes is draw.js's (modelLayout). Hover a table to see what it reaches;
// click it for its columns, measures and relationships. index.html has the page and calls
// renderModel() when it is shown; it is built once.
// =============================================================================

import { modelLayout, MODEL_CARD } from './draw.js';
import { ossieToTmsl } from '../semantic/formats/ossie.js';

const SVG = 'http://www.w3.org/2000/svg';
let _built = null;
let _selected = null;

const el = (tag, attrs = {}, text) => {
  const n = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const lines = v => Array.isArray(v) ? v.join('\n') : v ?? '';

// The model as TMSL, read once: the Model page and Explore share it.
let _model = null;
export function loadModel() {
  return _model ??= (async () => {
    const url = new URL('../semantic/ossie.json' + new URL(import.meta.url).search, import.meta.url);
    return ossieToTmsl(await (await fetch(url)).json()).model;
  })().catch(e => { _model = null; throw e; });
}

export function renderModel() {
  _built ??= build().catch(e => {
    _built = null;
    document.getElementById('modelPanel').replaceChildren(el('p', {}, `Could not read the model: ${e.message}`));
  });
  return _built;
}

async function build() {
  const model = await loadModel();
  const rels = model.relationships;
  const keys = name => [...new Set(rels.flatMap(r => [
    ...(r.fromTable === name ? [r.fromColumn] : []), ...(r.toTable === name ? [r.toColumn] : [])]))];
  const tables = model.tables.map(t => ({ ...t, keys: keys(t.name), lines: 1 + keys(t.name).length }));
  const byName = Object.fromEntries(tables.map(t => [t.name, t]));
  const layout = modelLayout(tables, rels);

  const svg = document.getElementById('modelSvg');
  svg.setAttribute('viewBox', `-12 -4 ${layout.width + 24} ${layout.height + 8}`);
  svg.style.maxWidth = `${layout.width + 24}px`;
  const edges = el('svg:g'), cards = el('svg:g');
  const edgeEls = layout.edges.map(e => {
    const g = el('svg:g', { class: 'm-rel' });
    g.dataset.from = e.from; g.dataset.to = e.to;
    g.append(el('svg:path', { class: `m-edge${e.active ? '' : ' m-inactive'}`, d: e.d }));
    for (const m of [e.many, e.one]) g.append(el('svg:text', { class: 'm-mark', x: m.x, y: m.y, 'text-anchor': m.anchor }, m.text));
    if (e.both) g.append(el('svg:text', { class: 'm-mark', x: e.mid.x, y: e.mid.y, 'text-anchor': 'middle', dy: '-4' }, '⇅'));
    edges.append(g);
    return g;
  });
  const { w, head, line } = MODEL_CARD;
  const cardEls = tables.map(t => {
    const b = layout.boxes[t.name];
    const g = el('svg:g', { class: `m-card ${b.dim ? 'dim' : 'fact'}`, transform: `translate(${b.x},${b.y})`, tabindex: 0, role: 'button', 'aria-label': t.name });
    g.dataset.name = t.name;
    g.append(el('svg:rect', { class: 'm-box', width: w, height: b.h, rx: 8 }));
    g.append(el('svg:text', { class: 'm-name', x: 12, y: 20 }, t.name));
    g.append(el('svg:line', { class: 'm-sep', x1: 0, x2: w, y1: head, y2: head }));
    const n = (a, word) => `${a?.length ?? 0} ${word}${a?.length === 1 ? '' : 's'}`;
    g.append(el('svg:text', { class: 'm-cap', x: 12, y: head + 13 }, `${b.dim ? 'dimension' : 'fact'} · ${n(t.columns, 'column')} · ${n(t.measures, 'measure')}`));
    t.keys.forEach((k, i) => g.append(el('svg:text', { class: 'm-key', x: 12, y: head + 13 + line * (i + 1) }, `⚷ ${k}`)));
    g.addEventListener('pointerenter', () => highlight(t.name));
    g.addEventListener('pointerleave', () => highlight(_selected));
    g.addEventListener('focus', () => highlight(t.name));
    g.addEventListener('blur', () => highlight(_selected));
    g.addEventListener('click', e => { e.stopPropagation(); select(t.name); });
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(t.name); } });
    cards.append(g);
    return g;
  });
  svg.replaceChildren(edges, cards);
  svg.addEventListener('click', () => select(null));

  function highlight(name) {
    const near = new Set(name ? [name] : []);
    for (const g of edgeEls) {
      const on = g.dataset.from === name || g.dataset.to === name;
      if (on) { near.add(g.dataset.from); near.add(g.dataset.to); }
      g.classList.toggle('m-on', on);
      g.classList.toggle('m-off', Boolean(name) && !on);
    }
    for (const g of cardEls) {
      g.classList.toggle('m-on', near.has(g.dataset.name));
      g.classList.toggle('m-off', Boolean(name) && !near.has(g.dataset.name));
      g.classList.toggle('m-sel', g.dataset.name === _selected);
    }
  }
  function select(name) {
    _selected = name;
    highlight(name);
    panel(name ? byName[name] : null);
  }

  function panel(t) {
    const out = [];
    if (!t) {
      const measures = tables.flatMap(x => x.measures ?? []);
      out.push(el('h3', {}, 'Semantic model'));
      out.push(el('p', {}, `${tables.length} tables · ${rels.length} relationships · ${measures.length} measures (${measures.filter(m => m.isHidden).length} hidden). The Apache Ossie model the page's queries are compiled against, and the one Power BI runs in Direct Lake.`));
      if (model.description) out.push(el('p', {}, lines(model.description)));
      out.push(el('p', { class: 'm-hint' }, 'Hover a table to see what it reaches; click it for its columns, measures and relationships.'));
      document.getElementById('modelPanel').replaceChildren(...out);
      return;
    }
    const isDim = rels.some(r => r.toTable === t.name);
    const title = el('h3', {}, t.name);
    title.append(el('span', { class: 'm-tag' }, isDim ? 'dimension' : 'fact'));
    out.push(title);
    const src = t.partitions?.[0]?.source;
    if (src?.entityName) out.push(el('p', { class: 'm-src' }, `${t.partitions[0].mode ?? ''} · ${src.schemaName ? `${src.schemaName}.` : ''}${src.entityName}`));
    if (t.description) out.push(el('p', {}, lines(t.description)));

    const mine = rels.filter(r => r.fromTable === t.name || r.toTable === t.name);
    if (mine.length) {
      out.push(el('h4', {}, `Relationships (${mine.length})`));
      const ul = el('ul', { class: 'm-rels' });
      for (const r of mine) {
        // Many to one; the other table is a link to it.
        const end = (table, column) => {
          if (table === t.name) return [`[${column}]`];
          const a = el('a', { href: '#' }, table);
          a.addEventListener('click', e => { e.preventDefault(); select(table); });
          return [a, `[${column}]`];
        };
        const li = el('li');
        li.append(...end(r.fromTable, r.fromColumn), ' * → ', ...end(r.toTable, r.toColumn), ' 1');
        if (r.crossFilteringBehavior === 'bothDirections') li.append(el('span', { class: 'm-tag' }, 'both directions'));
        if (r.isActive === false) li.append(el('span', { class: 'm-tag' }, 'inactive'));
        ul.append(li);
      }
      out.push(ul);
    }

    out.push(el('h4', {}, `Columns (${t.columns?.length ?? 0})`));
    const table = el('table', { class: 'analyze-table m-cols' });
    const hr = el('tr');
    for (const h of ['Column', 'Type', 'Format']) hr.append(el('th', {}, h));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(hr);
    for (const c of t.columns ?? []) {
      const tr = el('tr');
      const name = el('td', {}, c.name);
      if (t.keys.includes(c.name)) name.prepend('⚷ ');
      if (c.isHidden) name.append(el('span', { class: 'm-tag' }, 'hidden'));
      if (c.description) name.append(el('div', { class: 'm-desc' }, lines(c.description)));
      tr.append(name, el('td', {}, c.dataType ?? ''), el('td', {}, c.formatString ?? ''));
      table.tBodies[0].append(tr);
    }
    out.push(table);

    if (t.measures?.length) {
      out.push(el('h4', {}, `Measures (${t.measures.length})`));
      for (const m of t.measures) {
        const d = el('details', { class: 'm-measure' });
        const s = el('summary', {}, m.name);
        if (m.isHidden) s.append(el('span', { class: 'm-tag' }, 'hidden'));
        if (m.formatString) s.append(el('span', { class: 'm-fmt' }, m.formatString));
        d.append(s, el('pre', {}, lines(m.expression)));
        if (m.description) d.append(el('p', {}, lines(m.description)));
        out.push(d);
      }
    }
    const box = document.getElementById('modelPanel');
    box.replaceChildren(...out);
    box.scrollTop = 0;
  }

  panel(null);
}
