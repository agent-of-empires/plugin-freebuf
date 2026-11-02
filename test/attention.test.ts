import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearUrgent, hookBase, instanceHookDir, writeUrgent } from "../src/attention";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

function mode(file: string): string {
  return (statSync(file).mode & 0o777).toString(8);
}

describe("attention flag", () => {
  it("places flags in the host's per-user hook layout", () => {
    expect(hookBase(501)).toBe("/tmp/aoe-hooks-501");
    expect(instanceHookDir("sess-1", "/tmp/aoe-hooks-501")).toBe("/tmp/aoe-hooks-501/sess-1");
  });

  it("writes the urgent payload the host reads, in a 0700 dir, atomically", () => {
    const base = tempDir("aoe-hooks-");
    const dir = instanceHookDir("sess-1", base);
    writeUrgent(dir, 1_700_000_000_999);

    expect(mode(dir)).toBe("700");
    const file = path.join(dir, "attention.json");
    // No reason text: the flag is a boolean plus its expiry, and nothing else.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      urgent: true,
      urgent_expires_at: 1_700_000_000,
    });
    expect(mode(file)).toBe("600");
    expect(readdirSync(dir)).toEqual(["attention.json"]); // no temp file left behind
  });

  it("rewrites an existing flag and takes over a dir the host created", () => {
    const base = tempDir("aoe-hooks-");
    const dir = instanceHookDir("sess-2", base);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeUrgent(dir, 1_000_000);
    writeUrgent(dir, 2_000_000);
    expect(JSON.parse(readFileSync(path.join(dir, "attention.json"), "utf8"))).toMatchObject({
      urgent: true,
      urgent_expires_at: 2_000,
    });
  });

  it("clears the flag, and clearing an absent flag is not an error", () => {
    const base = tempDir("aoe-hooks-");
    const dir = instanceHookDir("sess-3", base);
    writeUrgent(dir, 1_000_000);
    clearUrgent(dir);
    expect(existsSync(path.join(dir, "attention.json"))).toBe(false);
    clearUrgent(dir); // second clear must not throw
  });

  it("throws instead of writing when the instance path is not a directory", () => {
    const base = tempDir("aoe-hooks-");
    const notADir = path.join(base, "sess-4");
    writeFileSync(notADir, "not a directory");
    expect(() => writeUrgent(notADir, 1_000_000)).toThrow();
  });
});
