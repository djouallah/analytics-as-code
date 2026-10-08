// Stamps a build of the page, for every host that serves it (build.yml for GitHub Pages,
// dashboard/fabric_app/common/build.mjs for the Fabric apps): __BUILD__ becomes the build, and
// every relative import gets ?v=<build>. A browser keeps a module it cached (Pages sends
// max-age=600), so without it a new index.html could run with an old module: on
// 2026-10-07 that broke the page ("s.replace is not a function") until the cache expired.
// semantic/query.js passes its own ?v= on to model.bim.
//   node scripts/stamp_build.mjs <dir> <build>
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function stampBuild(dir, build) {
  for (const f of await readdir(dir, { recursive: true })) {
    if (!/\.(html|js)$/.test(f)) continue;
    const s = await readFile(join(dir, f), "utf8");
    await writeFile(join(dir, f), s
      .replaceAll("__BUILD__", build)
      .replace(/(\b(?:from|import)\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${build}$2`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await stampBuild(process.argv[2], process.argv[3]);
