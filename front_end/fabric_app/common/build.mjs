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
// every relative import; then every module the page loads named in its <head> as a
// modulepreload (../../../scripts/stamp_build.mjs, which the Pages build runs too).
import { rm, cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { stampBuild, preloadModules } from "../../../scripts/stamp_build.mjs";
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

// No host's data source: each project brings its own storage/data.js (site/).
await rm(dist, { recursive: true, force: true });
await stagePage("dax", dist, undefined, null);
await cp(here("./site/"), dist, { recursive: true });
await cp(project("./site/"), dist, { recursive: true });
await stampBuild(dist, BUILD);
await preloadModules(dist, BUILD);
// After the stamping, which must not touch them: the dbt docs.
await cp(DAG, dist + "dag", { recursive: true });
console.log(`Published ../../page (+ dax) + fabric_app/common/site + site/ -> ${dist} (build ${BUILD})`);
