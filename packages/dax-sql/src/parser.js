// Tokens -> syntax tree. A recursive-descent parser for DAX expressions and queries.
//
// Expression nodes (all carry `pos`, the offset in the text):
//   { k:'num', v }   { k:'str', v }   { k:'date', v }   { k:'bool', v }
//   { k:'col', table, name }          Table[Column], 'Table'[Column], or [Name] (table null)
//   { k:'name', name }                a bare name: a table or a variable
//   { k:'call', fn, args }            fn upper-cased; args may hold { k:'empty' } for a skipped one
//   { k:'bin', op, l, r }             ^ * / + - & = == <> < <= > >= && ||
//   { k:'neg', e }   { k:'not', e }   { k:'in', e, set }
//   { k:'row', items }                (a, b) — a row, left of IN or inside { }
//   { k:'table', rows }               { 1, 2 } or { (1, "a"), (2, "b") }
//   { k:'var', defs: [{ name, e }], body }
// A query: { defines: [...], evaluates: [{ e, order: [{ e, desc }] }] } where a define is
//   { kind:'measure'|'column', table, name, e } | { kind:'var'|'table', name, e }
import { lex } from './lexer.js';
import { syntax } from './errors.js';

// Words that cannot be a bare name. (ASC and DESC can: they are arguments of TOPN, RANKX.)
const KEYWORDS = new Set(['VAR', 'RETURN', 'EVALUATE', 'DEFINE', 'MEASURE', 'ORDER', 'BY', 'IN', 'NOT', 'START']);

export function parseExpression(src) {
  const p = new Parser(src);
  const e = p.expr();
  p.end();
  return e;
}

