// The semantic model: a TMSL model (model.bim) read into tables, columns, measures and
// relationships, and the two questions the compiler asks of relationships:
//   expand(table)      the tables whose columns a row of `table` reaches by following
//                      relationships from the many side to the one side (DAX's expanded
//                      table), each with the path of joins that reaches it
//   reaches(from, to)  whether a filter on `from` propagates to `to`
// Both depend on which relationships are active and in which direction they filter, which
// USERELATIONSHIP and CROSSFILTER change inside a CALCULATE: a `RelState` says that.
// Names are looked up without regard to case, as in DAX.
import { semantic } from './errors.js';

const TYPES = { string: 'string', int64: 'int', double: 'double', decimal: 'decimal', dateTime: 'datetime',
  boolean: 'bool', binary: 'string', variant: 'variant', unknown: 'variant' };

const lc = s => String(s).toLowerCase();
const text = e => Array.isArray(e) ? e.join('\n') : e ?? '';

export class Model {
  constructor(bim) {
    const m = bim.model ?? bim;
    if (!Array.isArray(m?.tables)) throw semantic('the model has no tables (expected a TMSL model.bim)');
    this.tables = new Map();
    this.measures = new Map();
    for (const t of m.tables) this.addTable(t);
    this.relationships = (m.relationships ?? []).map((r, i) => this.relationship(r, i));
    // A column is unique when it is a key, or the one side of a relationship.
    for (const r of this.relationships) {
      if (r.toCard === 'one') r.to.unique = true;
      if (r.fromCard === 'one') r.from.unique = true;
    }
    for (const t of this.tables.values()) t.key ??= t.columns.find(c => c.unique) ?? null;
    this._state = new Map();
    this._expand = new Map();
  }

  addTable(t) {
    const table = { name: t.name, columns: [], colMap: new Map(), key: null, dataCategory: t.dataCategory ?? null,
      source: sourceOf(t), hidden: !!t.isHidden };
    for (const c of t.columns ?? []) {
      if (c.type === 'rowNumber') continue;
      const col = {
        table, name: c.name, id: `${lc(t.name)}[${lc(c.name)}]`,
        type: TYPES[c.dataType] ?? 'variant',
        source: c.sourceColumn ?? c.name,
        expr: c.type === 'calculated' ? text(c.expression) : null,
        unique: !!c.isKey, dataCategory: c.dataCategory ?? null,
      };
      if (c.isKey) table.key = col;
      table.columns.push(col);
      table.colMap.set(lc(c.name), col);
    }
    this.tables.set(lc(t.name), table);
    for (const ms of t.measures ?? []) this.addMeasure(table, ms.name, text(ms.expression));
    return table;
  }

  addMeasure(table, name, expression) {
    this.measures.set(lc(name), { name, table, text: expression, ast: null });
  }

  relationship(r, i) {
    const from = this.column(r.fromTable, r.fromColumn), to = this.column(r.toTable, r.toColumn);
    return {
      name: r.name ?? `rel${i}`, from, to,
      active: r.isActive !== false,
      cross: r.crossFilteringBehavior === 'bothDirections' ? 'both' : 'single',
      fromCard: r.fromCardinality ?? 'many',
      toCard: r.toCardinality ?? 'one',
      ri: !!r.relyOnReferentialIntegrity,
    };
  }

  table(name) {
    const t = this.tables.get(lc(name));
    if (!t) throw semantic(`the model has no table '${name}'`);
    return t;
  }
  hasTable(name) { return this.tables.has(lc(name)); }
  column(table, name) {
    const t = typeof table === 'string' ? this.table(table) : table;
    const c = t.colMap.get(lc(name));
    if (!c) throw semantic(`the model has no column '${t.name}'[${name}]`);
    return c;
  }
  findColumn(table, name) {
    const t = this.tables.get(lc(table));
    return t?.colMap.get(lc(name)) ?? null;
  }
  measure(name) { return this.measures.get(lc(name)) ?? null; }

  // A copy for one query: DEFINE MEASURE adds to it, not to the model.
  fork() {
    const f = Object.create(Model.prototype);
    Object.assign(f, this);
    f.measures = new Map(this.measures);
    return f;
  }

