// The filter context, as the compiler carries it: a list of filters and the relationship
// changes of USERELATIONSHIP and CROSSFILTER. It is immutable; CALCULATE makes new ones.
//
// A filter constrains some model columns (`cols`) to a set of values, held one of three ways:
//   bind  { cols: [c], val }         c is the value `val` (context transition, a group key);
//                                    with `implied`, a bind on a key that says as much while
//                                    the context holds it
//   pred  { cols, row, pred }        the values for which `pred` holds, `pred` reading them
//                                    through `row` (a CALCULATE filter like T[c] > 5)
//   rel   { cols, src, idx, base }   the rows of table `src`: cols[i] is its column idx[i];
//                                    with `base`, src holds rows of that model table and the
//                                    filter is on its expanded table (cols are its columns)
// Removing columns from a filter (ALL, or a new filter on the same column) drops what it says
// about them and keeps what it says about the others.
import { distinct, project, filter as filterRows, scan, itemOf, rowOf, newRow } from './ir.js';

export class Ctx {
  constructor(filters = [], mods = null) {
    this.filters = filters;
    this.mods = mods;       // { active: Map(rel -> bool), cross: Map(rel -> direction) } or null
  }

  add(f) { return new Ctx([...this.filters, f], this.mods); }

  // Without what the filters say about the columns `drop` (a predicate on a column) holds for.
  remove(drop) {
    const out = [];
    for (const f of this.filters) {
      const gone = f.cols.filter(drop);
      if (!gone.length) { out.push(f); continue; }
      if (gone.length === f.cols.length) continue;
      out.push(narrow(f, f.cols.filter(c => !drop(c))));
    }
    return new Ctx(out, this.mods);
  }
  removeAll() { return new Ctx([], this.mods); }

  withMods(change) {
    const mods = { active: new Map(this.mods?.active ?? []), cross: new Map(this.mods?.cross ?? []) };
    change(mods);
    return new Ctx(this.filters, mods);
  }

  // The columns some filter is on (ISFILTERED).
  filtered(c) { return this.filters.some(f => f.cols.includes(c)); }
}

export const EMPTY_CTX = new Ctx();

// A filter on fewer columns: what it said about `keep`.
export function narrow(f, keep) {
  if (f.kind === 'bind') return f;   // one column: never narrowed
  if (f.kind === 'rel' && f.base) return { ...f, cols: keep };
  if (f.kind === 'rel') {
    const row = rowOf(f.src, 'table');
    const idx = keep.map(c => f.idx[f.cols.indexOf(c)]);
    const src = distinct(project(f.src, row, idx.map(i => itemOf(row, i))));
    return { kind: 'rel', cols: keep, src, idx: keep.map((_, i) => i), base: null };
  }
  // A predicate on two columns of a table, narrowed to one: the values of that one in the
  // rows of the whole table where the predicate holds.
  const table = f.cols[0].table, all = scan(table, EMPTY_CTX);
  const rows = filterRows(all, f.row, f.pred);
  const row = newRow(all.cols, 'scan', { base: table });
  const src = distinct(project(rows, row, keep.map(c => itemOf(row, c))));
  return { kind: 'rel', cols: keep, src, idx: keep.map((_, i) => i), base: null };
}
