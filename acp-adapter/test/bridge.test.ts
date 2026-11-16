import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SUBMIT_ATTEMPTS,
  findPermissionPrompt,
  resumeChat,
  runTurn,
  type BridgeConfig,
  type TurnNotice,
} from "../src/bridge.ts";
import {
  acceptsSubmit,
  composerScreen,
  draftScreen,
  FakeClock,
  FakePane,
  READY_SCREEN,
  wrappedDraftScreen,
} from "./fake.ts";

const meta = { sessionId: "s1", cwd: "/tmp/project" };

function testConfig(clock: FakeClock, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    pollIntervalMs: 100,
    quiescenceMs: 300,
    echoTimeoutMs: 500,
    maxTurnMs: 10_000,
    startupTimeoutMs: 1_000,
    submitDelayMs: 150,
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

  it("waits out the paste window before submitting", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const sentAt: number[] = [];
    pane.onSend = (keys) => {
      sentAt.push(clock.time);
      if (keys === "Enter") {
        pane.screen = "boot\n> go";
      }
    };

    await runTurn({ pane, promptText: "go", config: testConfig(clock), events: sink.events });

    assert.equal(sentAt.length, 2, "the prompt is submitted exactly once when the TUI accepts it");
    assert.ok(
      sentAt[1] - sentAt[0] >= 150,
      `Enter must not arrive in the same burst as the text (gap ${sentAt[1] - sentAt[0]}ms)`,
    );
  });

  it("does not submit and clears the draft when cancelled during the paste window", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    let cancelled = false;
    let enters = 0;
    // Two code units for one character: counting UTF-16 units would clear one
    // character too many and delete text typed before this turn.
    const promptText = "go 😀";
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    pane.onSend = (keys) => {
      if (keys === "Enter") enters += 1;
      // The cancel arrives once the prompt is typed but while the bridge is
      // still waiting out the paste window, which is the window this guards.
      if (keys === promptText) cancelled = true;
    };

    const result = await runTurn({ pane, promptText, config: testConfig(clock), events });

    assert.equal(result.stopReason, "cancelled");
    assert.equal(enters, 0, "a cancelled turn must not start a prompt");
    // One send for the whole draft: a call per character costs a process spawn
    // each, so a long pasted prompt would block the cancel path for seconds.
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "the draft must be cleared in one send");
    assert.equal(
      clears[0].options?.repeat,
      Array.from(promptText).length,
      "the draft must be deleted one backspace per character, counted in code points",
    );
  });

  it("presses Enter again when the TUI drops the first submit", async () => {
    // A submit can be swallowed (the paste window, or a pane still settling),
    // and nothing downstream notices: the prompt just sits in the composer and
    // the turn never starts.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    pane.onSend = (keys) => {
      if (keys !== "Enter") return;
      enters += 1;
      if (enters === 1) return; // swallowed: the composer keeps the prompt
      pane.screen = composerScreen("thinking... ■ Esc");
    };
    clock.onAdvance = (time) => {
      if (time >= 600) pane.screen = composerScreen("thinking... ■ Esc", "doing it");
    };

    const result = await runTurn({ pane, promptText: "do it", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 2, "a dropped submit must be retried");
    assert.equal(sink.chunks.join("\n").includes("do it"), false, "the echoed prompt must not be streamed");
  });

  it("does not count a repaint as a submit while the prompt is still in the composer", async () => {
    // The typed prompt can still be rendering when the next capture lands. That
    // repaint used to read as "accepted", so a turn that never started was
    // reported as one, and the prompt stayed in the composer.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = draftScreen(keys, "← for history · ? for help");
        return;
      }
      if (keys !== "Enter") return;
      enters += 1;
      if (enters === 1) {
        // A repaint around the still-typed prompt: not a submit.
        pane.screen = draftScreen("do it", "← for history · ? for help.");
        return;
      }
      pane.screen = composerScreen("thinking... ■ Esc");
    };

    const result = await runTurn({ pane, promptText: "do it", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 2, "a repaint that keeps the draft must be submitted again");
  });

  it("waits for the draft to be drawn before it can count as submitted", async () => {
    // A pane that has not drawn the draft yet has an empty composer, so "the
    // prompt left the composer" is true from the first capture. One repainting
    // footer then passed for a submit that never happened: no retry, no clear,
    // and the draft appeared afterwards and sat there for the next turn.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    let typed = false;
    let accepted = false;
    pane.drawsTyping = false;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        typed = true; // sent, but not drawn in the composer yet
        return;
      }
      if (keys !== "Enter") return;
      enters += 1;
      if (enters === 1) return; // swallowed
      accepted = true;
      pane.screen = composerScreen("thinking... ■ Esc", "doing it");
    };
    // Chrome churns on every poll while the draft is still to come, which is
    // what made the old screen-differs check read as an accepted submit.
    let paints = 0;
    pane.onCapture = () => {
      if (!typed || accepted) return;
      paints += 1;
      const footer = `thinking ${paints}s · ? for help`;
      // The draft is still on its way for the first captures, so the composer
      // reads as empty while the footer repaints: that is what the old
      // screen-differs check took for an accepted submit.
      const base = paints >= 3 ? draftScreen("do it") : composerScreen("boot");
      pane.screen = base.replace("← for history · ? for help", footer);
    };

    const result = await runTurn({
      pane,
      promptText: "do it",
      config: testConfig(clock, { echoTimeoutMs: 2_000 }),
      events: sink.events,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 2, "a repaint must not pass for a submit, and the swallowed press is retried");
    assert.equal(
      pane.sent.filter((entry) => entry.keys === "BSpace").length,
      0,
      "a draft that was submitted must not be cleared",
    );
  });

  it("fails the turn when the composer never draws the draft", async () => {
    // Nothing was typed into the composer, so no submit can be read from it:
    // pressing Enter into an empty composer would start nothing, and reporting
    // `end_turn` would be the silent bug this change removes.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    pane.drawsTyping = false;
    pane.onSend = () => {};

    await assert.rejects(
      runTurn({ pane, promptText: "do it", config: testConfig(clock), events: sink.events }),
      /was not typed/,
    );
    assert.equal(
      pane.sent.filter((entry) => entry.keys === "Enter").length,
      0,
      "no Enter is pressed into a composer that never held the prompt",
    );
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "the typing is undone in one send");
    assert.equal(clears[0].options?.repeat, Array.from("do it").length);
  });

  it("accepts a submit that lands between the last poll and the final capture", async () => {
    // One capture decides both the submit and the clear, so a press that lands
    // after the last poll is reported as a turn: failing it would fail a turn
    // that is running, and a caller that resubmits would start a duplicate.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = draftScreen(keys);
        return;
      }
      if (keys !== "Enter") return;
      enters += 1; // every press is swallowed while the loop is running
    };
    // The deadline is 150ms of submit delay plus 500ms of budget.
    pane.onCapture = () => {
      if (enters > 0 && clock.now() >= 650) {
        pane.screen = composerScreen("thinking... ■ Esc", "doing it");
      }
    };

    const result = await runTurn({ pane, promptText: "do it", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(
      pane.sent.filter((entry) => entry.keys === "BSpace").length,
      0,
      "a submit that landed must not have its turn cleared and failed",
    );
  });

  it("sends no Enter when the cancel lands during a retry capture", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    let cancelled = false;
    let enters = 0;
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    acceptsSubmit(pane);
    pane.onSend = (keys) => {
      if (keys === "Enter") enters += 1; // swallowed, so a retry is due
    };
    // The cancel arrives while the retry's capture is in flight, at a poll where
    // that very capture would otherwise be followed by the retry press.
    pane.onCapture = () => {
      if (enters >= 1) cancelled = true;
    };

    const result = await runTurn({
      pane,
      promptText: "go",
      config: testConfig(clock, { pollIntervalMs: 100, echoTimeoutMs: 300 }),
      events,
    });

    assert.equal(result.stopReason, "cancelled");
    assert.equal(enters, 1, "a retry must not press Enter after a cancel");
  });

  it("fails the turn when the pane never accepts the submit", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    // Astral character: the cleanup must count characters, not UTF-16 units.
    const promptText = "do 😀";
    pane.onSend = (keys, options) => {
      if (!options?.literal && keys === "Enter") {
        enters += 1; // every press is swallowed
        return;
      }
      pane.screen = draftScreen(keys);
    };

    // A prompt left in the composer is a failed submission, never a turn that
    // ran: reporting `end_turn` here is what makes the bug so hard to see.
    await assert.rejects(
      runTurn({ pane, promptText, config: testConfig(clock), events: sink.events }),
      /was not submitted/,
    );
    assert.equal(enters, MAX_SUBMIT_ATTEMPTS, "retries stay bounded");
    assert.deepEqual(sink.chunks, []);
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "the draft is cleared in one send");
    assert.equal(
      clears[0].options?.repeat,
      Array.from(promptText).length,
      "a failed turn must not leave its draft for the next one to submit",
    );
  });

  it("clears a failed turn's draft while the pane repaints its footer", async () => {
    // The guard on the clear used to be whole-screen equality, but a submit is
    // accepted on the composer being emptied. A footer that repaints on every
    // poll differs from the typed screen while the prompt is still sitting in
    // the composer, so the clear was skipped and the next prompt was typed onto
    // the leftover draft and submitted with it.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const promptText = "do it";
    pane.onSend = (keys, options) => {
      if (!options?.literal && keys === "Enter") return; // every press is swallowed
      pane.screen = draftScreen(keys);
    };
    // Chrome only: the footer is not part of the composer, so it can churn while
    // the prompt sits there untouched. It grows monotonically so no capture can
    // land back on the typed screen and read as an unchanged one.
    let paints = 0;
    pane.onCapture = () => {
      paints += 1;
      const rows = pane.screen.split("\n");
      rows[rows.length - 1] = ` ← for history · ? for help${".".repeat(paints)}`;
      pane.screen = rows.join("\n");
    };

    await assert.rejects(
      runTurn({ pane, promptText, config: testConfig(clock), events: sink.events }),
      /was not submitted/,
    );
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "a repainting footer must not skip the clear");
    assert.equal(clears[0].options?.repeat, Array.from(promptText).length);
  });

  it("retries a swallowed submit for a prompt that wraps in the composer", async () => {
    // The composer text used to be the whole bottom chrome block, border columns
    // and footer included, so a needle spanning two rows could never match: a
    // draft too long for one row read as already submitted, the retry it needed
    // never fired, and the turn it never started was reported as `end_turn`.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const promptText = "summarise the failing test and name the fix";
    pane.onSend = (keys, options) => {
      if (!options?.literal && keys === "Enter") return; // every press is swallowed
      pane.screen = wrappedDraftScreen(keys);
    };

    await assert.rejects(
      runTurn({ pane, promptText, config: testConfig(clock), events: sink.events }),
      /was not submitted/,
    );
    assert.equal(
      pane.sent.filter((entry) => entry.keys === "Enter").length,
      MAX_SUBMIT_ATTEMPTS,
      "a wrapped draft must be retried like any other",
    );
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "a wrapped draft must still be cleared");
    assert.equal(clears[0].options?.repeat, Array.from(promptText).length);
  });

  it("accepts a submit when the footer repeats the prompt's text", async () => {
    // The footer below the composer says "? for help", so a prompt of "help" used
    // to be found there after the TUI took it: the submit was retried, the draft
    // was cleared twice over, and a turn that was running was failed.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = draftScreen(keys); // the footer below it repeats the prompt
        return;
      }
      if (keys !== "Enter") return;
      enters += 1;
      pane.screen = composerScreen("help", "thinking... ■ Esc");
    };

    const result = await runTurn({ pane, promptText: "help", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 1, "an accepted submit must not be pressed again");
    assert.deepEqual(
      pane.sent.filter((entry) => entry.keys === "BSpace"),
      [],
      "an accepted submit must not be cleared",
    );
  });

  it("does not fail a turn whose Enter lands after the last poll", async () => {
    // Presses are spaced across the budget, so the last one can land just before
    // the deadline and be accepted just after it. The loop exits on the deadline
    // with the draft still drawn, and failing the turn there reports a failure for
    // work that has started.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const config = testConfig(clock);
    let firstPress = -1;
    let latePolls = 0;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = draftScreen(keys);
        return;
      }
      if (keys !== "Enter") return;
      if (firstPress < 0) firstPress = clock.time;
    };
    // The submit budget runs from the first press, and the loop's last poll lands
    // on its end, where the draft is still drawn. The TUI finishes the press only
    // after that, so the first capture that can see it is the one taken after the
    // loop: the deadline-based failure never took it and reported a running turn
    // as a failed one.
    pane.onCapture = () => {
      if (firstPress < 0) return;
      if (clock.time < firstPress + config.echoTimeoutMs) return;
      latePolls += 1;
      if (latePolls === 2) pane.screen = composerScreen("go", "thinking... ■ Esc");
    };

    const result = await runTurn({ pane, promptText: "go", config, events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(
      pane.sent.filter((entry) => entry.keys === "BSpace"),
      [],
      "a turn that started late must not be cleared or failed",
    );
  });

  it("clears the draft when cancelled while the submit is unconfirmed", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    let cancelled = false;
    const promptText = "do 😀";
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = draftScreen(keys); // the draft is in the composer
      }
      // Enter is swallowed, so the composer still holds the draft when the
      // cancel arrives during the retry loop.
    };
    // The footer keeps repainting, so the screen never matches the typed one and
    // only the composer can say whether the draft is still there.
    let paints = 0;
    pane.onCapture = () => {
      paints += 1;
      const rows = pane.screen.split("\n");
      rows[rows.length - 1] = ` ← for history · ? for help${".".repeat(paints)}`;
      pane.screen = rows.join("\n");
    };
    // Late enough to land after Enter, inside the retry loop: a cancel during
    // the submit delay exits before the loop and would not test this path.
    clock.onAdvance = (time) => {
      if (time >= 400) cancelled = true;
    };

    const result = await runTurn({ pane, promptText, config: testConfig(clock), events });

    assert.equal(result.stopReason, "cancelled");
    assert.ok(
      pane.sent.some((entry) => entry.keys === "Enter"),
      "the cancel must land inside the retry loop",
    );
    const clears = pane.sent.filter((entry) => entry.keys === "BSpace");
    assert.equal(clears.length, 1, "the draft is cleared in one send");
    assert.equal(
      clears[0].options?.repeat,
      Array.from(promptText).length,
      "a cancelled turn must not leave its draft for the next one to submit",
    );
  });

  it("does not clear text it did not type once the turn is writing", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    let cancelled = false;
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        // The submit landed and the turn is writing; cancel arrives now, when
        // the prompt is long gone from the composer, so backspaces would delete
        // the turn's own output.
        pane.screen = composerScreen("working");
        cancelled = true;
      }
    };

    const result = await runTurn({ pane, promptText: "go", config: testConfig(clock), events });

    assert.equal(result.stopReason, "cancelled");
    assert.equal(
      pane.sent.filter((entry) => entry.keys === "BSpace").length,
      0,
      "a submitted prompt is no longer in the composer to clear",
    );
  });

  it("never presses Enter at the submit deadline", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    const enterTimes: number[] = [];
    pane.onSend = (keys) => {
      if (keys === "Enter") enterTimes.push(clock.time);
    };

    // A poll this coarse lands a sleep exactly on the deadline, so a press there
    // would never be observed before the turn gives up.
    await assert.rejects(
      runTurn({
        pane,
        promptText: "go",
        config: testConfig(clock, { pollIntervalMs: 1_000, echoTimeoutMs: 2_000, startupTimeoutMs: 5_000 }),
        events: sink.events,
      }),
      /was not submitted/,
    );

    assert.ok(enterTimes.length > 0, "the submit is at least attempted");
    // The budget starts at the first press, and a press at its end could never be
    // observed before the turn gives up on it.
    const deadline = enterTimes[0] + 2_000;
    assert.ok(
      enterTimes.every((time) => time < deadline),
      `a press at or after the deadline is unobservable: ${JSON.stringify(enterTimes)}`,
    );
  });

  it("waits the whole submit budget for an Enter that lands late", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    let enters = 0;
    let reacted = false;
    pane.onSend = (keys) => {
      if (keys === "Enter") enters += 1; // swallowed until the late reaction below
    };
    clock.onAdvance = (time) => {
      if (time >= 450 && !reacted) {
        reacted = true;
        pane.screen = composerScreen("working");
      }
    };

    const result = await runTurn({ pane, promptText: "go", config: testConfig(clock), events: sink.events });

    // At the poll interval the presses would be spent by ~350ms and the turn
    // would fail while this pane was still about to accept the first one.
    // One press is enough: the pane reacts at 450ms, inside the retry interval,
    // so the turn must be waiting on it rather than pressing again or failing.
    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 1, "a pane that reacts inside the interval needs one press");
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
    acceptsSubmit(pane);
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
    acceptsSubmit(pane);
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

  it("does not stream a half-drawn echo when the window closes mid-prompt", async () => {
    // A multi-line prompt is echoed one row at a time. When the echo window runs
    // out after the first row, that row looked like ordinary new output and was
    // streamed; a streamed chunk cannot be retracted once the echo completes.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   remember the word PLUM");
      }
      if (time >= 1_500) {
        pane.screen = composerScreen(
          "boot",
          "   [03:52 PM]",
          "   remember the word PLUM",
          "   and keep it",
          "",
          "  PLUM",
        );
      }
    };

    acceptsSubmit(pane);
    await runTurn({
      pane,
      promptText: "remember the word PLUM\nand keep it",
      config: testConfig(clock, { echoTimeoutMs: 500 }),
      events: sink.events,
    });

    const streamed = sink.chunks.join("\n");
    assert.equal(streamed.includes("remember the word PLUM"), false, "half-drawn echo leaked into output");
    assert.equal(streamed.includes("and keep it"), false, "echo tail leaked into output");
    assert.equal(streamed.includes("PLUM"), true, "the answer that followed the echo was dropped");
  });

  it("still suppresses an echo whose tail never arrives", async () => {
    // Buffering a partial echo must not turn into streaming it once the turn is
    // over: waiting is the only way to keep the drawn rows out of the transcript.
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    const sink = collect();
    clock.onAdvance = (time) => {
      if (time >= 600) {
        pane.screen = composerScreen("boot", "   [03:52 PM]", "   remember the word PLUM");
      }
    };

    acceptsSubmit(pane);
    const result = await runTurn({
      pane,
      promptText: "remember the word PLUM\nand keep it",
      config: testConfig(clock, { echoTimeoutMs: 500, maxTurnMs: 2_000 }),
      events: sink.events,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(sink.chunks.join("\n").includes("remember the word PLUM"), false, "partial echo leaked");
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
    acceptsSubmit(pane);
    // Only until the prompt is typed: rewriting the screen on every later sleep
    // would hide the composer reacting to Enter, which reads as a lost submit.
    clock.onAdvance = (time) => {
      if (time >= 400 && screenAtFirstSend === null) pane.screen = READY_SCREEN;
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

    acceptsSubmit(pane);
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

    acceptsSubmit(pane);
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

    acceptsSubmit(pane);
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

    acceptsSubmit(pane);
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

  /** Serves the picker, tracking arrow-key navigation to the opened row. */
  function pickerPane(footerTitle: string, rows: string[]): { pane: FakePane; opened: () => string } {
    const pane = new FakePane(meta, withFooter(footerTitle));
    let picker = false;
    let selected = 0;
    pane.onSend = (keys) => {
      if (keys === "/history") {
        picker = true;
        return;
      }
      if (keys === "Down") {
        selected += 1;
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
        pane.screen = withFooter(rows[selected].split("msgs")[1].trim());
      }
    };
    return { pane, opened: () => rows[selected].split("msgs")[1].trim() };
  }

  it("prefers the exactly named row over a longer one sharing its prefix", async () => {
    const clock = new FakeClock();
    const { pane } = pickerPane("Fix tests on macOS", ["1m ago   3 msgs   Fix tests on macOS", "5m ago   3 msgs   Fix tests"]);
    const result = await resumeChat({ pane, config: testConfig(clock), title: "Fix tests" });

    assert.deepEqual(
      pane.sent.map((entry) => entry.keys),
      ["/history", "Enter", "Down", "Enter"],
      "the picker did not step past the longer row to the exact one",
    );
    assert.equal(result.restored, true);
    assert.equal(result.title, "Fix tests");
  });

  it("does not guess between two rows that both match a prefix", async () => {
    // Both could be the recorded chat, and picking one replays a conversation
    // the host never asked for, so the load has to fail instead.
    const clock = new FakeClock();
    const { pane } = pickerPane("Fix tests on macOS", ["1m ago   3 msgs   Fix tests on macOS", "5m ago   3 msgs   Fix tests on Linux"]);
    const result = await resumeChat({ pane, config: testConfig(clock), title: "Fix tests" });

    assert.equal(result.restored, false);
    assert.ok(pane.sent.some((entry) => entry.keys === "Escape"), "the picker was left open");
  });

  it("does not open a shorter chat that only starts the recorded title", async () => {
    // The recorded chat is gone, leaving one row that shares its first word: it
    // is a different conversation, and opening it replays the wrong one.
    const clock = new FakeClock();
    const { pane, opened } = pickerPane("Fix", ["just now   3 msgs   Fix"]);
    const result = await resumeChat({ pane, config: testConfig(clock), title: "Fix tests" });

    assert.deepEqual(pane.sent.map((entry) => entry.keys), ["/history", "Enter", "Escape"]);
    assert.equal(opened(), "Fix", "a row was opened despite no truncation-sized match");
    assert.equal(result.restored, false);
  });

  it("opens a row the picker truncated to its column width", async () => {
    // A long title is cut by the picker, so the row is a prefix of the recorded
    // title. That is the case the shorter-row direction exists for.
    const clock = new FakeClock();
    const { pane, opened } = pickerPane("Remember the word ORA", ["just now   3 msgs   Remember the word ORA"]);
    const result = await resumeChat({
      pane,
      config: testConfig(clock),
      title: "Remember the word ORANGE and reply with just STORED",
    });

    assert.deepEqual(pane.sent.map((entry) => entry.keys), ["/history", "Enter", "Enter"]);
    assert.equal(opened(), "Remember the word ORA");
    // The footer shows the cut title, which is not the recorded one.
    assert.equal(result.restored, false);
  });

  it("pauses before Enter after typing /history, so the picker is not dropped", async () => {
    // `/history` is typed text followed by Enter. Sent in one burst the Enter is
    // read as paste content and dropped, exactly like a prompt, so the picker
    // would never open.
    const clock = new FakeClock();
    const { pane } = pickerPane("Fix", ["just now   3 msgs   Fix"]);
    const sentAt: { keys: string; time: number }[] = [];
    const inner = pane.onSend;
    pane.onSend = (keys) => {
      sentAt.push({ keys, time: clock.time });
      inner?.(keys);
    };

    await resumeChat({ pane, config: testConfig(clock), title: "Fix tests" });

    const history = sentAt.find((entry) => entry.keys === "/history");
    const enter = sentAt.find((entry) => entry.keys === "Enter");
    assert.ok(history && enter, "the picker must be opened with /history then Enter");
    assert.ok(
      enter.time - history.time >= 150,
      `Enter must not arrive in the same burst as /history (gap ${enter.time - history.time}ms)`,
    );
  });

  it("does not open a chat when the recorded title is empty", async () => {
    // An empty title is a prefix of every row, so without the guard the first
    // chat in the picker would be opened and then rejected by the footer check.
    const clock = new FakeClock();
    const { pane } = pickerPane("Fix tests on macOS", ["just now   3 msgs   Fix tests"]);
    const result = await resumeChat({ pane, config: testConfig(clock), title: "" });

    assert.equal(result.restored, false);
    // The guard runs before /history is sent, so the picker never opens at all.
    assert.deepEqual(pane.sent, [], "the picker was opened for an empty title");
  });

  it("does not accept a footer title that only starts the same way", async () => {
    // `--continue` opened a different chat whose name shares a prefix: taking
    // that as a match would replay the wrong conversation.
    const clock = new FakeClock();
    const { pane } = pickerPane("Fix tests on macOS", ["just now   3 msgs   Fix tests"]);
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
      // Only the status line moves: the composer keeps the draft, so the turn
      // still sees its prompt waiting there while the chrome churns.
      pane.screen = pane.screen.replace(
        "← for history · ? for help",
        `thinking ${counter}s · ? for help`,
      );
    };

    acceptsSubmit(pane);
    const result = await runTurn({ pane, promptText: "hello", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(pane.sent.map((entry) => entry.keys), ["hello", "Enter"]);
  });

  it("needs three settled captures, not four, to accept the prompt", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, composerScreen("boot"));
    acceptsSubmit(pane);
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
