import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPermissionPrompt,
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

  it("streams the answer that arrives in the same capture as a late echo", async () => {
    // The echo and the first answer rows land between two polls. Rebasing on
    // that capture without streaming what came after the echo lost the answer
    // and left the turn waiting on a screen that never changed again.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    clock.onAdvance = (time) => {
      if (time >= 900) {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM]",
          "   remember the word PLUM ⎘",
          "",
          "  PLUM",
        );
      }
    };

    await runTurn({
      pane,
      promptText: "remember the word PLUM",
      config: testConfig(clock, { echoTimeoutMs: 500 }),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("remember the word PLUM"), false, "late echo leaked into output");
    assert.ok(streamed.includes("PLUM"), "the answer drawn with the echo was dropped");
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
    // while the agent is still thinking; only the status line knows. The answer
    // starts before the pause on purpose: without a streamed chunk the echo
    // suppression alone keeps quiescence from ending the turn, and the test
    // would pass even with the status-line guard removed.
    const working = (status: string, answer: string[]) =>
      [
        "   my prompt",
        "",
        ...answer,
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
      if (keys === "Enter") pane.screen = working(" thinking...   ■ Esc", ["  the first part"]);
    };
    clock.onAdvance = (time) => {
      if (time >= 2_000) {
        pane.screen = working(" 24.8K (19%)   ✕ End session", ["  the first part", "  the rest"]);
      }
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
    assert.ok(sink.chunks.join("\n").includes("the rest"), "the paused answer was dropped");
    // The status line and input box are chrome: they must never be streamed.
    assert.equal(sink.chunks.join("\n").includes("■ Esc"), false);
    assert.equal(sink.chunks.join("\n").includes("Add a task"), false);
  });

  it("notices a permission modal drawn as a box in the bottom chrome", async () => {
    // The transcript cut removes bordered boxes above the composer, so scanning
    // the transcript alone never saw a boxed modal.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const modal = [
      "boot",
      "> run it",
      "╭──────────────────────────────────────────────╮",
      "│  Do you want to allow this command?  [y/n]   │",
      "╰──────────────────────────────────────────────╯",
      " 24.8K (19%)                     ✕ End session",
      "╭──────────────────────────────────────────────╮",
      "│  ▍Enter a coding task                        │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    pane.onSend = (keys) => {
      if (keys === "Enter") pane.screen = composerScreen("boot", "> run it");
    };
    clock.onAdvance = (time) => {
      if (time >= 600) pane.screen = modal;
    };

    await runTurn({ pane, promptText: "run it", config: testConfig(clock), events: sink.events });

    assert.equal(sink.notices.length, 1, "the boxed modal was not noticed");
    assert.match(sink.notices[0].title, /not bridged/);
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

  it("suppresses every line of a multi-line prompt echo", async () => {
    // The needle was the first line only, so the rest of a multi-line prompt was
    // delivered as assistant text once the echo was found.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM] ⎘",
          "   Review this:",
          "   const value = 1;",
        );
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM] ⎘",
          "   Review this:",
          "   const value = 1;",
          "",
          "  the value is one",
        );
      }
    };

    await runTurn({
      pane,
      promptText: "Review this:\nconst value = 1;",
      config: testConfig(clock),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("Review this:"), false, "echo leaked as output");
    assert.equal(streamed.includes("const value = 1;"), false, "second prompt line leaked");
    assert.ok(streamed.includes("the value is one"));
  });

  it("keeps the answer drawn below the last line of a multi-line echo", async () => {
    // The echo and the answer arrive in one capture, so the boundary has to be
    // the end of the whole prompt rather than the end of its first line.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM] ⎘",
          "   explain the count",
          "   and the exit code",
          "",
          "  the count is one",
          "  the exit code is zero",
        );
      }
    };

    await runTurn({
      pane,
      promptText: "explain the count\nand the exit code",
      config: testConfig(clock),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("explain the count"), false, "echo leaked as output");
    assert.equal(streamed.includes("and the exit code"), false, "second prompt line leaked");
    assert.ok(streamed.includes("the count is one"), "first answer row was dropped");
    assert.ok(streamed.includes("the exit code is zero"), "answer row was dropped");
  });

  it("suppresses the echo of a prompt whose first line is blank", async () => {
    // The needle used to be the first line, which is empty here: nothing was
    // suppressed and the user's message came back as assistant output.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   quote the word KIWI ⎘");
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   quote the word KIWI ⎘", "", "  KIWI");
      }
    };

    await runTurn({
      pane,
      promptText: "\nquote the word KIWI",
      config: testConfig(clock),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("quote the word KIWI"), false, "blank-first-line echo leaked");
    assert.ok(streamed.includes("KIWI"));
  });

  it("still suppresses the echo when an older copy of the prompt scrolls off", async () => {
    // A count over the whole transcript stayed equal here: one copy of the
    // prompt left the top of the screen as the new copy was drawn.
    const clock = new FakeClock();
    const sink = collect();
    const repeated = "run the tests";
    const earlier = composerScreen(
      "boot",
      "   [03:51 PM]",
      `   ${repeated} ⎘`,
      "",
      "  all green",
      "",
      "  some other old output",
    );
    const pane = new FakePane(meta, earlier);
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        // The old copy scrolled off the top in the same capture that draws the
        // new one, so exactly one copy is on screen before and after.
        pane.screen = composerScreen("  all green", "", "   [03:52 PM]", `   ${repeated} ⎘`);
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen(
          "  all green",
          "",
          "   [03:52 PM]",
          `   ${repeated} ⎘`,
          "",
          "  still green",
        );
      }
    };

    await runTurn({ pane, promptText: repeated, config: testConfig(clock), events: sink.events });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes(repeated), false, "the new echo leaked while the old copy scrolled off");
    assert.ok(streamed.includes("still green"));
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

describe("readiness", () => {
  it("is ready at a composer that keeps repainting its chrome", async () => {
    // The footer, the ad box and the status line change constantly. Comparing
    // the raw capture meant the count never reached its threshold and every turn
    // failed with NOT_READY.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let counter = 0;
    clock.onAdvance = () => {
      counter += 1;
      pane.screen = composerScreen("boot").replace("Enter a coding task", `thinking ${counter}s`);
    };

    const result = await runTurn({ pane, promptText: "hello", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(pane.sent.map((entry) => entry.keys), ["hello", "Enter"]);
  });

  it("needs three settled captures, not four, to accept the prompt", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();

    await runTurn({
      pane,
      promptText: "hello",
      config: testConfig(clock, { pollIntervalMs: 100, startupTimeoutMs: 300 }),
      events: sink.events,
    });

    assert.ok(
      pane.sent.some((entry) => entry.keys === "hello"),
      "the prompt was never typed within three captures",
    );
  });

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
