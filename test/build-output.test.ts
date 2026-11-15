import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The host re-hashes the plugin tree at load to re-derive `featured` trust. It
 * excludes only the top-level `.aoe-build/`, so a build step that writes
 * anywhere else in the source root changes that hash and drops the plugin to
 * community trust, which the reserved-namespace gate then refuses.
 *
 * This test reproduces the host's hash and asserts that running the build steps
 * declared in `aoe-plugin.toml` leaves it unchanged and produces the worker the
 * runtime entrypoint points at. Regression test for the build writing
 * `node_modules/` (with `.bin` symlinks) and `dist/` into the source root.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = ".aoe-build";
const WORKER = path.join(BUILD_DIR, "dist", "index.js");
const PREFIX = Buffer.from("aoe-plugin-tree-hash-v1\0", "latin1");

/** Mirrors `integrity::tree_hash` in the aoe host: sorted rel paths + contents. */
function treeHash(root: string): string {
  const files: Array<[string, Buffer]> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (entry === ".git") continue;
      if (dir === root && entry === BUILD_DIR) continue;
      const stat = lstatSync(full);
      // The host rejects symlinks rather than skipping them.
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink in hashed tree: ${path.relative(root, full)}`);
      }
      if (stat.isDirectory()) walk(full);
      else files.push([path.relative(root, full).split(path.sep).join("/"), readFileSync(full)]);
    }
  };
  walk(root);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const hash = createHash("sha256");
  hash.update(PREFIX);
  for (const [rel, contents] of files) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(contents.length));
    hash.update(Buffer.from("file\0", "latin1"));
    hash.update(Buffer.from(rel, "utf8"));
    hash.update(Buffer.from("\0", "latin1"));
    hash.update(len);
    hash.update(contents);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Copies the current working tree's tracked files, and nothing else, so an
 * unrelated local build (`dist/`, `node_modules/`) cannot influence the hash.
 */
function copyTrackedTree(dest: string): void {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString("utf8");
  for (const rel of listing.split("\0").filter(Boolean)) {
    const target = path.join(dest, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(ROOT, rel), target);
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), "aoe-freebuf-hash-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("build output stays inside .aoe-build/", () => {
  it("leaves the host tree hash unchanged and produces the worker", () => {
    const work = path.join(scratch, "tree");
    copyTrackedTree(work);

    rmSync(path.join(work, BUILD_DIR), { recursive: true, force: true });
    const before = treeHash(work);

    // Run each declared command as an argv array, exactly as the host does; a
    // shell would let quoting or `sh -c` hide which command actually ran.
    for (const argv of buildCommands()) {
      execFileSync(argv[0], argv.slice(1), { cwd: work, stdio: "pipe" });
    }

    // Throws on any symlink placed outside .aoe-build/.
    expect(treeHash(work)).toBe(before);
    // The runtime entrypoint is `.aoe-build/node/bin/aoe-freebuf-worker`, which
    // wraps this file; a green hash with no worker would still be broken.
    expect(existsSync(path.join(work, WORKER))).toBe(true);
  }, 180_000);

  it("declares no build step that installs into the source root", () => {
    for (const argv of buildCommands()) {
      const npmInstall = argv[0] === "npm" && (argv[1] === "install" || argv[1] === "ci");
      if (npmInstall) expect(argv).toContain("--prefix");
    }
  });
});

/**
 * `command = [...]` of every `[[runtime.build]]` table, in declaration order,
 * as argv arrays. Anything this cannot parse is an error rather than a skip: a
 * step that disappears from the list would weaken the hash check silently.
 */
function buildCommands(): string[][] {
  const text = readFileSync(path.join(ROOT, "aoe-plugin.toml"), "utf8");
  const commands: string[][] = [];
  let inBuild = false;
  let tableHasCommand = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (inBuild && !tableHasCommand) throw new Error("[[runtime.build]] with no command");
      inBuild = trimmed === "[[runtime.build]]";
      tableHasCommand = false;
      continue;
    }
    if (!inBuild) continue;
    const match = /^command\s*=\s*(\[.*\])\s*(?:#.*)?$/.exec(trimmed);
    if (!match) continue;
    if (tableHasCommand) throw new Error("duplicate command in [[runtime.build]]");
    const argv: unknown = JSON.parse(match[1]);
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
      throw new Error(`[[runtime.build]] command is not a non-empty string array: ${match[1]}`);
    }
    commands.push(argv as string[]);
    tableHasCommand = true;
  }
  if (inBuild && !tableHasCommand) throw new Error("[[runtime.build]] with no command");

  // Nothing declared means nothing to verify; fail rather than pass silently.
  expect(commands.length).toBeGreaterThan(0);
  return commands;
}
