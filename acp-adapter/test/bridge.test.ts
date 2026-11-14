import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPermissionPrompt,
  MAX_SUBMIT_ATTEMPTS,
  runTurn,
  type BridgeConfig,
  type TurnNotice,
} from "../src/bridge.ts";
import { FakeClock, FakePane } from "./fake.ts";

const meta = { sessionId: "s1", cwd: "/tmp/project" };

function testConfig(clock: FakeClock, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    pollIntervalMs: 100,
    quiescenceMs: 300,
    echoTimeoutMs: 500,
    maxTurnMs: 10_000,
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

  it("presses Enter again when the TUI drops the first submit", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    let enters = 0;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = `boot\n> ${keys}`; // the TUI echoes the typed text at once
        return;
      }
      if (keys === "Enter") {
        enters += 1;
        if (enters === 1) return; // swallowed: the composer keeps the prompt
        pane.screen = "boot\n> do it\nthinking... ■ Esc";
      }
    };
    clock.onAdvance = (time) => {
      if (time >= 400) {
        pane.screen = "boot\n> do it\nthinking... ■ Esc\ndoing it";
      }
    };

    const result = await runTurn({ pane, promptText: "do it", config: testConfig(clock), events: sink.events });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 2, "a dropped submit must be retried");
    // The status line and the answer both appear after the prompt was typed, so
    // both are this turn's output: skipping either would be output loss.
    assert.deepEqual(sink.chunks, ["thinking... ■ Esc\ndoing it"]);
  });

  it("fails the turn when the pane never accepts the submit", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    let enters = 0;
    // Astral character: the cleanup must count characters, not UTF-16 units.
    const promptText = "do 😀";
    pane.onSend = (keys) => {
      if (keys === "Enter") {
        enters += 1; // every press is swallowed
        return;
      }
      pane.screen = `boot\n> ${keys}`;
    };

    // A prompt left in the composer is a failed submission, never a turn that
    // ran: reporting `end_turn` here is what makes the bug so hard to see.
    await assert.rejects(
      runTurn({ pane, promptText, config: testConfig(clock), events: sink.events }),
      /was not submitted/,
    );
    assert.equal(enters, MAX_SUBMIT_ATTEMPTS, "retries stay bounded");
    assert.deepEqual(sink.chunks, []);
    const backspaces = pane.sent.filter((entry) => entry.keys === "BSpace").length;
    assert.equal(
      backspaces,
      Array.from(promptText).length,
      "a failed turn must not leave its draft for the next one to submit",
    );
  });

  it("clears the draft when cancelled while the submit is unconfirmed", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    let cancelled = false;
    const promptText = "do 😀";
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = `boot\n> ${keys}`; // the draft is in the composer
      }
      // Enter is swallowed, so the composer still holds the draft when the
      // cancel arrives during the retry loop.
    };
    clock.onAdvance = (time) => {
      if (time >= 300) cancelled = true;
    };

    const result = await runTurn({ pane, promptText, config: testConfig(clock), events });

    assert.equal(result.stopReason, "cancelled");
    const backspaces = pane.sent.filter((entry) => entry.keys === "BSpace").length;
    assert.equal(
      backspaces,
      Array.from(promptText).length,
      "a cancelled turn must not leave its draft for the next one to submit",
    );
  });

  it("does not clear text it did not type once the turn is writing", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    let cancelled = false;
    const events = {
      onChunk: () => {},
      onNotice: () => {},
      isCancelled: () => cancelled,
    };
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = `boot\n> ${keys}`;
        return;
      }
      if (keys === "Enter") pane.screen = "boot\n> go\nworking";
    };
    // Cancel while the turn is streaming: the prompt is long gone from the
    // composer, so backspaces would delete the turn's own output.
    clock.onAdvance = (time) => {
      if (time >= 300) cancelled = true;
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
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    const enterTimes: number[] = [];
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = `boot\n> ${keys}`;
        return;
      }
      if (keys === "Enter") enterTimes.push(clock.time);
    };

    // A poll this coarse lands a sleep exactly on the deadline, so a press there
    // would never be observed before the turn gives up.
    await assert.rejects(
      runTurn({
        pane,
        promptText: "go",
        config: testConfig(clock, { pollIntervalMs: 1_000, echoTimeoutMs: 2_000 }),
        events: sink.events,
      }),
      /was not submitted/,
    );

    const deadline = 150 + 2_000;
    assert.ok(enterTimes.length > 0, "the submit is at least attempted");
    assert.ok(
      enterTimes.every((time) => time < deadline),
      `a press at or after the deadline is unobservable: ${JSON.stringify(enterTimes)}`,
    );
  });

  it("waits the whole submit budget for an Enter that lands late", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
    const sink = collect();
    let enters = 0;
    let reacted = false;
    pane.onSend = (keys, options) => {
      if (options?.literal) {
        pane.screen = "boot\n> go";
        return;
      }
      if (keys === "Enter") enters += 1; // swallowed until the late reaction below
    };
    clock.onAdvance = (time) => {
      if (time >= 450 && !reacted) {
        reacted = true;
        pane.screen = "boot\n> go\nworking";
      }
    };

    const result = await runTurn({ pane, promptText: "go", config: testConfig(clock), events: sink.events });

    // At the poll interval the three presses would be spent by ~350ms and the
    // turn would fail while this pane was still about to accept the first one.
    assert.equal(result.stopReason, "end_turn");
    assert.equal(enters, 2, "a late submit must be waited out, not declared failed");
  });

  it("waits out the paste window before submitting", async () => {
    const clock = new FakeClock();
    const pane = new FakePane(meta, "boot");
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
    const pane = new FakePane(meta, "boot");
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
    };
    // The cancel arrives while the bridge is still waiting out the paste window.
    clock.onAdvance = (time) => {
      if (time >= 150) cancelled = true;
    };

    const result = await runTurn({ pane, promptText, config: testConfig(clock), events });

    assert.equal(result.stopReason, "cancelled");
    assert.equal(enters, 0, "a cancelled turn must not start a prompt");
    const backspaces = pane.sent.filter((entry) => entry.keys === "BSpace").length;
    assert.equal(
      backspaces,
      Array.from(promptText).length,
      "the typed draft must be deleted, one backspace per character",
    );
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
