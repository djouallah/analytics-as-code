// Static "build" of the Fabric target: dist/ = the shared page (../dashboard: index.html,
// model.js, views.js, history.js, perflog.js, logs.js, the dbt docs in dag/) + this target's host files
// (site/: data.js, auth.js). ../dashboard/data.js, the GitHub Pages host, is the one file
// left out.
// No bundler. Two stamps, so a browser never mixes files of two deploys and the Logs tab
// can tell a fresh deploy from a cached one: __BUILD__ (git sha + time), and ?v=<build> on
// every relative import.
import { rm, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
const page = here("../dashboard/");

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", cwd: here("./") }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
// Only what goes into dist/: a deploy regenerates files under rayfin/ before this runs.
const dirty = git("status --porcelain -- site build.mjs ../dashboard") ? "-dirty" : "";
// URL-safe (it is the ?v= cache-buster): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const f of ["index.html", "model.js", "views.js", "history.js", "perflog.js", "logs.js"]) await cp(page + f, dist + f);
await cp(here("./site/"), dist, { recursive: true });
for (const f of await readdir(dist)) {
  if (!/\.(html|js)$/.test(f)) continue;
  const s = await readFile(dist + f, "utf8");
  await writeFile(dist + f, s
    .replaceAll("__BUILD__", BUILD)
    .replace(/(\b(?:from|import)\s*["']\.\/[\w.-]+\.js)(["'])/g, `$1?v=${BUILD}$2`));
}
// After the stamping, which must not touch them.
await cp(page + "dag", dist + "dag", { recursive: true });
console.log(`Published ../dashboard + site/ -> dist/ (build ${BUILD})`);
