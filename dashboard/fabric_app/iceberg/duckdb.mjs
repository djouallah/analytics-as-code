// DuckDB-Wasm 2.0 for the Iceberg app, fetched into vendor/duckdb/ (not in git), which
// ../common/build.mjs copies into dist/ as it is. rayfin.yml's buildCommand runs this first;
// it does nothing when vendor/ already holds these pins.
//
// duckdb-wasm has no 2.0 release on npm yet, so the engine is its CI build of main (the
// loadable, single-threaded package), and the app serves it and its extensions itself:
//   - the engine: duckdb-browser.mjs (its `apache-arrow` import pointed at jsDelivr), the
//     worker and duckdb-base.wasm;
//   - the extensions DuckDB's bucket has for v2.0.0/wasm_eh, and azure_wasm from its own CI
//     (the 2.0 port; the community build predates it, duckdb/community-extensions#3393).
// The CI build calls itself d54cbbe3df (the v2.0.0 commit) where the extensions say v2.0.0, so
// each extension's footer is relabelled, which voids its signature: data.js opens DuckDB with
// unsigned extensions allowed and installs them from the app's own repository, ext-<hash of the
// pins>/ (pins.json names it).
// The threaded build cannot be used: every wasm_threads extension published (DuckDB's bucket,
// azure_wasm's CI) imports unshared memory, which a threaded engine refuses.
//
// Needs `gh` signed in (GitHub artifacts need a token, even of public repositories).
//   node duckdb.mjs
import { mkdir, readFile, writeFile, rm, readdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const PINS = {
  // duckdb/duckdb-wasm main 1f85a503, run "Main" (its artifacts expire after 90 days: pin a newer run then)
  engine: { repo: "duckdb/duckdb-wasm", run: 39794117824, artifact: "duckdb-wasm-packages-loadable" },
  label: "d54cbbe3df",                // what the engine asks its extension repository for
  platform: "wasm_eh",
  bucket: "https://extensions.duckdb.org/v2.0.0/wasm_eh",
  extensions: ["httpfs", "avro", "iceberg", "icu", "parquet", "json"],
  // HynekBlaha/duckdb-azure-wasm master a4f8db88 (the DuckDB 2.0 port and its GetFileSize fix)
  azure: { repo: "HynekBlaha/duckdb-azure-wasm", run: 40390027182, artifact: "azure_wasm-v2.0.0-extension-wasm_eh" },
  arrow: "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm",
};
const OUT = "vendor/duckdb";
const ENGINE = ["duckdb-browser.mjs", "duckdb-browser-base.worker.js", "duckdb-base.wasm"];

// The extensions' folder is named after the pins: its files then never change under one path,
// so the worker keeps them for good (site/storage/blockcache.js) and a new pin is a new path.
const EXT = `ext-${createHash("sha256").update(JSON.stringify(PINS)).digest("hex").slice(0, 10)}`;
const pins = JSON.stringify({ ...PINS, ext: EXT }, null, 1);
if (existsSync(join(OUT, "pins.json")) && await readFile(join(OUT, "pins.json"), "utf8") === pins) process.exit(0);

const gh = (...args) => execFileSync("gh", args, { stdio: ["ignore", "ignore", "inherit"] });
// Windows' own tar reads zip files (Git's GNU tar, first on a Git Bash PATH, does not).
const unzip = (zip, dir) => process.platform === "win32"
  ? execFileSync(join(process.env.SystemRoot, "System32", "tar.exe"), ["-xf", zip, "-C", dir])
  : execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
const tmp = join(tmpdir(), `duckdb-wasm-${process.pid}`);
const ext = join(OUT, EXT, PINS.label, PINS.platform);
await rm(OUT, { recursive: true, force: true });
await mkdir(ext, { recursive: true });
await mkdir(tmp, { recursive: true });

// The engine: the artifact holds the packages as one more zip.
gh("run", "download", String(PINS.engine.run), "-R", PINS.engine.repo, "-n", PINS.engine.artifact, "-D", tmp);
unzip(join(tmp, (await readdir(tmp)).find(f => f.endsWith(".zip"))), tmp);
const dist = join(tmp, "packages", "duckdb-wasm", "dist");
for (const f of ENGINE) await cp(join(dist, f), join(OUT, f));
const mjs = join(OUT, "duckdb-browser.mjs");
await writeFile(mjs, (await readFile(mjs, "utf8")).replaceAll(/from\s*"apache-arrow"/g, `from"${PINS.arrow}"`));

// The extensions.
for (const e of PINS.extensions) {
  const r = await fetch(`${PINS.bucket}/${e}.duckdb_extension.wasm`);
  if (!r.ok) throw new Error(`${e}: HTTP ${r.status}`);
  await writeFile(join(ext, `${e}.duckdb_extension.wasm`), Buffer.from(await r.arrayBuffer()));
}
gh("run", "download", String(PINS.azure.run), "-R", PINS.azure.repo, "-n", PINS.azure.artifact, "-D", ext);

// The footer's DuckDB version field, v2.0.0 -> the engine's label. The footer is 32-byte fields
// before the signature: ..., the extension's version, DuckDB's version, the platform. A core
// extension's own version is v2.0.0 too, so the field is found from the platform's.
for (const f of await readdir(ext)) {
  const b = await readFile(join(ext, f)), at = b.length - 1024;
  const field = at + b.subarray(at).lastIndexOf(PINS.platform) - 32;
  if (b.subarray(field, field + 32).toString("latin1").replace(/\0+$/, "") !== "v2.0.0")
    throw new Error(`${f}: no v2.0.0 before its platform`);
  Buffer.alloc(32).copy(b, field);
  Buffer.from(PINS.label).copy(b, field);
  await writeFile(join(ext, f), b);
}
await rm(tmp, { recursive: true, force: true });
await writeFile(join(OUT, "pins.json"), pins);
console.log(`DuckDB-Wasm 2.0 -> ${OUT}: ${ENGINE.length} engine files, ${(await readdir(ext)).length} extensions`);
