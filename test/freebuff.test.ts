import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_WINDOW_MS, configDir, latestChat, providerVersion, statusForActivity } from "../src/freebuff";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

/** Create `projects/<project>/chats/<chat>/<file>` with an mtime `ageMs` ago. */
function makeChat(configRoot: string, project: string, chat: string, file: string, ageMs: number): void {
  const target = path.join(configRoot, "projects", project, "chats", chat);
  mkdirSync(target, { recursive: true });
  const filePath = path.join(target, file);
  writeFileSync(filePath, "{}");
  const when = new Date(Date.now() - ageMs);
  utimesSync(filePath, when, when);
}

describe("freebuff state probe", () => {
  it("resolves the config dir, honoring the env override", () => {
    expect(configDir({ FREEBUFF_CONFIG_DIR: "/custom/root" })).toBe("/custom/root");
    expect(configDir({})).toBe(path.join(os.homedir(), ".config", "manicode"));
  });

  it("returns the freshest chat for a project", () => {
    const root = tempDir("freebuff-cfg-");
    makeChat(root, "demo", "2026-10-30T10-00-00.000Z", "log.jsonl", 10 * 60_000);
    makeChat(root, "demo", "2026-10-30T11-00-00.000Z", "log.jsonl", 1_000);

    const chat = latestChat(root, "/some/path/demo");
    expect(chat).not.toBeNull();
    expect(chat?.chatId).toBe("2026-10-30T11-00-00.000Z");
    expect(Date.now() - (chat?.lastActivityMs ?? 0)).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - (chat?.lastActivityMs ?? 0)).toBeLessThan(5_000);
  });

  it("returns null when the project has never chatted", () => {
    const root = tempDir("freebuff-cfg-");
    expect(latestChat(root, "/some/path/unknown")).toBeNull();
    // A project that exists but has no chat directories counts the same.
    mkdirSync(path.join(root, "projects", "empty", "chats"), { recursive: true });
    expect(latestChat(root, "/some/path/empty")).toBeNull();
  });

  it("maps activity age onto running/idle", () => {
    expect(statusForActivity(0)).toBe("running");
    expect(statusForActivity(ACTIVITY_WINDOW_MS)).toBe("running");
    expect(statusForActivity(ACTIVITY_WINDOW_MS + 1)).toBe("idle");
    expect(statusForActivity(60 * 60_000)).toBe("idle");
  });

  it("reads the runtime version from freebuff-metadata.json", () => {
    const root = tempDir("freebuff-cfg-");
    writeFileSync(path.join(root, "freebuff-metadata.json"), JSON.stringify({ version: "0.2.35", target: "darwin-arm64" }));
    expect(providerVersion(root)).toBe("0.2.35");
  });

  it("returns null instead of guessing when metadata is missing or malformed", () => {
    const root = tempDir("freebuff-cfg-");
    expect(providerVersion(root)).toBeNull();
    writeFileSync(path.join(root, "freebuff-metadata.json"), "{not json");
    expect(providerVersion(root)).toBeNull();
    writeFileSync(path.join(root, "freebuff-metadata.json"), JSON.stringify({ version: 7 }));
    expect(providerVersion(root)).toBeNull();
  });
});
