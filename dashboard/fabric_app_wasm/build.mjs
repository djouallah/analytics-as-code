// Static "build" of the Fabric app: the project is the working directory, and its dist/ is
//   the DAX page (../github: common/ with dax/ over it, the repo's semantic_model/model.bim
//     next to the compiler; ../../scripts/stage_pages.mjs, which stages the Pages site too)
//   + the Fabric sign-in (site/storage/auth.js)
//   + the project's host files (its site/), copied over the rest: storage/data.js, and what
//     else is its own
//   + the dbt docs in dag/.
// No bundler. Two stamps, so a browser never mixes files of two deploys and the Logs tab
// can tell a fresh deploy from a cached one: __BUILD__ (git sha + time), and ?v=<build> on
// every relative import (../../scripts/stamp_build.mjs, which the Pages build runs too).
import { rm, cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { stampBuild } from "../../scripts/stamp_build.mjs";
import { stagePage, DAG } from "../../scripts/stage_pages.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const project = (p) => fileURLToPath(new URL(p, pathToFileURL(process.cwd() + "/")));
const dist = project("./dist/");

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", cwd: here("./") }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
// Only what goes into dist/: a deploy regenerates files under rayfin/ before this runs.
const dirty = git(`status --porcelain -- "${project("./site")}" site build.mjs ../github ../../semantic_model`) ? "-dirty" : "";
// URL-safe (it is the ?v= cache-buster): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

await rm(dist, { recursive: true, force: true });
await stagePage("dax", dist);
await cp(here("./site/storage/auth.js"), dist + "storage/auth.js");
await cp(project("./site/"), dist, { recursive: true });
await stampBuild(dist, BUILD);
// After the stamping, which must not touch them.
await cp(DAG, dist + "dag", { recursive: true });
console.log(`Published ../github (common + dax) + site/ -> ${dist} (build ${BUILD})`);
