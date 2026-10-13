// Stages the page. dashboard/github/ holds it as one page and two ways of asking:
//   common/  index.html, frontend/ (draw, logs, perflog), storage/ (data, history, views), dag/,
//            semantic/query.js (the page's queries through the semantic model)
//   dax/     frontend/queries.js: the page's queries as objects of the model's fields
//   sql/     frontend/queries.js: the page's queries as SELECTs over the model
// A page is common/ with one of the two copied over it, and semantic_model/model.bim and
// dax-sql/src (as semantic/dax-sql/) next to semantic/query.js. The repo tree is not the served tree: everything that serves or
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
  // The model and its compiler, next to semantic/query.js: common/'s since both pages ask
  // through it (2026-10-13), dax/'s in an older checkout.
  if (existsSync(join(dir, "semantic", "query.js"))) {
    await cp(join(root, "semantic_model", "model.bim"), join(dir, "semantic", "model.bim"));
    // The compiler is dax-sql/ at the top; an older checkout (the A/B's `before`, the parity's
    // `since`) has it under packages/ (until 2026-10-09), or none before 2026-10-08, when
    // semantic/ held its compiler whole.
    const daxSql = [join(root, "dax-sql", "src"), join(root, "packages", "dax-sql", "src")].find(existsSync);
    if (daxSql) await cp(daxSql, join(dir, "semantic", "dax-sql"), { recursive: true });
    // Its readers of a model file (dax-sql/formats, since 2026-10-14), as semantic/formats/.
    for (const f of ["tmsl.js", "ossie.js"]) {
      const src = join(root, "dax-sql", "formats", f);
      if (existsSync(src)) await cp(src, join(dir, "semantic", "formats", f));
    }
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
