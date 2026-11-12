import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPermissionPrompt,
  resumeChat,
  runTurn,
  type BridgeConfig,
  type TurnNotice,
} from "../src/bridge.ts";
import { composerScreen, FakeClock, FakePane, READY_SCREEN } from "./fake.ts";

const meta = { sessionId: "s1", cwd: "/tmp/project" };

function testConfig(clock: FakeClock, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    pollIntervalMs: 100,
    quiescenceMs: 300,
    echoTimeoutMs: 500,
    maxTurnMs: 10_000,
    startupTimeoutMs: 1_000,
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
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "> do the thing");
      }
    };
    let produced = false;
    clock.onAdvance = (time) => {
      if (time >= 400 && !produced) {
        produced = true;
        pane.screen = composerScreen("boot", "> do the thing", "the answer is 42");
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
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "> write the parser");
      }
    };
    // After the readiness wait, so the answer is new output rather than part of
    // the baseline the turn starts from.
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "> write the parser", "parser written");
      }
    };

    await runTurn({ pane, promptText: "write the parser", config: testConfig(clock), events: sink.events });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("write the parser"), false, "echo leaked into assistant output");
    assert.equal(streamed.includes("parser written"), true);
  });

  it("does not stream a prompt echo that arrives after the echo window", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    // The TUI only puts the user's message in the transcript well after the
    // window the bridge initially waits, which is what a long prompt does.
    clock.onAdvance = (time) => {
      if (time >= 900) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   remember the word PLUM ⎘");
      }
      if (time >= 1_500) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   remember the word PLUM ⎘", "", "  PLUM");
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
    const pane = new FakePane(meta, composerScreen("boot"));
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
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "> go");
      }
    };
    // Churn starts once the TUI has settled, so the readiness wait can finish
    // and the turn itself is what never goes quiet.
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "> go", `step ${time}`);
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
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "> silent");
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
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "> run it");
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 600 && time < 900) {
        pane.screen = composerScreen("boot", "> run it", "Do you want to allow this? y/n");
      } else if (time >= 900) {
        pane.screen = composerScreen("boot", "> run it", "allowed");
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

describe("echo handling", () => {
  it("suppresses an echo of a prompt the TUI wrapped over several rows", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const prompt = "summarise the failing tests in the parser module and say why each one broke";
    // The TUI wraps the message, so the transcript holds the same words split
    // across rows rather than the single line that was sent.
    const wrapped = composerScreen(
      "boot",
      "   [03:52 PM]",
      "   summarise the failing tests in the parser ⎘",
      "   module and say why each one broke",
    );
    pane.onSend = (keys) => {
      if (keys === "Enter") pane.screen = wrapped;
    };
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM]",
          "   summarise the failing tests in the parser ⎘",
          "   module and say why each one broke",
          "",
          "  three tests broke on timeouts",
        );
      }
    };

    await runTurn({ pane, promptText: prompt, config: testConfig(clock), events: sink.events });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("summarise the failing tests"), false, "wrapped echo leaked as output");
    assert.ok(streamed.includes("three tests broke"));
  });

  it("still suppresses the echo when the prompt was sent before", async () => {
    // The same words are already in the transcript from the earlier turn, so a
    // plain substring search finds the old copy and lets the new echo through.
    const clock = new FakeClock();
    const sink = collect();
    const repeated = "run the tests";
    const earlier = composerScreen("boot", "   [03:51 PM]", `   ${repeated} ⎘`, "", "  all green");
    const pane = new FakePane(meta, earlier);
    pane.onSend = (keys) => {
      if (keys === "Enter") pane.screen = composerScreen("boot", "   [03:52 PM]", `   ${repeated} ⎘`);
    };
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", `   ${repeated} ⎘`, "", "  still green");
      }
    };

    await runTurn({ pane, promptText: repeated, config: testConfig(clock), events: sink.events });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes(repeated), false, "repeat echo leaked as output");
    assert.ok(streamed.includes("still green"));
  });
});

describe("resumeChat", () => {
  /** The settled screen of a pane whose footer names `title` as the open chat. */
  const withFooter = (title: string): string =>
    [
      "  freebuff",
      "",
      "╭──────────────────────────────╮",
      "│  ▍Enter a coding task        │",
      "╰──────────────────────────────╯",
      ` DeepSeek V4.1 Flash Slow · /tmp · Chat: ${title}`,
      " ← for history · ? for help",
    ].join("\n");

  /** A pane showing one chat, scripted so `/history` opens the picker. */
  function scriptedPane(footerTitle: string, rows: string[]): { pane: FakePane; clock: FakeClock; sent: string[] } {
    const clock = new FakeClock();
    const pane = new FakePane(meta, withFooter(footerTitle));
    let picker = false;
    pane.onSend = (keys) => {
      if (keys === "/history") {
        picker = true;
        return;
      }
      if (keys !== "Enter") return;
      if (picker) {
        picker = false;
        pane.screen = [
          "                            Select a chat to resume",
          "  ▍Search chats...",
          "  ╭─────────────────────────────────────────────────────╮",
          ...rows.map((row) => `  │ ${row} │`),
          "  ╰─────────────────────────────────────────────────────╯",
          "  ↑↓ navigate · → / Enter open chat · Esc cancel",
        ].join("\n");
        return;
      }
      if (pane.screen.includes("Select a chat")) {
        const title = rows[0].split("msgs")[1].trim();
        pane.screen = withFooter(title);
      }
    };
    return { pane, clock, sent: [] };
  }

  it("does not accept a footer title that only starts the same way", async () => {
    // `--continue` opened a different chat whose name shares a prefix: taking
    // that as a match would replay the wrong conversation.
    const { pane, clock } = scriptedPane("Fix tests on macOS", ["just now   3 msgs   Fix tests"]);
    const result = await resumeChat({
      pane,
      config: testConfig(clock),
      title: "Fix tests",
    });

    const keys = pane.sent.map((entry) => entry.keys);
    assert.deepEqual(keys.slice(0, 2), ["/history", "Enter"], "the picker was never opened");
    assert.equal(result.restored, true);
    assert.equal(result.title, "Fix tests");
  });
});

describe("readiness", () => {
  it("fails a turn instead of typing into a pane that never showed its prompt", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "installing...");
    const sink = collect();

    await assert.rejects(
      () => runTurn({ pane, promptText: "hello", config: testConfig(clock, { startupTimeoutMs: 1_000 }), events: sink.events }),
      /never showed its input prompt/,
    );
    assert.deepEqual(pane.sent, [], "keys were sent into an unusable pane");
  });

  it("does not type the prompt when the turn is cancelled during the wait", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let cancelled = false;
    const originalCapture = pane.capture.bind(pane);
    pane.capture = async () => {
      cancelled = true;
      return originalCapture();
    };

    const result = await runTurn({
      pane,
      promptText: "hello",
      config: testConfig(clock),
      events: { ...sink.events, isCancelled: () => cancelled },
    });

    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(pane.sent, [], "the prompt was typed after the turn was cancelled");
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
