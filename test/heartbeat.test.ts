import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLAG_TTL_MS, heartbeat, processLine, sendRequest, setOutbound } from "../src/index";
import { REPLY_FILENAME, type KeyStep } from "../src/replies";

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
  const DIALOG = [
    "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
    "│                                                                                 Close ✕ │",
    "│ ▼ How far should the row shrink?                                                        │",
    "│   ○ Icon only, drop sort/filter                                                         │",
    "│   ○ Keep the label, drop the sort arrows                                                │",
    "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
  ].join("\n");
  const ERROR = "╭──── Error ────╮\n│        Close ✕ │\n╰───────────────╯";
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

  it("flags a session showing an error dialog, and reports its status", async () => {
    const { hookBase, now } = await runTick([{ id: "sess-failed", tool: "freebuff" }], { "sess-failed": ERROR });

    // An error dialog wants a dismissal, not an answer, so it is worth the user's
    // attention just like a question is.
    expect(flag(hookBase, "sess-failed")).toEqual({
      urgent: true,
      urgent_expires_at: Math.floor((now + FLAG_TTL_MS) / 1000),
    });
    expect(report(hookBase, "sess-failed")).toMatchObject({ schema_version: 1, status: "error" });
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

  it("publishes the blocked dialog as a prompt the host can offer", async () => {
    const { hookBase } = await runTick([{ id: "sess-dialog", tool: "freebuff" }], { "sess-dialog": DIALOG });
    const published = report(hookBase, "sess-dialog");
    expect(published).toMatchObject({ status: "waiting", revision: 0, reply_keys: ["F12"] });
    const prompt = published?.prompt as { kind: string; title: string; questions: Array<Record<string, unknown>> };
    expect(prompt.kind).toBe("question");
    expect(prompt.title).toBe("How far should the row shrink?");
    expect(prompt.questions[0]).toMatchObject({
      question: "How far should the row shrink?",
      options: [{ label: "Icon only, drop sort/filter" }, { label: "Keep the label, drop the sort arrows" }],
    });
  });

  it("publishes no prompt for a session that is only flag-waiting", async () => {
    // The bare "Close ✕" chrome has no question or options to answer.
    const { hookBase } = await runTick([{ id: "sess-bare", tool: "freebuff" }], { "sess-bare": WAITING });
    expect(report(hookBase, "sess-bare")).toMatchObject({ status: "waiting", reply_keys: [], prompt: null });
  });

  it("keeps the revision while the same dialog stays up and bumps it when it changes", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const tick = async (pane: string): Promise<void> => {
      const sent: string[] = [];
      setOutbound((line) => sent.push(line));
      const run = heartbeat({ hookBase, now: 1_700_000_000_000, capture: async () => pane, send: async () => "sent" });
      const request = JSON.parse(sent[0]) as { id: number };
      processLine(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-rev", tool: "freebuff" }] } }),
      );
      await run;
    };

    await tick(DIALOG);
    expect(report(hookBase, "sess-rev")).toMatchObject({ revision: 0 });
    await tick(DIALOG);
    // Same question, same revision: a reply the user is writing stays valid.
    expect(report(hookBase, "sess-rev")).toMatchObject({ revision: 0 });
    await tick(DIALOG.replace("drop the sort arrows", "keep the sort arrows"));
    expect(report(hookBase, "sess-rev")).toMatchObject({ revision: 1 });
    await tick(IDLE);
    // The prompt is gone, so its removal is a change too.
    expect(report(hookBase, "sess-rev")).toMatchObject({ revision: 2, prompt: null, reply_keys: [] });
  });

  it("answers the dialog with the keys that select the chosen option", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-answer");
    const sent: string[] = [];
    const delivered: Array<{ id: string; steps: readonly KeyStep[] }> = [];
    setOutbound((line) => sent.push(line));
    const now = 1_700_000_000_000;
    const tick = heartbeat({
      hookBase,
      now,
      capture: async () => DIALOG,
      send: async (id, steps) => {
        delivered.push({ id, steps });
        return "sent";
      },
    });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-answer", tool: "freebuff" }] } }),
    );
    await tick;

    // The host writes the answer after the user responds; the next tick delivers it.
    const published = report(hookBase, "sess-answer") as Record<string, unknown>;
    const prompt = published.prompt as { id: string; questions: Array<{ id: string }> };
    const replyFile = path.join(dir, "integration-agent-of-empires.aoe-freebuf.reply.json");
    writeFileSync(
      replyFile,
      JSON.stringify({
        schema_version: 1,
        instance_id: "sess-answer",
        provider_session_id: published.provider_session_id,
        writer_pid: published.writer_pid,
        revision: published.revision,
        prompt_id: prompt.id,
        response_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        response: {
          kind: "question",
          answers: [{ id: prompt.questions[0].id, selected_options: ["Keep the label, drop the sort arrows"] }],
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(replyFile, 0o600);

    setOutbound((line) => sent.push(line));
    const second = heartbeat({
      hookBase,
      now,
      capture: async () => DIALOG,
      send: async (id, steps) => {
        delivered.push({ id, steps });
        return "sent";
      },
    });
    const secondRequest = JSON.parse(sent[sent.length - 1]) as { id: number };
    processLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: secondRequest.id,
        result: { sessions: [{ id: "sess-answer", tool: "freebuff" }] },
      }),
    );
    await second;

    // Up/Down/Left/Down settle the focus on the first option, then Down reaches
    // the second one: Enter selects it, and the last question leaves Submit
    // focused, so the second Enter submits the form.
    expect(delivered).toEqual([
      { id: "sess-answer", steps: [{ keys: ["Up", "Down", "Left", "Down", "Down", "Enter", "Enter"] }] },
    ]);
    expect(existsSync(replyFile)).toBe(false); // consumed, so it cannot be replayed
  });

  it("answers a multi-select question by toggling each choice, then Submit", async () => {
    const multi = [
      "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
      "│                                                                                 Close ✕ │",
      "│ ▼ Which checks should run?                                                              │",
      "│   (Select multiple options)                                                             │",
      "│   ☐ Unit tests                                                                          │",
      "│   ☐ Lint                                                                                │",
      "│   ☐ Custom                                                                              │",
      "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-multi");
    const sent: string[] = [];
    const delivered: unknown[] = [];
    const runTick = async (): Promise<void> => {
      setOutbound((line) => sent.push(line));
      const tick = heartbeat({
        hookBase,
        now: 1_700_000_000_000,
        capture: async () => multi,
        send: async (id, steps) => {
          delivered.push({ id, steps });
          return "sent";
        },
      });
      const request = JSON.parse(sent[sent.length - 1]) as { id: number };
      processLine(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-multi", tool: "freebuff" }] } }),
      );
      await tick;
    };
    await runTick();

    const published = report(hookBase, "sess-multi") as Record<string, unknown>;
    const prompt = published.prompt as { id: string; questions: Array<Record<string, unknown>> };
    expect(prompt.questions[0]).toMatchObject({ multi: true });
    const replyFile = path.join(dir, REPLY_FILENAME);
    writeFileSync(
      replyFile,
      JSON.stringify({
        schema_version: 1,
        instance_id: "sess-multi",
        provider_session_id: published.provider_session_id,
        writer_pid: published.writer_pid,
        revision: published.revision,
        prompt_id: prompt.id,
        response_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        response: {
          kind: "question",
          answers: [{ id: (prompt.questions[0] as { id: string }).id, selected_options: ["Unit tests", "Lint"] }],
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(replyFile, 0o600);
    await runTick();

    expect(delivered).toEqual([
      { id: "sess-multi", steps: [{ keys: ["Up", "Down", "Left", "Down", "Enter", "Down", "Enter", "Tab", "Enter"] }] },
    ]);
    expect(existsSync(replyFile)).toBe(false);
  });

  it("leaves a reply that does not match the published prompt alone", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-stale");
    mkdirSync(dir, { recursive: true });
    const replyFile = path.join(dir, "integration-agent-of-empires.aoe-freebuf.reply.json");
    writeFileSync(replyFile, JSON.stringify({ schema_version: 1, instance_id: "other" }), { mode: 0o600 });
    chmodSync(replyFile, 0o600);

    const delivered: Array<readonly KeyStep[]> = [];
    const sent: string[] = [];
    setOutbound((line) => sent.push(line));
    const tick = heartbeat({
      hookBase,
      now: 1_700_000_000_000,
      capture: async () => DIALOG,
      send: async (_id, steps) => {
        delivered.push(steps);
        return "sent";
      },
    });
    const request = JSON.parse(sent[0]) as { id: number };
    processLine(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-stale", tool: "freebuff" }] } }),
    );
    await tick;

    expect(delivered).toEqual([]);
    expect(existsSync(replyFile)).toBe(true);
  });

  it("keeps a reply it could not deliver for the next tick", async () => {
    const hookBase = tempDir("aoe-hooks-");
    const dir = path.join(hookBase, "sess-gone");
    const sent: string[] = [];
    const runTickWith = async (deliver: "sent" | "none"): Promise<void> => {
      setOutbound((line) => sent.push(line));
      const tick = heartbeat({
        hookBase,
        now: 1_700_000_000_000,
        capture: async () => DIALOG,
        send: async () => deliver,
      });
      const request = JSON.parse(sent[sent.length - 1]) as { id: number };
      processLine(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "sess-gone", tool: "freebuff" }] } }),
      );
      await tick;
    };
    await runTickWith("sent");

    const published = report(hookBase, "sess-gone") as Record<string, unknown>;
    const prompt = published.prompt as { id: string; questions: Array<{ id: string }> };
    const replyFile = path.join(dir, "integration-agent-of-empires.aoe-freebuf.reply.json");
    writeFileSync(
      replyFile,
      JSON.stringify({
        schema_version: 1,
        instance_id: "sess-gone",
        provider_session_id: published.provider_session_id,
        writer_pid: published.writer_pid,
        revision: published.revision,
        prompt_id: prompt.id,
        response_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        response: { kind: "question", answers: [{ id: prompt.questions[0].id, selected_options: ["Keep the label, drop the sort arrows"] }] },
      }),
      { mode: 0o600 },
    );
    chmodSync(replyFile, 0o600);

    // The pane vanished between capture and send: the answer is not consumed.
    await runTickWith("none");
    expect(existsSync(replyFile)).toBe(true);

    await runTickWith("sent");
    expect(existsSync(replyFile)).toBe(false);
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
