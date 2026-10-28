// Static "build" of a Fabric app, run by both (rayfin.yml's buildCommand in iceberg/ or vertipaq/):
// the project is the working directory, and its dist/ is
//   the DAX page (../../page with its dax/ over it, the repo's semantic_model/ossie.yaml
//     and dax-sql
//     next to the compiler; ../../../scripts/stage_pages.mjs, which stages the Pages site too)
//   + what both Fabric apps share (this folder's site/: the Fabric sign-in, storage/auth.js)
//   + the project's own files (its site/), copied over the rest: storage/data.js, and what
//     else is its backend's
//   + the dbt docs in dag/.
// No bundler. Two stamps, so a browser never mixes files of two deploys and the Logs tab
// can tell a fresh deploy from a cached one: __BUILD__ (git sha + time), and ?v=<build> on
// every relative import (../../../scripts/stamp_build.mjs, which the Pages build runs too).
import { rm, cp, readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { stampBuild } from "../../../scripts/stamp_build.mjs";
import { stagePage, DAG } from "../../../scripts/stage_pages.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const project = (p) => fileURLToPath(new URL(p, pathToFileURL(process.cwd() + "/")));
const dist = project("./dist/");

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", cwd: here("./") }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
// Only what goes into dist/: a deploy regenerates files under rayfin/ before this runs.
const dirty = git(`status --porcelain -- "${project("./site")}" . ../../page ../../../semantic_model ../../../dax-sql`) ? "-dirty" : "";
// URL-safe (it is the ?v= cache-buster): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

// Every module index.html loads, named in its <head> as a modulepreload: the browser fetches
// them all at once as soon as it has the HTML. Without it, it learns a module's imports only
// once it has that module, and the Fabric host answers each request in ~0.7 s whatever its
// size: the page's ~35 modules came in six rounds, 2.0 s to 7.65 s after navigation
// (2026-10-28). The static imports only (an `import()` is loaded when the page asks), the
// stamped relative ones and the absolute ones (duckdb-wasm from jsDelivr).
async function preloadModules(dir) {
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
  const links = [...seen].map(h => `<link rel="modulepreload" href="${h}"${/^https:/.test(h) ? " crossorigin" : ""}>`).join("\n");
  await writeFile(dir + "index.html", html.replace("</head>", `${links}\n</head>`));
  console.log(`index.html: ${seen.size} modules preloaded`);
}

// No host's data source: each project brings its own storage/data.js (site/).
await rm(dist, { recursive: true, force: true });
await stagePage("dax", dist, undefined, null);
await cp(here("./site/"), dist, { recursive: true });
await cp(project("./site/"), dist, { recursive: true });
await stampBuild(dist, BUILD);
await preloadModules(dist);
// After the stamping, which must not touch them: the dbt docs.
await cp(DAG, dist + "dag", { recursive: true });
console.log(`Published ../../page (+ dax) + fabric_app/common/site + site/ -> ${dist} (build ${BUILD})`);
