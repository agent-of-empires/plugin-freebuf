// Build the worker entirely under .aoe-build/.
//
// The host excludes `.aoe-build/` from the plugin tree hash. Installing or
// compiling in the source root instead would add node_modules/.bin symlinks and
// dist files outside that directory, breaking the load-time re-hash and dropping
// the plugin to community trust on the next start.
//
// `npm install --prefix .aoe-build` treats that prefix as its working directory,
// so package.json and the lockfile are staged there first.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const build = resolve(root, ".aoe-build");
const suffix = process.platform === "win32" ? ".cmd" : "";

mkdirSync(build, { recursive: true });
for (const name of ["package.json", "package-lock.json"]) {
  copyFileSync(resolve(root, name), resolve(build, name));
}

execFileSync(`npm${suffix}`, ["install", "--prefix", build, "--no-audit", "--no-fund"], {
  cwd: root,
  stdio: "inherit",
});

const tsc = resolve(build, "node_modules", ".bin", `tsc${suffix}`);
execFileSync(tsc, ["-p", resolve(root, "tsconfig.json")], { cwd: root, stdio: "inherit" });
