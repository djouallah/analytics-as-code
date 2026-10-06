// Static "build" of the Fabric target: dist/ = the shared page (../github: index.html and
// its frontend/, semantic/ and storage/ folders, the dbt docs in dag/) + the semantic model
// (the repo's semantic_model/model.bim, put next to its compiler) + this target's host files
// (site/storage/: data.js, auth.js). ../github/storage/data.js, the GitHub Pages host, is the
// one file replaced: site/ is copied over it.
// No bundler. Two stamps, so a browser never mixes files of two deploys and the Logs tab
// can tell a fresh deploy from a cached one: __BUILD__ (git sha + time), and ?v=<build> on
// every relative import.
import { rm, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
const page = here("../github/");
const model = here("../../semantic_model/model.bim");

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", cwd: here("./") }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
// Only what goes into dist/: a deploy regenerates files under rayfin/ before this runs.
const dirty = git("status --porcelain -- site build.mjs ../github ../../semantic_model") ? "-dirty" : "";
// URL-safe (it is the ?v= cache-buster): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await cp(page + "index.html", dist + "index.html");
for (const d of ["frontend", "semantic", "storage"]) await cp(page + d, dist + d, { recursive: true });
await cp(model, dist + "semantic/model.bim");
await cp(here("./site/"), dist, { recursive: true });
for (const f of await readdir(dist, { recursive: true })) {
  if (!/\.(html|js)$/.test(f)) continue;
  const s = await readFile(dist + f, "utf8");
  await writeFile(dist + f, s
    .replaceAll("__BUILD__", BUILD)
    .replace(/(\b(?:from|import)\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${BUILD}$2`));
}
// After the stamping, which must not touch them.
await cp(page + "dag", dist + "dag", { recursive: true });
console.log(`Published ../github + semantic_model/model.bim + site/ -> dist/ (build ${BUILD})`);
