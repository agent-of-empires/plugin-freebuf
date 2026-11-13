// ACP request/response framing tests: raw newline-delimited JSON-RPC is pushed
// through the real SDK transport with a fake pane source behind it, so no
// tmux and no freebuff run here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAdapter, type AdapterOptions } from "../src/adapter.ts";
import { memorySessionStore } from "../src/store.ts";
import { composerScreen, FakeClock, FakePane, fakePaneFactory, READY_SCREEN } from "./fake.ts";

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
  const store = memorySessionStore();
  const app = createAdapter({
    createPane: factory,
    store,
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
  return { client, panes, clock, store };
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
    assert.equal((response.result?.agentCapabilities as Record<string, unknown>)?.loadSession, true);

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
      // In-memory: a test must never write into the real resume store.
      store: memorySessionStore(),
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
/** A pane showing a resumed chat: transcript, then Freebuff's chrome. */
function resumedScreen(chatTitle: string, userText: string, answer: string): string {
  return [
    "  freebuff",
    "",
    "   [02:42 PM]",
    `   ${userText} ⎘`,
    "",
    `  ${answer}`,
    "",
    "╭────────────────────────────────────────────────────────────────────────────╮",
    "│  ▍Enter a coding task or / for commands                                    │",
    "╰────────────────────────────────────────────────────────────────────────────╯",
    ` DeepSeek V4.1 Flash Slow · /tmp/project · Chat: ${chatTitle}`,
    " ← for history · ? for help",
  ].join("\n");
}

/** Connects an adapter whose panes are scripted by `configure`. */
function connectResumed(options: {
  screen: string;
  store: ReturnType<typeof memorySessionStore>;
  configure?: (pane: FakePane) => void;
  /** Delay between accepting a `session/load` and its pane existing. */
  gate?: () => Promise<void>;
}) {
  const clock = new FakeClock();
  const { factory, panes } = fakePaneFactory(options.screen, options.configure);
  const createPane: typeof factory = async (request) => {
    // Only await when a gate is used: an extra tick here lets a prompt that a
    // host sent right behind the load reach the handler before the session is
    // registered, which is a test artefact, not a behaviour worth pinning.
    if (options.gate !== undefined) {
      await options.gate();
    }
    return factory(request);
  };
  const app = createAdapter({
    createPane,
    store: options.store,
    bridge: { ...DEFAULT_BRIDGE, now: clock.now, sleep: clock.sleep },
  });
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  app.connect(
    ndJsonStream(
      Writable.toWeb(fromAgent) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(toAgent) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  return { client: new TestClient(toAgent, fromAgent), panes, clock };
}

describe("session/load (resume)", () => {
  it("starts the pane with --continue and replays the restored conversation", async () => {
    const title = "Remember the word ORANGE. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-9-abc": { cwd: "/tmp/project", title } });
    const { client, panes } = connectResumed({ screen: resumedScreen(title, title, "STORED"), store });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-9-abc", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal(response.error, undefined);
    assert.equal(panes[0].meta.resume, true);
    assert.equal(store.get("freebuff-acp-9-abc")?.title, title);

    const replayed = client.rawLines
      .map((line) => JSON.parse(line) as Message)
      .filter((message) => message.method === "session/update")
      .map((message) => {
        const update = message.params?.update as { sessionUpdate: string; content: { text: string } };
        return `${update.sessionUpdate}:${update.content.text.trim()}`;
      });
    assert.deepEqual(replayed, [
      `user_message_chunk:${title}`,
      "agent_message_chunk:STORED",
    ]);
  });

  it("picks the recorded chat out of /history when --continue opened another", async () => {
    const expected = "Remember the word BANANA. Reply with just: STORED2";
    const store = memorySessionStore({ "freebuff-acp-7-xyz": { cwd: "/tmp/project", title: expected } });
    const { client, panes } = connectResumed({
      screen: resumedScreen("New chat", "", ""),
      store,
      configure: (pane) => {
        // Typing /history and pressing Enter opens the picker; a second Enter
        // picks the highlighted chat. Two Enters, exactly as the TUI behaves.
        let pendingHistory = false;
        pane.onSend = (keys) => {
          if (keys === "/history") {
            pendingHistory = true;
            return;
          }
          if (keys !== "Enter") return;
          if (pendingHistory) {
            pendingHistory = false;
            pane.screen = [
              "                            Select a chat to resume",
              "  ▍Search chats...",
              "  ┌─────────────────────────────────────────────────────────────┐",
              "  │ 1m ago    3 msgs   Something else entirely                  │",
              `  │ 5m ago    3 msgs   ${expected} │`,
              "  └─────────────────────────────────────────────────────────────┘",
            ].join("\n");
            return;
          }
          if (pane.screen.includes("Select a chat")) {
            pane.screen = resumedScreen(expected, expected, "STORED2");
          }
        };
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-7-xyz", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal(response.error, undefined);
    assert.equal(panes[0].meta.resume, true);
    assert.deepEqual(
      panes[0].sent.map((entry) => entry.keys),
      ["/history", "Enter", "Down", "Enter"],
    );
    assert.equal(store.get("freebuff-acp-7-xyz")?.title, expected);
  });
});

describe("session/load serialisation", () => {
  it("holds a prompt that arrives during the resume until the picker is done", async () => {
    const expected = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-5-q": { cwd: "/tmp/project", title: expected } });
    const { client, panes } = connectResumed({
      screen: resumedScreen("New chat", "", ""),
      store,
      configure: (pane) => {
        let pendingHistory = false;
        pane.onSend = (keys) => {
          if (keys === "/history") {
            pendingHistory = true;
            return;
          }
          if (keys !== "Enter") return;
          if (pendingHistory) {
            pendingHistory = false;
            pane.screen = [
              "                            Select a chat to resume",
              "  ▍Search chats...",
              "  ╭─────────────────────────────────────────────────────╮",
              `  │ 5m ago    3 msgs   ${expected} │`,
              "  ╰─────────────────────────────────────────────────────╯",
            ].join("\n");
            return;
          }
          if (pane.screen.includes("Select a chat")) {
            pane.screen = resumedScreen(expected, expected, "STORED");
          }
        };
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-5-q", cwd: "/tmp/project", mcpServers: [] },
    });
    // The wake prompt a host sends on resume, dispatched without waiting.
    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId: "freebuff-acp-5-q", prompt: [{ type: "text", text: "wake up" }] },
    });

    await client.next((m) => m.id === 5);
    await client.next((m) => m.id === 6);

    const keys = panes[0].sent.map((entry) => entry.keys);
    // The picker navigation finishes before the wake prompt is typed.
    assert.deepEqual(keys, ["/history", "Enter", "Enter", "wake up", "Enter"]);
  });

  it("rejects a second prompt that arrives during the same resume", async () => {
    // Both prompts used to pass the "one turn at a time" check while the resume
    // was in flight, and were then typed into the same composer: one garbled
    // message, two responses.
    const expected = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-6-r": { cwd: "/tmp/project", title: expected } });
    const { client, panes } = connectResumed({
      screen: resumedScreen("New chat", "", ""),
      store,
      configure: (pane) => {
        let pendingHistory = false;
        pane.onSend = (keys) => {
          if (keys === "/history") {
            pendingHistory = true;
            return;
          }
          if (keys !== "Enter") return;
          if (pendingHistory) {
            pendingHistory = false;
            pane.screen = [
              "                            Select a chat to resume",
              "  ▍Search chats...",
              "  ╭─────────────────────────────────────────────────────╮",
              `  │ 5m ago    3 msgs   ${expected} │`,
              "  ╰─────────────────────────────────────────────────────╯",
            ].join("\n");
            return;
          }
          if (pane.screen.includes("Select a chat")) {
            pane.screen = resumedScreen(expected, expected, "STORED");
          }
        };
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-6-r", cwd: "/tmp/project", mcpServers: [] },
    });
    for (const [id, text] of [
      [6, "first prompt"],
      [7, "second prompt"],
    ] as [number, string][]) {
      client.send({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId: "freebuff-acp-6-r", prompt: [{ type: "text", text }] },
      });
    }

    await client.next((m) => m.id === 5);
    const first = await client.next((m) => m.id === 6);
    const second = await client.next((m) => m.id === 7);

    const failed = [first, second].filter((m) => m.error !== undefined);
    assert.equal(failed.length, 1, "exactly one of the two prompts must be rejected");
    assert.equal((failed[0].error as { code: number }).code, -32000);

    const typed = panes[0].sent.map((entry) => entry.keys).filter((keys) => keys.includes("prompt"));
    assert.deepEqual(typed, ["first prompt"], "the rejected prompt must not reach the composer");
  });
});

describe("session/load guards", () => {
  it("refuses a load whose session was never recorded", async () => {
    // Nothing identifies the chat the host asks for, so any chat the directory
    // reopens would be replayed and then recorded as this session's history.
    const { client, panes } = connectResumed({ screen: resumedScreen("New chat", "", ""), store: memorySessionStore() });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-never-seen", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /no recorded conversation/);
    assert.equal(panes.length, 0, "a pane was created for a session with no record");
  });

  it("refuses a load whose record has no chat title", async () => {
    // A session killed before its first turn has a directory but no title, and
    // a title is the only handle the TUI gives us for finding its chat again.
    const store = memorySessionStore({ "freebuff-acp-5-notitle": { cwd: "/tmp/project", title: null } });
    const { client, panes } = connectResumed({ screen: resumedScreen("New chat", "", ""), store });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-5-notitle", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /no recorded conversation/);
    assert.equal(panes.length, 0);
  });

  it("accepts the recorded directory spelled with a trailing slash", async () => {
    const title = "Remember the word PEAR. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-6-slash": { cwd: "/tmp/project", title } });
    const { client } = connectResumed({ screen: resumedScreen(title, title, "STORED"), store });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-6-slash", cwd: "/tmp/project/", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal(response.error, undefined);
  });

  it("refuses a second load while the first one is still creating its pane", async () => {
    // Both loads would otherwise start a tmux session under the same name, and
    // a failed one would delete the entry the other had just registered.
    const title = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-10-race": { cwd: "/tmp/project", title } });
    let release: () => void = () => {};
    let entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, panes } = connectResumed({
      screen: resumedScreen(title, title, "STORED"),
      store,
      gate: async () => {
        entered = true;
        await held;
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-10-race", cwd: "/tmp/project", mcpServers: [] },
    });
    for (let i = 0; i < 200 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(entered, "the first load never reached the pane factory");

    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/load",
      params: { sessionId: "freebuff-acp-10-race", cwd: "/tmp/project", mcpServers: [] },
    });
    const second = await client.next((m) => m.id === 6);
    assert.equal((second.error as { code: number }).code, -32000);
    assert.match((second.error as { message: string }).message, /busy/);

    release();
    const first = await client.next((m) => m.id === 5);
    assert.equal(first.error, undefined);
    assert.equal(panes.length, 1, "both loads started a pane");
  });

  it("refuses a prompt that arrives while the load is creating its pane", async () => {
    // Reloading a live session is the case that matters: its old state is still
    // in the map and idle, and the load is about to kill the pane that state
    // points at. A turn accepted in that window types into a dying pane and is
    // then thrown away with it.
    const title = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore();
    let release: () => void = () => {};
    let entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creations = 0;
    const { client, panes } = connectResumed({
      screen: resumedScreen(title, title, "STORED"),
      store,
      gate: async () => {
        // The first pane is `session/new`; hold the second one, the load's.
        if (creations++ === 0) return;
        entered = true;
        await held;
      },
    });
    await initialize(client);
    const sessionId = await newSession(client, "/tmp/project");
    store.set(sessionId, { cwd: "/tmp/project", title });

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId, cwd: "/tmp/project", mcpServers: [] },
    });
    for (let i = 0; i < 200 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(entered, "the load never reached the pane factory");

    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "too early" }] },
    });
    const early = await client.next((m) => m.id === 6);
    assert.equal((early.error as { code: number }).code, -32000);
    assert.match((early.error as { message: string }).message, /busy/);

    release();
    const load = await client.next((m) => m.id === 5);
    assert.equal(load.error, undefined);
    const typed = panes.flatMap((pane) => pane.sent.map((entry) => entry.keys));
    assert.ok(!typed.includes("too early"), "the refused prompt reached a composer");
  });

  it("drops the pane the reload killed when the new one cannot start", async () => {
    // A resumed pane kills the old tmux session before it starts its own, so a
    // failed start leaves the registered state pointing at a session that no
    // longer exists. A later prompt would type into it.
    const title = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore();
    let creations = 0;
    const { client, panes } = connectResumed({
      screen: resumedScreen(title, title, "STORED"),
      store,
      gate: async () => {
        // The first pane is `session/new`; the load's is the one that fails.
        if (creations++ === 0) return;
        throw new Error("the recorded working directory is gone");
      },
    });
    await initialize(client);
    const sessionId = await newSession(client, "/tmp/project");
    store.set(sessionId, { cwd: "/tmp/project", title });

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId, cwd: "/tmp/project", mcpServers: [] },
    });
    const load = await client.next((m) => m.id === 5);
    assert.equal((load.error as { code: number }).code, -32000);

    assert.equal(panes[0].stopped, true, "the pane the reload killed is still registered");
    assert.equal(store.get(sessionId)?.title, title, "the record must survive the failed load");

    // The session is gone, so a prompt is refused instead of typed into a pane
    // that no longer exists.
    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "still there?" }] },
    });
    const prompt = await client.next((m) => m.id === 6);
    assert.equal((prompt.error as { code: number }).code, -32002);
  });

  it("does not interrupt the pane when a cancel arrives during a load", async () => {
    // The load is driving /history: the interrupt key would cancel the picker
    // and fail the resume the host is waiting for.
    const title = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore();
    let release: () => void = () => {};
    let entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creations = 0;
    const { client, panes } = connectResumed({
      screen: resumedScreen(title, title, "STORED"),
      store,
      gate: async () => {
        if (creations++ === 0) return;
        entered = true;
        await held;
      },
    });
    await initialize(client);
    const sessionId = await newSession(client, "/tmp/project");
    store.set(sessionId, { cwd: "/tmp/project", title });

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId, cwd: "/tmp/project", mcpServers: [] },
    });
    for (let i = 0; i < 200 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(entered, "the load never reached the pane factory");

    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    // Give the cancel a turn of the loop before the load is released.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    const load = await client.next((m) => m.id === 5);
    assert.equal(load.error, undefined, "the cancel tore the resume down");
    const typed = panes.flatMap((pane) => pane.sent.map((entry) => entry.keys));
    assert.ok(!typed.includes("C-c"), "the interrupt key was sent into the picker");
  });

  it("does not interrupt the pane while the loaded pane is picking a chat", async () => {
    // The wake prompt is parked on the load, which is waiting in the /history
    // picker. An interrupt key here cancels the picker and fails the resume.
    const title = "Remember the word PLUM. Reply with just: STORED";
    const store = memorySessionStore();
    // A settled composer whose picker never lists anything: the load keeps
    // polling until its deadline instead of finishing.
    const { client, panes } = connectResumed({ screen: READY_SCREEN, store });
    await initialize(client);
    const sessionId = await newSession(client, "/tmp/project");
    store.set(sessionId, { cwd: "/tmp/project", title });

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId, cwd: "/tmp/project", mcpServers: [] },
    });
    // Let the load get as far as the picker.
    const loaded = panes[panes.length - 1];
    for (let i = 0; i < 200 && !loaded.sent.some((entry) => entry.keys === "/history"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const typed = panes.flatMap((pane) => pane.sent.map((entry) => entry.keys));
    assert.ok(!typed.includes("C-c"), "the interrupt key was sent into the picker");
    // Release the load so the test does not leave it running.
    await client.next((m) => m.id === 5);
  });

  it("fails the load when the recorded chat is not the one that opened", async () => {
    // The picker cannot find the recorded chat, so the pane is showing some
    // other conversation: replaying it and rewriting the record would hand the
    // host a transcript it never asked for.
    const store = memorySessionStore({ "freebuff-acp-2-gone": { cwd: "/tmp/project", title: "a chat that is gone" } });
    const { client, panes } = connectResumed({
      screen: resumedScreen("something else", "something else", "other answer"),
      store,
      configure: (pane) => {
        let pendingHistory = false;
        pane.onSend = (keys) => {
          if (keys === "/history") {
            pendingHistory = true;
            return;
          }
          if (keys !== "Enter" || !pendingHistory) return;
          pendingHistory = false;
          pane.screen = [
            "                            Select a chat to resume",
            "  ▍Search chats...",
            "  ╭─────────────────────────────────────────────────────╮",
            "  │ 5m ago    3 msgs   something else                   │",
            "  ╰─────────────────────────────────────────────────────╯",
            "  ↑↓ navigate · → / Enter open chat · Esc cancel",
          ].join("\n");
        };
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-2-gone", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /is not in this directory's history/);
    assert.equal(panes[0].stopped, true, "the pane was left running on the wrong chat");
  });

  it("refuses to reopen a recorded conversation in another directory", async () => {
    // The record's title belongs to the directory it was started in. Opening
    // elsewhere keeps that title while showing a different chat, and the store
    // write would rebind the session to the new directory.
    const store = memorySessionStore({ "freebuff-acp-3-cwd": { cwd: "/tmp/first", title: "Fix tests" } });
    const { client, panes } = connectResumed({ screen: resumedScreen("Fix tests", "Fix tests", "ok"), store });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-3-cwd", cwd: "/tmp/second", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /recorded in '\/tmp\/first'/);
    assert.equal(panes.length, 0, "a pane was created for a rejected load");
  });

  it("refuses a load while the session is running a turn", async () => {
    // A load replaces the entry with a new pane under the same tmux name, and
    // the resume path kills that name first: the running turn would keep
    // sending keys into the replacement.
    const title = "Remember the word ORANGE. Reply with just: STORED";
    const store = memorySessionStore({ "freebuff-acp-4-busy": { cwd: "/tmp/project", title } });
    const { client, panes } = connectResumed({
      screen: resumedScreen(title, title, "STORED"),
      store,
      configure: (pane) => {
        // Once the prompt is typed the turn stalls on a capture that never
        // returns, so it is still in flight in real time when the load arrives.
        let stalled = false;
        pane.onSend = (keys) => {
          if (keys === "wake up") stalled = true;
        };
        const originalCapture = pane.capture.bind(pane);
        pane.capture = () =>
          stalled ? new Promise<string>(() => {}) : originalCapture();
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-4-busy", cwd: "/tmp/project", mcpServers: [] },
    });
    await client.next((m) => m.id === 5);
    client.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId: "freebuff-acp-4-busy", prompt: [{ type: "text", text: "wake up" }] },
    });
    // Wait for that turn to be in flight on the pane, then try to load again.
    for (let i = 0; i < 200 && !panes[0].sent.some((entry) => entry.keys === "wake up"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(panes[0].sent.some((entry) => entry.keys === "wake up"), "the turn never started");

    client.send({
      jsonrpc: "2.0",
      id: 7,
      method: "session/load",
      params: { sessionId: "freebuff-acp-4-busy", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 7);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /busy/);
    assert.equal(panes.length, 1, "a second pane was created for a rejected load");
  });
});

describe("session/load failure", () => {
  it("closes the pane and reports the error when the conversation cannot be reopened", async () => {
    const { client, panes } = connectResumed({
      screen: resumedScreen("New chat", "", ""),
      store: memorySessionStore({ "freebuff-acp-8-boom": { cwd: "/tmp/project", title: "some chat" } }),
      configure: (pane) => {
        pane.capture = async () => {
          throw new Error("pane exploded");
        };
      },
    });
    await initialize(client);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
      params: { sessionId: "freebuff-acp-8-boom", cwd: "/tmp/project", mcpServers: [] },
    });
    const response = await client.next((m) => m.id === 5);

    assert.equal((response.error as { code: number }).code, -32000);
    assert.match((response.error as { message: string }).message, /failed to resume the conversation/);
    assert.equal(panes[0].stopped, true, "the half-resumed pane must not be left running");
  });
});
