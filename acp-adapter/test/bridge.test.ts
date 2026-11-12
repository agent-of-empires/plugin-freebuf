import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPermissionPrompt,
  runTurn,
  type BridgeConfig,
  type TurnNotice,
} from "../src/bridge.ts";
import { FakeClock, FakePane, READY_SCREEN } from "./fake.ts";

const meta = { sessionId: "s1", cwd: "/tmp/project" };

function testConfig(clock: FakeClock, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    pollIntervalMs: 100,
    quiescenceMs: 300,
    echoTimeoutMs: 500,
    maxTurnMs: 10_000,
    // Most screens here are not shaped like the real TUI, so the readiness wait
    // would only burn virtual time; the test that is about readiness sets it.
    startupTimeoutMs: 0,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

function collect() {
  const chunks: string[] = [];
  const notices: TurnNotice[] = [];
  return {
    chunks,
    notices,
    events: {
      onChunk: (text: string) => {
        chunks.push(text);
      },
      onNotice: (notice: TurnNotice) => {
        notices.push(notice);
      },
      isCancelled: () => false,
    },
  };
}

describe("runTurn", () => {
  it("types the prompt literally, submits it, and streams only new output", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "boot\n> do the thing";
      }
    };
    let produced = false;
    clock.onAdvance = (time) => {
      if (time >= 400 && !produced) {
        produced = true;
        pane.screen = "boot\n> do the thing\nthe answer is 42";
      }
    };

    const result = await runTurn({ pane, promptText: "do the thing", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(sink.chunks, ["the answer is 42"]);
    assert.deepEqual(
      pane.sent.map((entry) => entry.keys),
      ["do the thing", "Enter"],
    );
    assert.equal(pane.sent[0].options?.literal, true, "prompt must be sent as literal text");
    assert.equal(pane.sent[1].options?.literal, undefined);
  });

  it("does not stream the TUI echo of the user's own prompt", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "boot\n> write the parser";
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 300) {
        pane.screen = "boot\n> write the parser\nparser written";
      }
    };

    await runTurn({ pane, promptText: "write the parser", config: testConfig(clock), events: sink.events });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("write the parser"), false, "echo leaked into assistant output");
    assert.equal(streamed.includes("parser written"), true);
  });

  it("does not stream a prompt echo that arrives after the echo window", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    // The TUI only puts the user's message in the transcript well after the
    // window the bridge initially waits, which is what a long prompt does.
    clock.onAdvance = (time) => {
      if (time >= 900) {
        pane.screen = "boot\n   [03:52 PM]\n   remember the word PLUM ⎘";
      }
      if (time >= 1_500) {
        pane.screen = "boot\n   [03:52 PM]\n   remember the word PLUM ⎘\n\n  PLUM";
      }
    };

    await runTurn({
      pane,
      promptText: "remember the word PLUM",
      config: testConfig(clock, { echoTimeoutMs: 500 }),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("remember the word PLUM"), false, "late echo leaked into assistant output");
    assert.equal(streamed.includes("PLUM"), true);
  });

  it("stops with cancelled when the turn is interrupted", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    let cancelled = false;
    sink.events.isCancelled = () => cancelled;
    clock.onAdvance = (time) => {
      if (time >= 200) {
        cancelled = true;
      }
    };

    const result = await runTurn({ pane, promptText: "hi", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.streamedChars, 0);
  });

  it("cuts the turn off at maxTurnMs when the pane never goes quiet", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "boot\n> go";
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 200) {
        pane.screen = `boot\n> go\nstep ${time}`;
      }
    };

    const result = await runTurn({ pane, promptText: "go", config: testConfig(clock), events: sink.events });

    // The screen keeps changing, so quiescence never fires: the turn is cut
    // off by maxTurnMs instead of hanging forever.
    assert.equal(result.stopReason, "end_turn");
    assert.ok(clock.time >= 10_000, `expected the turn to hit maxTurnMs, ran to ${clock.time}`);
    assert.ok(sink.chunks.length > 0);
  });

  it("finishes with end_turn when the pane never changes at all", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "boot\n> silent";
      }
    };

    const result = await runTurn({
      pane,
      promptText: "silent",
      config: testConfig(clock, { maxTurnMs: 1_000 }),
      events: sink.events,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(sink.chunks, []);
    assert.ok(clock.time >= 1_000);
  });

  it("waits for the TUI to settle before typing the prompt", async () => {
    // Freebuff paints a splash first and drops keystrokes sent into it, so the
    // prompt must not be typed until the input box has appeared and stopped
    // changing.
    const clock = new FakeClock();
    const pane = new FakePane(meta, "  freebuff loading");
    const sink = collect();
    let screenAtFirstSend: string | null = null;
    pane.onSend = (keys, options) => {
      if (options?.literal && screenAtFirstSend === null) {
        screenAtFirstSend = pane.screen;
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 400) pane.screen = READY_SCREEN;
    };

    const result = await runTurn({
      pane,
      promptText: "hello",
      config: testConfig(clock, { echoTimeoutMs: 100, startupTimeoutMs: 2_000 }),
      events: sink.events,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.ok(screenAtFirstSend !== null, "the prompt was never sent");
    assert.match(String(screenAtFirstSend), /▍/, "prompt typed before the input box appeared");
    assert.ok(clock.time >= 400, `waited only ${clock.time}ms for the TUI`);
  });

  it("keeps the turn open while the status line says it is working", async () => {
    // The transcript can sit unchanged for longer than the quiescence window
    // while the agent is still thinking; only the status line knows.
    const working = (status: string, answer?: string) =>
      [
        "   my prompt",
        "",
        ...(answer === undefined ? [] : [`  ${answer}`, ""]),
        status,
        "╭──────────────────╮",
        "│  ▍Add a task     │",
        "╰──────────────────╯",
        " DeepSeek V4.1 Flash Slow · /tmp · Chat: chat",
      ].join("\n");
    const clock = new FakeClock();
    const pane = new FakePane(meta, READY_SCREEN);
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") pane.screen = working(" thinking...   ■ Esc");
    };
    clock.onAdvance = (time) => {
      if (time >= 2_000) pane.screen = working(" 24.8K (19%)   ✕ End session", "the answer");
    };

    const result = await runTurn({
      pane,
      promptText: "my prompt",
      config: testConfig(clock, { quiescenceMs: 300, maxTurnMs: 10_000 }),
      events: sink.events,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.ok(
      clock.time >= 2_000,
      `turn ended at ${clock.time}ms, before the agent stopped working`,
    );
    assert.ok(sink.chunks.join("\n").includes("the answer"));
    // The status line and input box are chrome: they must never be streamed.
    assert.equal(sink.chunks.join("\n").includes("■ Esc"), false);
    assert.equal(sink.chunks.join("\n").includes("Add a task"), false);
  });

  it("reports the permission-prompt limitation exactly once per turn", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = "boot\n> run it";
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 200 && time < 300) {
        pane.screen = "boot\n> run it\nDo you want to allow this? y/n";
      } else if (time >= 300) {
        pane.screen = "boot\n> run it\nallowed";
      }
    };

    const result = await runTurn({ pane, promptText: "run it", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(sink.notices.length, 1, "permission notice must be emitted once");
    assert.equal(sink.notices[0].severity, "warning");
    assert.match(sink.notices[0].title, /not bridged/);
    assert.ok(sink.chunks.join("\n").includes("allowed"));
  });
});

describe("findPermissionPrompt", () => {
  it("matches recognized confirmation prompts", () => {
    assert.ok(findPermissionPrompt("Do you want to allow this tool?"));
    assert.ok(findPermissionPrompt("Trust these agents? [y/N]"));
    assert.ok(findPermissionPrompt("overwrite file (y/n)"));
    assert.ok(findPermissionPrompt("Permission required to run shell"));
  });

  it("leaves ordinary output alone", () => {
    assert.equal(findPermissionPrompt("all files written, 12 passed"), null);
    assert.equal(findPermissionPrompt("the sync/async boundary"), null);
    assert.equal(findPermissionPrompt(""), null);
  });
});
