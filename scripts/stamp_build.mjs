// Stamps a build of the page, for every host that serves it (build.yml for GitHub Pages,
// front_end/fabric_app/common/build.mjs for the Fabric apps): __BUILD__ becomes the build, and
// every relative import gets ?v=<build>. A browser keeps a module it cached (Pages sends
// max-age=600), so without it a new index.html could run with an old module: on
// 2026-10-07 that broke the page ("s.replace is not a function") until the cache expired.
// semantic/query.js passes its own ?v= on to the model (ossie.json). Then preloadModules
// names the page's modules in its <head>.
//   node scripts/stamp_build.mjs <dir> <build>
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

export async function stampBuild(dir, build) {
  for (const f of await readdir(dir, { recursive: true })) {
    if (!/\.(html|js)$/.test(f)) continue;
    const s = await readFile(join(dir, f), "utf8");
    await writeFile(join(dir, f), s
      .replaceAll("__BUILD__", build)
      .replace(/(\b(?:from|import)\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${build}$2`));
  }
}

// Every module <dir>index.html loads, named in its <head> as a modulepreload, after the
// stamping: the browser fetches them all at once as soon as it has the HTML. Without it, it
// learns a module's imports only once it has that module, and a host that answers each
// request in ~0.7 s whatever its size (Fabric's) brought the page's ~35 modules in six
// rounds, 2.0 s to 7.65 s after navigation (2026-10-28). The static imports only (an
// `import()` is loaded when the page asks), the stamped relative ones and the absolute ones
// (duckdb-wasm from jsDelivr). And the model, semantic/ossie.json: semantic/query.js fetches
// it at import (a top-level await), so every module importing it waited for it.
export async function preloadModules(dir, build) {
  const imports = s => [...s.matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+\.js(?:\?[^"']*)?|https:\/\/[^"']+)["']/g)].map(m => m[1]);
  const html = await readFile(dir + "index.html", "utf8");
  const seen = new Set(), queue = imports(html).map(u => ({ u, base: "" }));
  while (queue.length) {
    const { u, base } = queue.shift();
    const abs = /^https:/.test(u);
    const path = abs ? u : posix.normalize(posix.join(base, u.split("?")[0]));
    const href = abs ? u : `${path}${u.includes("?") ? u.slice(u.indexOf("?")) : ""}`;
    if (seen.has(href)) continue;
    seen.add(href);
    if (abs) continue;   // what jsDelivr's module imports is jsDelivr's
    const src = await readFile(dir + path, "utf8").catch(() => null);
    if (src) for (const v of imports(src)) queue.push({ u: v, base: posix.dirname(path) });
  }
  const links = [`<link rel="preload" href="semantic/ossie.json?v=${build}" as="fetch" crossorigin>`,
    ...[...seen].map(h => `<link rel="modulepreload" href="${h}"${/^https:/.test(h) ? " crossorigin" : ""}>`)].join("\n");
  await writeFile(dir + "index.html", html.replace("</head>", `${links}\n</head>`));
  console.log(`index.html: ${seen.size} modules preloaded`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await stampBuild(process.argv[2], process.argv[3]);
