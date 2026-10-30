import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heartbeat, processLine, sendRequest, setOutbound } from "../src/index";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  setOutbound(null);
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

describe("worker/host multiplexing", () => {
  it("stays silent on a response to its own request", () => {
    expect(processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessions: [] } }))).toBeNull();
    expect(processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "nope" } }))).toBeNull();
  });

  it("frames an outbound request and settles it on the matching response", async () => {
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const response = sendRequest("sessions.list", { exclude: ["archived"] }, 1_000);
    expect(sent).toHaveLength(1);
    const request = JSON.parse(sent[0]) as { id: number; method: string; params: unknown };
    expect(request.method).toBe("sessions.list");
    expect(request.params).toEqual({ exclude: ["archived"] });

    expect(
      processLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "s1" }] } })),
    ).toBeNull();
    await expect(response).resolves.toEqual({ sessions: [{ id: "s1" }] });
  });

  it("rejects when the host answers with an error", async () => {
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const response = sendRequest("sessions.list", {}, 1_000);
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } }));
    await expect(response).rejects.toThrow("unknown method");
  });

  it("rejects an unanswered request after its timeout", async () => {
    setOutbound(() => {});
    await expect(sendRequest("sessions.list", {}, 5)).rejects.toThrow(/timed out/);
  });
});

describe("status heartbeat", () => {
  function fixture(): { configRoot: string; base: string } {
    const configRoot = tempDir("freebuff-cfg-");
    const base = tempDir("aoe-hooks-");
    writeFileSync(path.join(configRoot, "freebuff-metadata.json"), JSON.stringify({ version: "0.2.35" }));
    return { configRoot, base };
  }

  function addChat(configRoot: string, project: string, ageMs: number): void {
    const dir = path.join(configRoot, "projects", project, "chats", "2026-10-30T12-00-00.000Z");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "log.jsonl");
    writeFileSync(file, "{}");
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }

  it("writes running/idle reports for freebuff sessions and skips everything else", async () => {
    const { configRoot, base } = fixture();
    addChat(configRoot, "proj-live", 0);
    addChat(configRoot, "proj-stale", 10 * 60_000);

    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({ configRoot, base });
    expect(sent).toHaveLength(1);
    const request = JSON.parse(sent[0]) as { id: number };
    expect(
      processLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessions: [
              { id: "sess-live", tool: "freebuff", project_path: "/w/proj-live" },
              { id: "sess-stale", tool: "freebuff", project_path: "/w/proj-stale" },
              { id: "sess-other", tool: "claude", project_path: "/w/proj-live" },
              { id: "sess-never", tool: "freebuff", project_path: "/w/proj-never" },
            ],
          },
        }),
      ),
    ).toBeNull();
    await tick;

    const read = (id: string) =>
      JSON.parse(readFileSync(path.join(base, id, "integration-dev.example.aoe-freebuf.json"), "utf8")) as {
        status: string;
        instance_id: string;
        provider_version: string;
        provider_session_id: string;
        writer_pid: number;
      };
    const live = read("sess-live");
    expect(live.status).toBe("running");
    expect(live.instance_id).toBe("sess-live");
    expect(live.provider_version).toBe("0.2.35");
    expect(live.provider_session_id).toBe("2026-10-30T12-00-00.000Z");
    expect(live.writer_pid).toBe(process.pid);
    expect(read("sess-stale").status).toBe("idle");
    // No state / not our tool: no report, so the host keeps pane detection.
    expect(() => read("sess-other")).toThrow();
    expect(() => read("sess-never")).toThrow();
  });

  it("claims nothing when the runtime version is unknown", async () => {
    const { configRoot, base } = fixture();
    rmSync(path.join(configRoot, "freebuff-metadata.json"));
    addChat(configRoot, "proj-live", 0);

    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    await heartbeat({ configRoot, base });
    expect(sent).toHaveLength(0); // never even lists sessions
  });

  it("survives the host not answering", async () => {
    const { configRoot, base } = fixture();
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({ configRoot, base });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "host unavailable" } }),
    );
    await expect(tick).resolves.toBeUndefined();
  });
});
