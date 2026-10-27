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
import { rm, cp, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
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

// `node ../common/build.mjs <host>`: a host's data source staged too (dashboard/<host>/), its
// data.js as storage/<host>.js, for the project's own storage/data.js to build on (the app
// `duckdb` reads the GitHub page's files: storage/github.js).
const host = process.argv[2] ?? null;
await rm(dist, { recursive: true, force: true });
await stagePage("dax", dist, undefined, host);
if (host) await rename(dist + "storage/data.js", dist + `storage/${host}.js`);
await cp(here("./site/"), dist, { recursive: true });
await cp(project("./site/"), dist, { recursive: true });
await stampBuild(dist, BUILD);
// After the stamping, which must not touch them: the dbt docs, and a project's vendor/ (files
// fetched, not written here: the Iceberg app's DuckDB-Wasm, iceberg/duckdb.mjs).
await cp(DAG, dist + "dag", { recursive: true });
if (existsSync(project("./vendor/"))) await cp(project("./vendor/"), dist, { recursive: true });
console.log(`Published ../../page (+ dax) + fabric_app/common/site + site/ -> ${dist} (build ${BUILD})`);
