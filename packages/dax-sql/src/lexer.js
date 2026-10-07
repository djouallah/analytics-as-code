// DAX text -> tokens. Each token: { t, v, at, end }, t one of
//   num  a number, as written (v is the text)
//   str  "text" (v without quotes, "" unescaped)
//   date dt"2024-01-31" (v the text inside)
//   id   an identifier, or a 'quoted name' (q: true)
//   col  [name] (v without brackets, ]] unescaped)
//   param @name, a query parameter
//   op   an operator or punctuation
import { syntax } from './errors.js';

const OPS = ['==', '&&', '||', '<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '^', '&', '(', ')', '{', '}', ','];

export function lex(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // Whitespace and comments.
    if (/\s/.test(c)) { i++; continue; }
    if ((c === '/' && src[i + 1] === '/') || (c === '-' && src[i + 1] === '-')) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw syntax('unterminated comment', i, src);
      i = e + 2;
      continue;
    }
    const at = i;
    // dt"2024-01-01"
    if ((c === 'd' || c === 'D') && (src[i + 1] === 't' || src[i + 1] === 'T') && src[i + 2] === '"') {
      const e = src.indexOf('"', i + 3);
      if (e < 0) throw syntax('unterminated date literal', i, src);
      out.push({ t: 'date', v: src.slice(i + 3, e), at, end: e + 1 });
      i = e + 1;
      continue;
    }
    if (c === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw syntax('unterminated string', at, src);
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, at, end: i });
      continue;
    }
    if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw syntax('unterminated quoted name', at, src);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'id', v, q: true, at, end: i });
      continue;
    }
    if (c === '[') {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw syntax('unterminated [name]', at, src);
        if (src[i] === ']') {
          if (src[i + 1] === ']') { v += ']'; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'col', v, at, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: m[0], at, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (c === '@' && /[\p{L}_]/u.test(src[i + 1] ?? '')) {
      const m = /^@([\p{L}_][\p{L}\p{N}_]*)/u.exec(src.slice(i));
      out.push({ t: 'param', v: m[1], at, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i));
      out.push({ t: 'id', v: m[0], at, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw syntax(`unexpected character "${c}"`, i, src);
    out.push({ t: 'op', v: op, at, end: i + op.length });
    i += op.length;
  }
  return out;
}
