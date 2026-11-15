import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTmuxSession, sendKeysToPane, tmuxNameSuffix } from "../src/tmux";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

/**
 * A stand-in for tmux: it answers `list-sessions` with the names on the
 * TMUX_SESSIONS line of its own source, and records every other call.
 */
function fakeTmux(sessions: string[]): { binary: string; log: string } {
  const dir = tempDir("fake-tmux-");
  const binary = path.join(dir, "tmux");
  const log = path.join(dir, "calls.log");
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$AOE_TMUX_LOG\"",
      'if [ "$1" = "list-sessions" ]; then',
      ...sessions.map((name) => `  echo '${name}'`),
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}

describe("tmux target resolution", () => {
  it("matches the session id's prefix, which the tmux name keeps", () => {
    expect(tmuxNameSuffix("41ecee7b5eb94d20")).toBe("_41ecee7b");
    expect(tmuxNameSuffix("bad id")).toBeNull();
    expect(tmuxNameSuffix("")).toBeNull();
  });

  it("finds the session whose name ends with that prefix", async () => {
    const fake = fakeTmux(["aoe_omp_41ecee7b", "aoe_other_ffffffff"]);
    process.env.AOE_TMUX_LOG = fake.log;
    try {
      await expect(resolveTmuxSession("41ecee7b5eb94d20", fake.binary)).resolves.toBe("aoe_omp_41ecee7b");
      // The slug in front of the id follows the title and is not dependable, so
      // only the suffix is matched.
      await expect(resolveTmuxSession("ffffffff00000000", fake.binary)).resolves.toBe("aoe_other_ffffffff");
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
  });

  it("refuses an ambiguous or missing target instead of guessing", async () => {
    const ambiguous = fakeTmux(["aoe_one_41ecee7b", "aoe_two_41ecee7b"]);
    process.env.AOE_TMUX_LOG = ambiguous.log;
    try {
      await expect(resolveTmuxSession("41ecee7b5eb94d20", ambiguous.binary)).resolves.toBeNull();
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
    const missing = fakeTmux(["aoe_other_ffffffff"]);
    await expect(resolveTmuxSession("41ecee7b5eb94d20", missing.binary)).resolves.toBeNull();
  });

  it("reports no target when tmux is not there", async () => {
    await expect(resolveTmuxSession("41ecee7b5eb94d20", path.join(tempDir("gone-"), "tmux"))).resolves.toBeNull();
  });
});

describe("key delivery", () => {
  it("sends the keys to the resolved pane", async () => {
    const fake = fakeTmux(["aoe_omp_41ecee7b"]);
    process.env.AOE_TMUX_LOG = fake.log;
    try {
      await expect(
        sendKeysToPane("41ecee7b5eb94d20", [{ keys: ["Down", "Enter"] }], fake.binary),
      ).resolves.toBe(true);
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls).toEqual(["list-sessions -F #{session_name}", "send-keys -t aoe_omp_41ecee7b Down Enter"]);
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
  });

  it("types a custom answer literally, so its words are not read as keys", async () => {
    const fake = fakeTmux(["aoe_omp_41ecee7b"]);
    process.env.AOE_TMUX_LOG = fake.log;
    try {
      await expect(
        sendKeysToPane("41ecee7b5eb94d20", [{ keys: ["Enter"] }, { text: "press -l -- Enter" }], fake.binary),
      ).resolves.toBe(true);
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls.slice(1)).toEqual([
        "send-keys -t aoe_omp_41ecee7b Enter",
        "send-keys -t aoe_omp_41ecee7b -l -- press -l -- Enter",
      ]);
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
  });

  it("sends nothing for an unknown key, empty text, or an empty sequence", async () => {
    const fake = fakeTmux(["aoe_omp_41ecee7b"]);
    process.env.AOE_TMUX_LOG = fake.log;
    try {
      await expect(sendKeysToPane("41ecee7b5eb94d20", [{ keys: ["C-c"] }], fake.binary)).resolves.toBe(false);
      await expect(sendKeysToPane("41ecee7b5eb94d20", [{ text: "" }], fake.binary)).resolves.toBe(false);
      await expect(sendKeysToPane("41ecee7b5eb94d20", [{ keys: [] }], fake.binary)).resolves.toBe(false);
      await expect(sendKeysToPane("41ecee7b5eb94d20", [], fake.binary)).resolves.toBe(false);
      // Rejected before any tmux call, so the fake never ran and wrote its log.
      expect(existsSync(fake.log)).toBe(false);
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
  });

  it("reports an undelivered reply when the pane is gone", async () => {
    const fake = fakeTmux([]);
    process.env.AOE_TMUX_LOG = fake.log;
    try {
      await expect(sendKeysToPane("41ecee7b5eb94d20", [{ keys: ["Enter"] }], fake.binary)).resolves.toBe(false);
    } finally {
      delete process.env.AOE_TMUX_LOG;
    }
  });

  it("names the tmux binary from the environment", async () => {
    const previous = process.env.AOE_TMUX;
    process.env.AOE_TMUX = "/somewhere/tmux";
    try {
      const { tmuxBinary } = await import("../src/tmux");
      expect(tmuxBinary()).toBe("/somewhere/tmux");
    } finally {
      if (previous === undefined) delete process.env.AOE_TMUX;
      else process.env.AOE_TMUX = previous;
    }
  });
});
