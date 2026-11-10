import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLAG_TTL_MS, heartbeat, processLine, sendRequest, setOutbound } from "../src/index";

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

describe("attention heartbeat", () => {
  const WAITING = "╭──── Some questions for you ────╮\n│                      Close ✕ │";
  const RUNNING = " working...      1m 33s   ■ Esc\n ❯ ▍Add to the current task";
  const IDLE = " ❯ ▍Add to the current task (/ for commands)\n ← for history · ? for help";

  function flag(hookBase: string, id: string): Record<string, unknown> | null {
    const file = path.join(hookBase, id, "attention.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
  }

  function report(hookBase: string, id: string): Record<string, unknown> | null {
    const file = path.join(hookBase, id, "integration-agent-of-empires.aoe-freebuf.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
  }

  /** Answer the tick's sessions.list and run it against stubbed panes. */
  async function runTick(
    sessions: Array<Record<string, unknown>>,
    panes: Record<string, string | null>,
  ): Promise<{ sent: string[]; hookBase: string; now: number }> {
    const hookBase = tempDir("aoe-hooks-");
    const now = 1_700_000_000_000;
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({
      hookBase,
      now,
      capture: async (id) => panes[id] ?? null,
    });
    expect(sent).toHaveLength(1);
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions } }));
    await tick;
    return { sent, hookBase, now };
  }

  it("flags a session blocked on a question and clears the working and parked ones", async () => {
    // Stale claims from an earlier tick: the running and idle sessions must lose them.
    const { hookBase, now, sent } = await runTick(
      [
        { id: "sess-asking", tool: "freebuff" },
        { id: "sess-working", tool: "freebuff" },
        { id: "sess-idle", tool: "freebuff" },
        { id: "sess-other", tool: "claude" },
      ],
      {
        "sess-asking": WAITING,
        "sess-working": RUNNING,
        "sess-idle": IDLE,
      },
    );
    expect(sent).toHaveLength(1); // the sessions.list request and nothing else on the wire

    expect(flag(hookBase, "sess-asking")).toEqual({
      urgent: true,
      urgent_expires_at: Math.floor((now + FLAG_TTL_MS) / 1000),
    });
    expect(flag(hookBase, "sess-working")).toBeNull();
    expect(flag(hookBase, "sess-idle")).toBeNull();
    expect(flag(hookBase, "sess-other")).toBeNull(); // another tool's session is not ours

    // Forward compatible: the same classification lands in the api_version-19
    // report, which an older host ignores and a newer one reads as the row status.
    expect(report(hookBase, "sess-asking")).toMatchObject({ schema_version: 1, status: "waiting", revision: 0 });
    expect(report(hookBase, "sess-working")).toMatchObject({ status: "running" });
    expect(report(hookBase, "sess-idle")).toMatchObject({ status: "idle" });
    expect(report(hookBase, "sess-other")).toBeNull();
  });

  it("lowers a raised flag once the dialog is gone", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-asking");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "attention.json"), JSON.stringify({ urgent: true, urgent_expires_at: 9_999_999_999 }));

    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({ hookBase, now: 1_700_000_000_000, capture: async () => IDLE });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-asking", tool: "freebuff" }] } }));
    await tick;

    expect(flag(hookBase, "sess-asking")).toBeNull();
  });

  it("leaves the claim alone when the pane cannot be read", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-asking");
    mkdirSync(dir, { recursive: true });
    const existing = JSON.stringify({ urgent: true, urgent_expires_at: 9_999_999_999 });
    writeFileSync(path.join(dir, "attention.json"), existing);

    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    // A failed capture says nothing about the screen, so the expiry decides.
    const tick = heartbeat({ hookBase, now: 1_700_000_000_000, capture: async () => null });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-asking", tool: "freebuff" }] } }));
    await tick;

    expect(readFileSync(path.join(dir, "attention.json"), "utf8")).toBe(existing);
  });

  it("survives the host not answering", async () => {
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({ hookBase: tempDir("aoe-hooks-"), capture: async () => WAITING });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "host unavailable" } }),
    );
    await expect(tick).resolves.toBeUndefined();
  });

  it("reports the probe result from the status command", () => {
    const configRoot = tempDir("freebuff-cfg-");
    writeFileSync(path.join(configRoot, "freebuff-metadata.json"), JSON.stringify({ version: "0.2.35" }));
    const chat = path.join(configRoot, "projects", "proj-live", "chats", "2026-10-30T12-00-00.000Z");
    mkdirSync(chat, { recursive: true });
    writeFileSync(path.join(chat, "log.jsonl"), "{}");
    const second = path.join(configRoot, "projects", "proj-stale", "chats", "2026-10-30T12-00-00.000Z");
    mkdirSync(second, { recursive: true });
    writeFileSync(path.join(second, "log.jsonl"), "{}");

    const previous = process.env.FREEBUFF_CONFIG_DIR;
    process.env.FREEBUFF_CONFIG_DIR = configRoot;
    try {
      const response = processLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "aoe-freebuf.status", params: {} }));
      expect(response?.result).toMatchObject({ ok: true, provider_version: "0.2.35", projects: 2, running: 2 });
    } finally {
      if (previous === undefined) delete process.env.FREEBUFF_CONFIG_DIR;
      else process.env.FREEBUFF_CONFIG_DIR = previous;
    }
  });
});
