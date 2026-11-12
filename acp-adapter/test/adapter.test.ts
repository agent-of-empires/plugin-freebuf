// ACP request/response framing tests: raw newline-delimited JSON-RPC is pushed
// through the real SDK transport with a fake pane source behind it, so no
// tmux and no freebuff run here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAdapter, type AdapterOptions } from "../src/adapter.ts";
import { composerScreen, FakeClock, fakePaneFactory } from "./fake.ts";

type Message = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const DEFAULT_BRIDGE = {
  pollIntervalMs: 100,
  quiescenceMs: 300,
  echoTimeoutMs: 500,
  maxTurnMs: 20_000,
  // Scripted screens carry a composer box, so readiness settles after
  // READY_STABLE_CAPTURES polls rather than timing out.
  startupTimeoutMs: 5_000,
};

/** Minimal in-test ACP client speaking raw NDJSON over two pipes. */
class TestClient {
  private readonly toAgent: PassThrough;
  private buffer = "";
  private readonly queue: Message[] = [];
  private readonly waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  /** Every line the agent wrote, verbatim, for framing assertions. */
  readonly rawLines: string[] = [];

  constructor(toAgent: PassThrough, fromAgent: PassThrough) {
    this.toAgent = toAgent;
    fromAgent.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim() !== "") {
          this.rawLines.push(line);
          this.deliver(JSON.parse(line) as Message);
        }
        index = this.buffer.indexOf("\n");
      }
    });
  }

  private deliver(message: Message): void {
    const index = this.waiters.findIndex((waiter) => waiter.pred(message));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  send(message: unknown): void {
    this.toAgent.write(`${JSON.stringify(message)}\n`);
  }

  /** Next message matching `pred` (any message when omitted), with a safety timeout. */
  next(pred: (m: Message) => boolean = () => true, timeoutMs = 5_000): Promise<Message> {
    const queued = this.queue.findIndex(pred);
    if (queued >= 0) {
      return Promise.resolve(this.queue.splice(queued, 1)[0]);
    }
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an ACP message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

function connect(overrides: Partial<AdapterOptions["bridge"]> = {}) {
  const clock = new FakeClock();
  const { factory, panes } = fakePaneFactory();
  const app = createAdapter({
    createPane: factory,
    bridge: { ...DEFAULT_BRIDGE, now: clock.now, sleep: clock.sleep, ...overrides },
  });
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  app.connect(
    ndJsonStream(
      Writable.toWeb(fromAgent) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(toAgent) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  const client = new TestClient(toAgent, fromAgent);
  return { client, panes, clock };
}

async function initialize(client: TestClient): Promise<void> {
  client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const response = await client.next((m) => m.id === 1);
  assert.equal(response.error, undefined);
}

async function newSession(client: TestClient, cwd = "/tmp/project"): Promise<string> {
  client.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
  const response = await client.next((m) => m.id === 2);
  assert.equal(response.error, undefined);
  return String(response.result?.sessionId);
}

describe("ACP framing over stdio transport", () => {
  it("rejects requests before initialize with -32600", async () => {
    const { client } = connect();
    client.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const response = await client.next((m) => m.id === 1);
    assert.equal(response.error?.code, -32600);
    assert.equal(response.result, undefined);
  });

  it("answers initialize with protocol version, capabilities and agent info", async () => {
    const { client } = connect();
    client.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: 1 } });
    const response = await client.next((m) => m.id === 7);

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.result?.protocolVersion, 1);
    assert.deepEqual(response.result?.agentInfo, { name: "freebuff-acp-adapter", version: "0.1.0" });
    assert.equal((response.result?.agentCapabilities as Record<string, unknown>)?.loadSession, false);

    // Framing: the whole reply is exactly one parseable JSON line.
    assert.equal(client.rawLines.length, 1);
    assert.doesNotThrow(() => JSON.parse(client.rawLines[0]));
    assert.equal(client.rawLines[0].includes("\n"), false);
  });

  it("creates a pane for session/new and returns its session id", async () => {
    const { client, panes } = connect();
    await initialize(client);
    const sessionId = await newSession(client, "/work/repo");

    assert.match(sessionId, /^freebuff-acp-/);
    assert.equal(panes.length, 1);
    assert.equal(panes[0].meta.cwd, "/work/repo");
    assert.equal(panes[0].meta.sessionId, sessionId);
    assert.ok(panes[0].captures >= 0);
  });

  it("returns -32002 when prompting an unknown session", async () => {
    const { client } = connect();
    await initialize(client);
    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] },
    });
    const response = await client.next((m) => m.id === 3);
    assert.equal(response.error?.code, -32002);
  });

  it("returns -32601 for an unknown method", async () => {
    const { client } = connect();
    await initialize(client);
    client.send({ jsonrpc: "2.0", id: 4, method: "bogus/method", params: {} });
    const response = await client.next((m) => m.id === 4);
    assert.equal(response.error?.code, -32601);
  });

  it("streams agent_message_chunk updates and then answers end_turn", async () => {
    const { client, panes, clock } = connect();
    await initialize(client);
    const sessionId = await newSession(client);
    const pane = panes[0];
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("freebuff ready", "> list the files");
      }
    };
    // Output appears once the TUI has settled, so it is new text for the turn.
    clock.onAdvance = (time) => {
      if (time >= 600 && time < 900) {
        pane.screen = composerScreen("freebuff ready", "> list the files", "found 3 files");
      } else if (time >= 900) {
        pane.screen = composerScreen("freebuff ready", "> list the files", "found 3 files", "3 files listed");
      }
    };

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "list the files" }] },
    });

    const first = await client.next((m) => m.method === "session/update");
    const second = await client.next((m) => m.method === "session/update");
    const response = await client.next((m) => m.id === 5);

    for (const update of [first, second]) {
      assert.equal(update.params?.sessionId, sessionId);
      const inner = update.params?.update as Record<string, unknown>;
      assert.equal(inner.sessionUpdate, "agent_message_chunk");
      assert.equal((inner.content as Record<string, unknown>).type, "text");
    }
    const streamed = [first, second]
      .map((m) => (m.params?.update as { content: { text: string } }).content.text)
      .join("");
    assert.equal(streamed, "found 3 files\n3 files listed");
    assert.deepEqual(response.result, { stopReason: "end_turn" });

    // Both updates were framed before the prompt response.
    assert.ok(client.rawLines.findIndex((l) => l.includes('"id":5')) > client.rawLines.findIndex((l) => l.includes("session/update")));
    // The prompt was typed literally and submitted.
    assert.deepEqual(
      pane.sent.map((entry) => entry.keys),
      ["list the files", "Enter"],
    );
    assert.equal(pane.sent[0].options?.literal, true);
  });

  it("sends the interrupt key on session/cancel without answering the notification", async () => {
    const { client, panes } = connect();
    await initialize(client);
    const sessionId = await newSession(client);

    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    // Wait until the agent has processed it: a follow-up request must be the
    // very next message on the wire, i.e. the notification produced no reply.
    client.send({ jsonrpc: "2.0", id: 99, method: "initialize", params: { protocolVersion: 1 } });
    const response = await client.next();

    assert.equal(response.id, 99);
    assert.equal(panes[0].sent.some((entry) => entry.keys === "C-c"), true);
  });

  it("ignores session/cancel for an unknown session", async () => {
    const { client } = connect();
    await initialize(client);
    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "missing" } });
    client.send({ jsonrpc: "2.0", id: 98, method: "initialize", params: { protocolVersion: 1 } });
    const response = await client.next();
    assert.equal(response.id, 98);
    assert.equal(response.error, undefined);
  });

  it("stops an in-flight turn with cancelled when session/cancel arrives", async () => {
    // Real timers here: cancellation must interleave with a live turn.
    const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const { factory, panes } = fakePaneFactory();
    const app = createAdapter({
      createPane: factory,
      bridge: { pollIntervalMs: 10, quiescenceMs: 1_500, echoTimeoutMs: 1_000, maxTurnMs: 10_000, ...clock },
    });
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    app.connect(
      ndJsonStream(
        Writable.toWeb(fromAgent) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(toAgent) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    const client = new TestClient(toAgent, fromAgent);
    await initialize(client);
    const sessionId = await newSession(client);
    const pane = panes[0];
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "ready\n> keep going";
        setTimeout(() => {
          pane.screen = "ready\n> keep going\nworking on it";
        }, 50);
      }
    };

    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "keep going" }] },
    });
    // The first chunk proves the turn is running; interrupt it right after.
    await client.next((m) => m.method === "session/update");
    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    const response = await client.next((m) => m.id === 6, 10_000);

    assert.deepEqual(response.result, { stopReason: "cancelled" });
    assert.equal(pane.sent.some((entry) => entry.keys === "C-c"), true);
  });
});
