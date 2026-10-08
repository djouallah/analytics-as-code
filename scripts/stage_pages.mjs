// Stages the page. dashboard/github/ holds it as one page and two ways of asking:
//   common/  index.html, frontend/ (draw, logs, perflog), storage/ (data, history, views), dag/
//   dax/     frontend/queries.js and semantic/query.js: the page through the semantic model
//   sql/     frontend/queries.js: the page in plain SQL
// A page is common/ with one of the two copied over it (dax also gets semantic_model/model.bim
// and packages/dax-sql/src, as semantic/dax-sql/, next to semantic/query.js). The repo tree is not the served tree: everything that serves or
// imports the page stages it first, with stagePage (the site, the Fabric app's build, the
// parity scripts).
//   node scripts/stage_pages.mjs <dir> <build>
// stages the GitHub Pages site: dax at the root (the default), sql at sql/ (it reads the
// site's data/, one folder up); then the build stamp and ?v=<build> on every relative
// import (stamp_build.mjs), and the dbt docs, which are not stamped.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { stampBuild } from "./stamp_build.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// common/ (without the dbt docs) and the variant over it, into <dir>. `root`: another
// checkout to take them from (the parity's `since`).
export async function stagePage(variant, dir, root = REPO) {
  const page = join(root, "dashboard", "github");
  await mkdir(dir, { recursive: true });
  await cp(join(page, "common"), dir, { recursive: true, filter: src => !src.startsWith(join(page, "common", "dag")) });
  await cp(join(page, variant), dir, { recursive: true });
  if (variant === "dax") {
    await cp(join(root, "semantic_model", "model.bim"), join(dir, "semantic", "model.bim"));
    // A checkout from before 2026-10-08 (the parity's `since`) has its compiler whole.
    const daxSql = join(root, "packages", "dax-sql", "src");
    if (existsSync(daxSql)) await cp(daxSql, join(dir, "semantic", "dax-sql"), { recursive: true });
  }
}

export const DAG = join(REPO, "dashboard", "github", "common", "dag");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, build] = process.argv.slice(2);
  if (!dir || !build) { console.error("usage: node scripts/stage_pages.mjs <dir> <build>"); process.exit(2); }
  await stagePage("dax", dir);
  await stagePage("sql", join(dir, "sql"));
  await stampBuild(dir, build);
  await cp(DAG, join(dir, "dag"), { recursive: true });
}