  // The relationships as a RelState changes them: [{ rel, active, cross }], cross one of
  // 'single' (one side filters many), 'both', 'none', 'reverse' (many side filters one).
  state(mods) {
    const key = mods ? JSON.stringify([[...mods.active], [...mods.cross]]) : '';
    let s = this._state.get(key);
    if (!s) {
      s = this.relationships.map(rel => {
        let active = rel.active, cross = rel.cross;
        if (mods?.active.has(rel.name)) active = mods.active.get(rel.name);
        if (mods?.cross.has(rel.name)) cross = mods.cross.get(rel.name);
        // A one-to-one relationship filters both ways.
        if (rel.fromCard === 'one' && rel.toCard === 'one' && cross === 'single') cross = 'both';
        return { rel, active, cross };
      });
      s.key = key;
      this._state.set(key, s);
    }
    return s;
  }

  // The expanded table of `table`: Map(table name -> [hops]) where a hop is
  // { rel, from: column on this side, to: column on the far side }. `exclude` names tables
  // the walk does not enter. For filters, a relationship CROSSFILTER turned off (or turned
  // to filter the other way) is not followed; for `lookup` (RELATED, reading a related
  // column) every active one is.
  expand(table, state, exclude = null, lookup = false) {
    const key = `${table.name}|${state.key}|${exclude ? [...exclude].sort().join(',') : ''}|${lookup}`;
    let out = this._expand.get(key);
    if (out) return out;
    out = new Map([[table.name, []]]);
    const queue = [table];
    while (queue.length) {
      const t = queue.shift(), path = out.get(t.name);
      for (const { rel, active, cross } of state) {
        if (!active || rel.fromCard === 'many' && rel.toCard === 'many') continue;
        if (!lookup && (cross === 'none' || cross === 'reverse')) continue;
        // Many side to one side; a one-to-one relationship expands both ways.
        let hop = null;
        if (rel.from.table === t) hop = { rel, from: rel.from, to: rel.to };
        else if (rel.to.table === t && rel.fromCard === 'one') hop = { rel, from: rel.to, to: rel.from };
        if (!hop) continue;
        const next = hop.to.table;
        if (out.has(next.name) || exclude?.has(next.name)) continue;
        out.set(next.name, [...path, hop]);
        queue.push(next);
      }
    }
    this._expand.set(key, out);
    return out;
  }

  // The edges along which a filter moves into `table` from a table that is not in its
  // expanded table: the one side of a bidirectional relationship from its many side, and
  // either side of a many-to-many relationship. [{ rel, here: column of `table`, there }].
  inbound(table, state) {
    const out = [];
    for (const { rel, active, cross } of state) {
      if (!active || cross === 'none') continue;
      const mm = rel.fromCard === 'many' && rel.toCard === 'many';
      if (rel.to.table === table && rel.fromCard === 'many' && (cross === 'both' || cross === 'reverse' || mm && cross !== 'single'))
        out.push({ rel, here: rel.to, there: rel.from });
      if (mm && rel.from.table === table && cross !== 'reverse') out.push({ rel, here: rel.from, there: rel.to });
    }
    return out;
  }

  // Whether a filter on table `from` reaches table `to`.
  reaches(from, to, state) {
    if (from === to) return true;
    const seen = new Set([from.name]), queue = [from];
    while (queue.length) {
      const t = queue.shift();
      for (const { rel, active, cross } of state) {
        if (!active || cross === 'none') continue;
        const mm = rel.fromCard === 'many' && rel.toCard === 'many';
        const steps = [];
        // One side to many side, unless the direction is reversed.
        if (rel.to.table === t && cross !== 'reverse') steps.push(rel.from.table);
        if (rel.from.table === t && (cross === 'both' || cross === 'reverse' || rel.fromCard === 'one' || mm && cross !== 'single')) steps.push(rel.to.table);
        for (const n of steps) {
          if (n === to) return true;
          if (!seen.has(n.name)) { seen.add(n.name); queue.push(n); }
        }
      }
    }
    return false;
  }

  // The relationship between two columns, either way round.
  relationshipOf(a, b) {
    return this.relationships.find(r => r.from === a && r.to === b || r.from === b && r.to === a) ?? null;
  }
}

function sourceOf(t) {
  const s = t.partitions?.[0]?.source;
  if (s?.type === 'entity' || s?.entityName) return { schema: s.schemaName ?? null, entity: s.entityName };
  return { schema: null, entity: t.name };
}

// Whether a date column is the one filtered as a date table's: a column of a table marked
// as a date table (dataCategory Time) that is its key, or the date-typed one side of a
// relationship. A filter on it removes the filters on the rest of its table.
export function isDateKey(model, col) {
  if (col.type !== 'datetime') return false;
  if (col.table.dataCategory === 'Time' && (col.unique || col.table.key === col)) return true;
  return model.relationships.some(r => r.to === col && r.active);
}
