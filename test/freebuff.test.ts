import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_WINDOW_MS,
  LOG_TAIL_BYTES,
  allProjectActivities,
  configDir,
  latestChat,
  providerVersion,
  statusForActivity,
} from "../src/freebuff";

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

/** One log record in the runtime's own shape: the body is ignored, `msg` is not. */
function logLine(msg: string): string {
  return JSON.stringify({ level: "DEBUG", timestamp: new Date().toISOString(), data: { iteration: 1 }, msg }) + "\n";
}

/** Write `log.jsonl` for a chat with an mtime `ageMs` ago. */
function makeLog(configRoot: string, project: string, chat: string, body: string, ageMs: number): void {
  const target = path.join(configRoot, "projects", project, "chats", chat);
  mkdirSync(target, { recursive: true });
  const filePath = path.join(target, "log.jsonl");
  writeFileSync(filePath, body);
  const when = new Date(Date.now() - ageMs);
  utimesSync(filePath, when, when);
}

/** The activity the status command would report for one project. */
function activityOf(configRoot: string, project: string) {
  return allProjectActivities(configRoot).find((activity) => activity.project === project);
}

/** The status the status command would report for one project. */
function statusOf(configRoot: string, project: string): string | undefined {
  return activityOf(configRoot, project)?.status;
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

  it("keeps a step with no End running past the activity window", () => {
    const root = tempDir("freebuff-cfg-");
    makeLog(
      root,
      "demo",
      "2026-11-02T14-00-00.000Z",
      logLine("Start agent base3-free-catalog step 27 (6clt44vt1x4)"),
      ACTIVITY_WINDOW_MS * 3,
    );

    // The mtime says idle; the unmatched Start says the step is still in flight.
    expect(statusOf(root, "demo")).toBe("running");
  });

  it("reports idle after a matched End and Main prompt finished, even when freshly written", () => {
    const root = tempDir("freebuff-cfg-");
    makeLog(
      root,
      "demo",
      "2026-11-02T14-00-00.000Z",
      logLine("Start agent base3-free-catalog step 29 (6clt44vt1x4)") +
        logLine("End agent base3-free-catalog step 29 (6clt44vt1x4)") +
        logLine("Main prompt finished"),
      10_000,
    );

    // Fresh mtime alone would read as running; a closed turn does not.
    expect(statusOf(root, "demo")).toBe("idle");
  });

  it("falls back to the mtime window when the log is missing or has no step lines", () => {
    const root = tempDir("freebuff-cfg-");
    makeChat(root, "fresh-nolog", "2026-11-02T14-00-00.000Z", "state.json", 1_000);
    makeChat(root, "stale-nolog", "2026-11-02T14-00-00.000Z", "state.json", ACTIVITY_WINDOW_MS * 2);
    makeLog(root, "fresh-nosteps", "2026-11-02T14-00-00.000Z", "{}\n", 1_000);
    makeLog(root, "stale-nosteps", "2026-11-02T14-00-00.000Z", "not json\n", ACTIVITY_WINDOW_MS * 2);

    expect(statusOf(root, "fresh-nolog")).toBe("running");
    expect(statusOf(root, "stale-nolog")).toBe("idle");
    expect(statusOf(root, "fresh-nosteps")).toBe("running");
    expect(statusOf(root, "stale-nosteps")).toBe("idle");
  });

  it("ignores a truncated tail fragment and a non-JSON record but parses the rest", () => {
    const root = tempDir("freebuff-cfg-");
    // The padding line is longer than the tail window, so the read starts in
    // the middle of it; a garbage record follows before the real step line.
    const padding = JSON.stringify({ level: "DEBUG", msg: "x".repeat(LOG_TAIL_BYTES + 50) }) + "\n";
    makeLog(
      root,
      "demo",
      "2026-11-02T14-00-00.000Z",
      padding + "this line is not json\n" + logLine("Start agent base3-free-catalog step 3 (abc)"),
      ACTIVITY_WINDOW_MS * 2,
    );

    expect(statusOf(root, "demo")).toBe("running");
  });

  it("goes running again when a later Start follows a matched End pair", () => {
    const root = tempDir("freebuff-cfg-");
    makeLog(
      root,
      "demo",
      "2026-11-02T14-00-00.000Z",
      logLine("Start agent base3-free-catalog step 1 (abc)") +
        logLine("End agent base3-free-catalog step 1 (abc)") +
        logLine("Main prompt finished") +
        logLine("Start agent base3-free-catalog step 2 (abc)"),
      ACTIVITY_WINDOW_MS * 4,
    );

    expect(statusOf(root, "demo")).toBe("running");
  });

  it("prefers a quieter chat whose step is in flight over a fresher closed one", () => {
    const root = tempDir("freebuff-cfg-");
    // The fresher chat finished its turn 5s ago, so its own status is idle; the
    // older chat still has an unmatched Start, which outranks a fresher mtime.
    makeLog(
      root,
      "demo",
      "2026-11-02T15-00-00.000Z",
      logLine("Start agent base3-free-catalog step 4 (abc)") +
        logLine("End agent base3-free-catalog step 4 (abc)") +
        logLine("Main prompt finished"),
      5_000,
    );
    makeLog(
      root,
      "demo",
      "2026-11-02T14-00-00.000Z",
      logLine("Start agent base3-free-catalog step 27 (abc)"),
      ACTIVITY_WINDOW_MS * 4,
    );

    const activity = activityOf(root, "demo");
    expect(activity?.status).toBe("running");
    expect(activity?.chatId).toBe("2026-11-02T14-00-00.000Z");
  });

  it("reports the fresher chat when every chat's turn has closed", () => {
    const root = tempDir("freebuff-cfg-");
    const closed =
      logLine("Start agent base3-free-catalog step 5 (abc)") +
      logLine("End agent base3-free-catalog step 5 (abc)") +
      logLine("Main prompt finished");
    makeLog(root, "demo", "2026-11-02T15-00-00.000Z", closed, 5_000);
    makeLog(root, "demo", "2026-11-02T14-00-00.000Z", closed, ACTIVITY_WINDOW_MS * 4);

    const activity = activityOf(root, "demo");
    expect(activity?.status).toBe("idle");
    expect(activity?.chatId).toBe("2026-11-02T15-00-00.000Z");
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
