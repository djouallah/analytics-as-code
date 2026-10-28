// Stages the page. front_end/page/ is the dashboard, the same on every host:
//   index.html, frontend/ (draw, logs, perflog), storage/ (queue, results), dag/ (the dbt docs),
//   semantic/query.js (the page's queries through the semantic model), and the two ways of
//   asking, one over the other:
//   dax/     frontend/queries.js: the page's queries as objects of the model's fields
//   sql/     frontend/queries.js: the page's queries as SELECTs over the model
// A host adds only its storage/data.js (and what that imports): GitHub Pages' are the files of
// front_end/github/, staged into storage/; each Fabric app's are its site/, copied over the page
// (front_end/fabric_app/<engine>/site/storage/, next to the app's rayfin/).
// A page is page/ with one of the two ways of asking copied over it, a host's files over that,
// and next to semantic/query.js the model (semantic_model/ossie.yaml as semantic/ossie.json:
// the browser reads no YAML), the compiler (dax-sql/src as semantic/dax-sql/) and its readers
// (dax-sql/formats as semantic/formats/). The repo tree is not the served tree: everything
// that serves or imports the page stages it first, with stagePage (the site, the Fabric
// apps' build, the parity scripts).
//   node scripts/stage_pages.mjs <dir> <build>
// stages the GitHub Pages site: dax at the root (the default), sql at sql/ (it reads the
// site's data/, one folder up); then the build stamp and ?v=<build> on every relative
// import, each page's modules preloaded (stamp_build.mjs), and the dbt docs, which are not
// stamped.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { stampBuild, preloadModules } from "./stamp_build.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// semantic_model/ossie.yaml of a checkout, parsed (yaml: `npm ci --prefix scripts`).
export async function readOssie(root = REPO) {
  const { parse } = await import("yaml");
  return parse(await readFile(join(root, "semantic_model", "ossie.yaml"), "utf8"));
}

// The page (without the dbt docs), the way of asking over it and the host's files over that,
// into <dir>. `host`: "github" (the default: GitHub Pages' data source, which the parity
// scripts run too), or null for a Fabric app, whose build copies its own site/ over the page.
// `root`: another checkout to take them from (the parity's `since`, the A/B's `before`).
export async function stagePage(variant, dir, root = REPO, host = "github") {
  await mkdir(dir, { recursive: true });
  // The front end's folder: front_end/ since 2026-10-28, dashboard/ in an older checkout.
  const fe = join(root, existsSync(join(root, "front_end")) ? "front_end" : "dashboard");
  const page = join(fe, "page");
  if (existsSync(page)) {
    const skip = ["dag", "dax", "sql"].map(d => join(page, d));
    await cp(page, dir, { recursive: true, filter: src => !skip.some(s => src === s || src.startsWith(s + "\\") || src.startsWith(s + "/")) });
    await cp(join(page, variant), dir, { recursive: true });
    if (host) await cp(join(fe, host), join(dir, "storage"), { recursive: true });
  } else {
    // A checkout from before 2026-10-27, when the page and GitHub Pages' storage/ were
    // dashboard/github/common/, with dax/ and sql/ next to it.
    const old = join(fe, "github");
    await cp(join(old, "common"), dir, { recursive: true, filter: src => !src.startsWith(join(old, "common", "dag")) });
    await cp(join(old, variant), dir, { recursive: true });
  }
  // The model and its compiler, next to semantic/query.js: the page's since both ways of
  // asking go through it (2026-10-13), dax/'s in an older checkout.
  if (existsSync(join(dir, "semantic", "query.js"))) {
    // The model: Ossie since 2026-10-14; an older checkout (the A/B's `before`, the parity's
    // `since`) has the TMSL, model.bim, which its query.js fetches.
    const bim = join(root, "semantic_model", "model.bim");
    if (existsSync(bim)) await cp(bim, join(dir, "semantic", "model.bim"));
    else await writeFile(join(dir, "semantic", "ossie.json"), JSON.stringify(await readOssie(root)));
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

export const DAG = join(REPO, "front_end", "page", "dag");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, build] = process.argv.slice(2);
  if (!dir || !build) { console.error("usage: node scripts/stage_pages.mjs <dir> <build>"); process.exit(2); }
  await stagePage("dax", dir);
  await stagePage("sql", join(dir, "sql"));
  await stampBuild(dir, build);
  await preloadModules(join(dir, "/"), build);
  await preloadModules(join(dir, "sql", "/"), build);
  await cp(DAG, join(dir, "dag"), { recursive: true });
}