export function parseQuery(src) {
  const p = new Parser(src);
  const q = p.query();
  p.end();
  return q;
}

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = lex(src);
    this.i = 0;
  }
  get tok() { return this.toks[this.i]; }
  pos() { return this.tok?.at ?? this.src.length; }
  err(msg) { return syntax(msg, this.pos(), this.src); }
  isOp(v) { return this.tok?.t === 'op' && this.tok.v === v; }
  isKw(v) { return this.tok?.t === 'id' && !this.tok.q && this.tok.v.toUpperCase() === v; }
  eat(v) {
    if (this.isOp(v) || this.isKw(v)) { this.i++; return true; }
    return false;
  }
  need(v) { if (!this.eat(v)) throw this.err(`expected ${v}`); }
  end() { if (this.i < this.toks.length) throw this.err('unexpected text'); }

  query() {
    const defines = [], evaluates = [];
    if (this.eat('DEFINE')) {
      for (;;) {
        const pos = this.pos();
        if (this.eat('MEASURE') || this.isKw('COLUMN')) {
          const kind = this.toks[this.i - 1].v.toUpperCase() === 'MEASURE' ? 'measure' : (this.i++, 'column');
          const t = this.tok;
          if (t?.t !== 'id') throw this.err('expected Table[Name]');
          this.i++;
          const c = this.tok;
          if (c?.t !== 'col') throw this.err('expected Table[Name]');
          this.i++;
          this.need('=');
          defines.push({ kind, table: t.v, name: c.v, e: this.expr(), pos });
        } else if (this.eat('VAR') || this.eat('TABLE')) {
          const kind = this.toks[this.i - 1].v.toUpperCase() === 'VAR' ? 'var' : 'table';
          const name = this.tok;
          if (name?.t !== 'id') throw this.err('expected a name');
          this.i++;
          this.need('=');
          defines.push({ kind, name: name.v, e: this.expr(), pos });
        } else break;
      }
    }
    while (this.eat('EVALUATE')) {
      const e = this.expr(), order = [];
      if (this.eat('ORDER')) {
        this.need('BY');
        do {
          const o = this.expr();
          const desc = this.eat('DESC');
          if (!desc) this.eat('ASC');
          order.push({ e: o, desc });
        } while (this.eat(','));
      }
      if (this.isKw('START')) throw this.err('START AT is not supported');
      evaluates.push({ e, order });
    }
    if (!evaluates.length) throw this.err('expected EVALUATE');
    return { defines, evaluates };
  }

  expr() {
    if (!this.isKw('VAR')) return this.or();
    const pos = this.pos(), defs = [];
    while (this.eat('VAR')) {
      const name = this.tok;
      if (name?.t !== 'id') throw this.err('expected a variable name');
      this.i++;
      this.need('=');
      defs.push({ name: name.v, e: this.expr() });
    }
    this.need('RETURN');
    return { k: 'var', defs, body: this.expr(), pos };
  }

  chain(next, ops) {
    let l = next();
    for (;;) {
      const op = ops.find(o => this.isOp(o));
      if (!op) return l;
      const pos = this.pos();
      this.i++;
      l = { k: 'bin', op, l, r: next(), pos };
    }
  }
  or() { return this.chain(() => this.and(), ['||']); }
  and() { return this.chain(() => this.not(), ['&&']); }
  not() {
    const pos = this.pos();
    // NOT(x) is the function form; NOT x the operator. Both mean the same.
    if (this.isKw('NOT')) { this.i++; return { k: 'not', e: this.not(), pos }; }
    return this.cmp();
  }
  cmp() {
    const l = this.cat();
    const op = ['==', '=', '<>', '<=', '>=', '<', '>'].find(o => this.isOp(o));
    const pos = this.pos();
    if (op) { this.i++; return { k: 'bin', op, l, r: this.cat(), pos }; }
    if (this.eat('IN')) return { k: 'in', e: l, set: this.cat(), pos };
    return l;
  }
  cat() { return this.chain(() => this.add(), ['&']); }
  add() { return this.chain(() => this.mul(), ['+', '-']); }
  mul() { return this.chain(() => this.pow(), ['*', '/']); }
  pow() { return this.chain(() => this.unary(), ['^']); }
  unary() {
    const pos = this.pos();
    if (this.eat('-')) return { k: 'neg', e: this.unary(), pos };
    if (this.eat('+')) return this.unary();
    return this.primary();
  }
  args(close) {
    const a = [];
    if (this.eat(close)) return a;
    for (;;) {
      // An argument can be left out: f(a, , c).
      if (this.isOp(',') || this.isOp(close)) a.push({ k: 'empty', pos: this.pos() });
      else a.push(this.expr());
      if (this.eat(',')) continue;
      this.need(close);
      return a;
    }
  }
  primary() {
    const t = this.tok;
    if (!t) throw this.err('the expression ends too soon');
    const pos = t.at;
    this.i++;
    if (t.t === 'num') return { k: 'num', v: t.v, pos };
    if (t.t === 'str') return { k: 'str', v: t.v, pos };
    if (t.t === 'date') return { k: 'date', v: t.v, pos };
    if (t.t === 'col') return { k: 'col', table: null, name: t.v, pos };
    if (t.t === 'op' && t.v === '(') {
      const first = this.expr();
      if (this.eat(',')) {
        const items = [first];
        do items.push(this.expr()); while (this.eat(','));
        this.need(')');
        return { k: 'row', items, pos };
      }
      this.need(')');
      return first;
    }
    if (t.t === 'op' && t.v === '{') {
      const items = this.args('}');
      return { k: 'table', rows: items.map(x => x.k === 'row' ? x.items : [x]), pos };
    }
    if (t.t === 'id') {
      // Table[Column]: an unquoted name takes its column with no space between; a quoted
      // one can have space before it.
      if (this.tok?.t === 'col' && (t.q || this.tok.at === t.end)) {
        const c = this.tok;
        this.i++;
        return { k: 'col', table: t.v, name: c.v, pos };
      }
      if (!t.q && this.isOp('(')) {
        this.i++;
        return { k: 'call', fn: t.v.toUpperCase(), args: this.args(')'), pos };
      }
      const up = t.v.toUpperCase();
      if (!t.q && (up === 'TRUE' || up === 'FALSE')) return { k: 'bool', v: up === 'TRUE', pos };
      if (!t.q && KEYWORDS.has(up)) { this.i--; throw this.err(`unexpected ${t.v}`); }
      return { k: 'name', name: t.v, pos };
    }
    this.i--;
    throw this.err('unexpected token');
  }
}
