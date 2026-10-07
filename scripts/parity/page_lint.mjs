// =============================================================================
// page_lint.mjs — the page works out no figure: no arithmetic in its script or its queries
// =============================================================================
//   cd scripts/parity && npm ci && node page_lint.mjs
//
// The rule (the owner's): the page is a renderer. A figure is a measure of the model, a
// total a `totals` row, a group a column of the model (frontend/queries.js says how to ask).
// So the page's own code, the script of dashboard/github-dax/index.html and the
// frontend/queries.js of both pages (github-dax, github-sql: its figures are SQL, in
// strings), holds no arithmetic: no + - * / % on numbers, no += -= on them, no
// .reduce(). What numbers the page does work with is how it draws (an axis cut, a bubble's
// size, a layout, a number written as text), and that lives in frontend/draw.js, which this
// does not read: a reviewer sees every new line of it. String concatenation is not
// arithmetic, and neither is an index into a list (i + 1, n - 1, as a position); counting
// and comparing are not either.
// Exits 1 and lists the places that break it.
// =============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['dashboard/github-dax/index.html', 'dashboard/github-dax/frontend/queries.js', 'dashboard/github-sql/frontend/queries.js'];

function source(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  if (!file.endsWith('.html')) return { code: text, offset: 0, text };
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(text);
  return { code: m[1], offset: m.index + '<script type="module">'.length, text };
}

const isString = n => (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral'
  || (n.type === 'BinaryExpression' && n.operator === '+' && (isString(n.left) || isString(n.right)));
// An index or a count moved by one: i + 1, n - 1, length - 1.
const isStep = n => n.type === 'BinaryExpression' && (n.operator === '+' || n.operator === '-')
  && n.right.type === 'Literal' && n.right.value === 1;

const found = [];
for (const file of FILES) {
  const { code, offset, text } = source(file);
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: false });
  const report = (node, what) => {
    const at = offset + node.start, line = text.slice(0, at).split('\n').length;
    found.push(`${file}:${line}: ${what}: ${code.slice(node.start, Math.min(node.end, node.start + 100)).replace(/\s+/g, ' ')}`);
  };
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'BinaryExpression' && ['-', '*', '/', '%', '**'].includes(n.operator) && !isStep(n)) report(n, `arithmetic ${n.operator}`);
    if (n.type === 'BinaryExpression' && n.operator === '+' && !isString(n) && !isStep(n)) report(n, 'arithmetic +');
    if (n.type === 'AssignmentExpression' && ['-=', '*=', '/=', '%='].includes(n.operator)) report(n, `arithmetic ${n.operator}`);
    if (n.type === 'AssignmentExpression' && n.operator === '+=' && !isString(n.right)) report(n, 'arithmetic +=');
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'reduce') report(n, 'reduce');
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
}
for (const f of found) console.log(f);
console.log(`${found.length} places where the page works with numbers itself`);
process.exit(found.length ? 1 : 0);
