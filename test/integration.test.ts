import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_ID, buildSnapshot, hookBase, instanceHookDir, writeReport } from "../src/integration";

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

describe("agent integration report", () => {
  it("builds a status-only snapshot the host schema accepts", () => {
    const snapshot = buildSnapshot({
      instanceId: "sess-1",
      providerVersion: "0.2.35",
      providerSessionId: "2026-10-30T17-44-20.043Z",
      status: "waiting",
      writerPid: 1234,
    });
    expect(snapshot).toEqual({
      schema_version: 1,
      instance_id: "sess-1",
      provider_version: "0.2.35",
      provider_session_id: "2026-10-30T17-44-20.043Z",
      writer_pid: 1234,
      revision: 0,
      status: "waiting",
      reply_keys: [],
      prompt: null,
    });
  });

  it("places reports in the host's per-user hook layout", () => {
    expect(hookBase(501)).toBe("/tmp/aoe-hooks-501");
    expect(instanceHookDir("sess-1", "/tmp/aoe-hooks-501")).toBe("/tmp/aoe-hooks-501/sess-1");
  });

  it("writes a 0600 report in a 0700 directory, atomically, under the plugin id", () => {
    const base = tempDir("aoe-hooks-");
    const snapshot = buildSnapshot({
      instanceId: "sess-1",
      providerVersion: "0.2.35",
      providerSessionId: "chat-1",
      status: "idle",
      writerPid: process.pid,
    });
    writeReport(instanceHookDir("sess-1", base), snapshot);

    const dir = path.join(base, "sess-1");
    expect(mode(dir)).toBe("700");
    const file = path.join(dir, `integration-${PLUGIN_ID}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(snapshot);
    expect(mode(file)).toBe("600");
    expect(statSync(file).size).toBeLessThanOrEqual(64 * 1024);
    // Rewriting replaces the report and leaves no temp files behind.
    writeReport(instanceHookDir("sess-1", base), { ...snapshot, status: "running" });
    expect(readdirSync(dir)).toEqual([`integration-${PLUGIN_ID}.json`]);
    expect((JSON.parse(readFileSync(file, "utf8")) as { status: string }).status).toBe("running");
  });

  it("creates the hook base directory 0700 when the host never did", () => {
    const parent = tempDir("hooks-parent-");
    const base = path.join(parent, "aoe-hooks-501");
    writeReport(
      instanceHookDir("sess-2", base),
      buildSnapshot({
        instanceId: "sess-2",
        providerVersion: "0.2.35",
        providerSessionId: "chat-2",
        status: "running",
        writerPid: process.pid,
      }),
    );
    expect(mode(base)).toBe("700");
    expect(mode(path.join(base, "sess-2"))).toBe("700");
  });

  it("throws instead of writing when the instance path is not a directory", () => {
    const base = tempDir("hooks-parent-");
    const instanceDir = path.join(base, "sess-3");
    mkdirSync(base, { recursive: true });
    writeFileSync(instanceDir, "not a directory");
    expect(() =>
      writeReport(
        instanceDir,
        buildSnapshot({
          instanceId: "sess-3",
          providerVersion: "0.2.35",
          providerSessionId: "chat-3",
          status: "idle",
          writerPid: process.pid,
        }),
      ),
    ).toThrow();
  });
});
