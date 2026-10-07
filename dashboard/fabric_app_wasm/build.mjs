// Static "build" of a Fabric app, for both of them (this one and ../fabric_app_vertipaq, whose
// package.json runs this file): the project is the working directory, and its dist/ is
//   the shared page (../github-dax): index.html, frontend/, the dbt docs in dag/, and the folders
//     named as arguments. This app names semantic and storage (the compiler, with the repo's
//     semantic_model/model.bim put next to it, and history.js); the VertiPaq app names none,
//     so nothing of the DuckDB path is in its dist/
//   + the Fabric sign-in both apps share (site/storage/auth.js, here)
//   + the project's host files (its site/), copied over the rest: storage/data.js, and what
//     else is its own.
// No bundler. Two stamps, so a browser never mixes files of two deploys and the Logs tab
// can tell a fresh deploy from a cached one: __BUILD__ (git sha + time), and ?v=<build> on
// every relative import (../../scripts/stamp_build.mjs, which the Pages build runs too).
import { rm, cp, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { stampBuild } from "../../scripts/stamp_build.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const project = (p) => fileURLToPath(new URL(p, pathToFileURL(process.cwd() + "/")));
const dist = project("./dist/");
const page = here("../github-dax/");
const model = here("../../semantic_model/model.bim");
const folders = ["frontend", ...process.argv.slice(2)];

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8", cwd: here("./") }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
// Only what goes into dist/: a deploy regenerates files under rayfin/ before this runs.
const dirty = git(`status --porcelain -- "${project("./site")}" site build.mjs ../github-dax ../../semantic_model`) ? "-dirty" : "";
// URL-safe (it is the ?v= cache-buster): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await cp(page + "index.html", dist + "index.html");
for (const d of folders) await cp(page + d, dist + d, { recursive: true });
if (folders.includes("semantic")) await cp(model, dist + "semantic/model.bim");
await cp(here("./site/storage/auth.js"), dist + "storage/auth.js");
await cp(project("./site/"), dist, { recursive: true });
await stampBuild(dist, BUILD);
// After the stamping, which must not touch them.
await cp(page + "dag", dist + "dag", { recursive: true });
console.log(`Published ../github-dax (${folders.join(", ")}) + site/ -> ${dist} (build ${BUILD})`);
