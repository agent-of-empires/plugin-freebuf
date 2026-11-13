import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
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
 * declared in `aoe-plugin.toml` leaves it unchanged. Regression test for the
 * build writing `node_modules/` (with `.bin` symlinks) and `dist/` into the
 * source root.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = ".aoe-build";
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

const scratch = mkdtempSync(path.join(tmpdir(), "aoe-freebuf-hash-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("build output stays inside .aoe-build/", () => {
  it("leaves the host tree hash unchanged after the declared build steps", () => {
    // Git-tracked sources only, so an unrelated local build cannot influence this.
    const work = path.join(scratch, "tree");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", ".", work], { cwd: ROOT });

    rmSync(path.join(work, BUILD_DIR), { recursive: true, force: true });
    const before = treeHash(work);

    for (const step of buildCommands()) {
      execFileSync("sh", ["-c", step], { cwd: work, stdio: "pipe" });
    }

    // Fails loudly on any symlink placed outside .aoe-build/.
    expect(treeHash(work)).toBe(before);
    expect(treeHash(work)).not.toBe("");
  }, 180_000);

  it("declares no build step that writes outside .aoe-build/", () => {
    // A cheap structural guard so the failure is named, not just a hash diff.
    for (const step of buildCommands()) {
      expect(step).not.toMatch(/npm\s+(install|ci)(?!.*--prefix\s+\.aoe-build)/);
    }
  });
});

/** `command = [...]` entries of every `[[runtime.build]]` table, joined. */
function buildCommands(): string[] {
  const text = readFileSync(path.join(ROOT, "aoe-plugin.toml"), "utf8");
  const steps: string[] = [];
  let inBuild = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inBuild = trimmed === "[[runtime.build]]";
      continue;
    }
    if (!inBuild) continue;
    const match = /^command\s*=\s*\[(.*)\]$/.exec(trimmed);
    if (!match) continue;
    const parts = match[1].split(",").map((part) => part.trim());
    steps.push(parts.map((part) => part.replace(/^"|"$/g, "")).join(" "));
  }
  // Nothing declared means nothing to verify; fail rather than pass silently.
  expect(steps.length).toBeGreaterThan(0);
  return steps;
}
