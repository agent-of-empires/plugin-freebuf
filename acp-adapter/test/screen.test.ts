import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ScreenTracker,
  diffScreens,
  extractTranscript,
  isPromptVisible,
  isWorkingScreen,
  normalizeScreen,
  chatTitle,
  chatHistoryRows,
  isChatHistoryScreen,
  splitTranscriptMessages,
} from "../src/screen.ts";

/**
 * A capture shaped like the real Freebuff screen: transcript on top, then the
 * bottom chrome block -- an ad box, the live status line, the input box and the
 * footer rows -- all of which repaint and must never be streamed.
 */
const REAL_SCREEN = [
  "  freebuff",
  "",
  "   [12:53 PM]",
  "   Reply with exactly: HELLO-ACP-OK ⎘",
  "",
  "  HELLO-ACP-OK",
  "                                                                  ⎘ • 6s • △▽",
  "",
  " ╭────────────────────────────────────╮",
  " │ Download Free  wisprflow.ai        │",
  " ╰────────────────────────────────────╯",
  " 24.8K (19%)                                        ✕ End session",
  "╭────────────────────────────────────────────────────────────────────────────╮",
  "│                                                                            │",
  "│  ▍Enter a coding task or / for commands                                    │",
  "│                                                                            │",
  "╰────────────────────────────────────────────────────────────────────────────╯",
  " DeepSeek V4.1 Flash Slow · /private/tmp/probe · /model to change · Chat: hello",
  " ← for history · ? for help",
].join("\n");

describe("extractTranscript", () => {
  it("keeps the conversation and cuts the bottom chrome block", () => {
    assert.deepEqual(extractTranscript(REAL_SCREEN), [
      "  freebuff",
      "",
      "   [12:53 PM]",
      "   Reply with exactly: HELLO-ACP-OK ⎘",
      "",
      "  HELLO-ACP-OK",
    ]);
  });

  it("drops the message badge the TUI repaints as its timer runs", () => {
    const screen = ["  the answer", "                      ⎘ • 6s • △▽"].join("\n");
    assert.deepEqual(extractTranscript(screen), ["  the answer"]);
  });

  it("drops a badge whose row ends in the scrollbar block glyph", () => {
    // Captured live: the badge shares its row with the scrollbar column.
    const screen = [
      "  398",
      "  400",
      `   ${" ".repeat(120)}⎘ • 15s • △▽   ▄`,
    ].join("\n");
    assert.deepEqual(extractTranscript(screen), ["  398", "  400"]);
  });

  it("drops a badge that sits mid-transcript, not only the last row", () => {
    const screen = [
      "  first answer",
      "                     ⎘ • 4s • △▽",
      "  second answer",
    ].join("\n");
    assert.deepEqual(extractTranscript(screen), ["  first answer", "  second answer"]);
  });

  it("drops the 'load previous messages' overlay floated over the transcript", () => {
    const screen = [
      "  the answer so far",
      "",
      `   ${" ".repeat(90)}╭────────────────────────────╮`,
      `   ${" ".repeat(90)}│  ↑ Load previous messages  │`,
      `   ${" ".repeat(90)}╰────────────────────────────╯`,
      "",
      "╭────────────────────────────────────────────────────────────────────────────╮",
      "│  ▍Enter a coding task or / for commands                                    │",
      "╰────────────────────────────────────────────────────────────────────────────╯",
      " DeepSeek V4.1 Flash Slow · /private/tmp/probe · Chat: hello",
    ].join("\n");
    assert.deepEqual(extractTranscript(screen), ["  the answer so far"]);
  });

  it("drops the promo card Freebuff rotates above the transcript", () => {
    // Captured from freebuff 0.2.36 after an ad rotation leaked mid-turn.
    const adBox = [
      "  ╭───────────────────────────────────────────────────────────────╮",
      "  │ Stop typing prompts. Start talking.        Ad [Report 2]      │",
      "  │ Speak through features, bugs, and instructions. wisprflow.ai ↗ │",
      "  ╰───────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const screen = [
      adBox,
      "",
      "   [02:42 PM]",
      "   Remember the word PLUM. Reply with just: STORED ⎘",
      "",
      "  STORED",
      "╭──────────────────────────────────────╮",
      "│  ▍Enter a coding task or / for commands   │",
      "╰──────────────────────────────────────╯",
      " DeepSeek V4.1 Flash Slow · /tmp · Chat: hello",
    ].join("\n");
    assert.deepEqual(extractTranscript(screen), [
      "",
      "   [02:42 PM]",
      "   Remember the word PLUM. Reply with just: STORED ⎘",
      "",
      "  STORED",
    ]);
  });

  it("drops an ad text row left behind without its box", () => {
    const screen = ["  Pitch your product here.     Ad [Report 7]", "  the answer"].join("\n");
    assert.deepEqual(extractTranscript(screen), ["  the answer"]);
  });

  it("keeps a bordered box that is content, not an overlay", () => {
    const screen = [
      "  ╭───────╮",
      "  │  ok   │",
      "  ╰───────╯",
      "  prose after the box",
      "╭──────────────────────────────────────╮",
      "│  ▍Enter a coding task or / commands   │",
      "╰──────────────────────────────────────╯",
      " DeepSeek V4.1 Flash Slow · /tmp · Chat: hello",
    ].join("\n");
    assert.deepEqual(extractTranscript(screen), [
      "  ╭───────╮",
      "  │  ok   │",
      "  ╰───────╯",
      "  prose after the box",
    ]);
  });

  it("keeps a wordless answer that is not a badge", () => {
    assert.deepEqual(extractTranscript("  the answer\n\n  42"), ["  the answer", "", "  42"]);
  });

  it("streams the whole screen when there is no input box", () => {
    assert.deepEqual(extractTranscript("line one\nline two"), ["line one", "line two"]);
  });
});

describe("screen state probes", () => {
  it("detects the input box being on screen", () => {
    assert.equal(isPromptVisible(normalizeScreen(REAL_SCREEN)), true);
    assert.equal(isPromptVisible(normalizeScreen("  freebuff loading…")), false);
  });

  it("detects a live turn status line", () => {
    assert.equal(isWorkingScreen("result\n thinking...                         ■ Esc"), true);
    assert.equal(isWorkingScreen("result\n 24.8K (19%)       ✕ End session"), false);
  });
});

describe("normalizeScreen", () => {
  it("strips ANSI escapes from the capture", () => {
    assert.deepEqual(normalizeScreen("\u001b[32mgreen\u001b[0m"), ["green"]);
  });

  it("trims trailing whitespace and carriage returns", () => {
    assert.deepEqual(normalizeScreen("padded   \r\nnext\t\n"), ["padded", "next"]);
  });

  it("drops the trailing blank rows tmux pads the pane with", () => {
    assert.deepEqual(normalizeScreen("line\n\n\n"), ["line"]);
    assert.deepEqual(normalizeScreen(""), []);
  });

  it("keeps interior blank lines", () => {
    assert.deepEqual(normalizeScreen("a\n\nb\n"), ["a", "", "b"]);
  });
});

describe("diffScreens", () => {
  it("returns nothing when the screen did not change", () => {
    const screen = ["ready", "prompt>"];
    assert.equal(diffScreens(screen, screen), "");
  });

  it("returns only lines appended since the previous capture", () => {
    assert.equal(diffScreens(["a", "b"], ["a", "b", "c", "d"]), "\nc\nd");
  });

  it("handles scrollback: the previous tail lines up with the new head", () => {
    assert.equal(diffScreens(["a", "b", "c"], ["b", "c", "d"]), "\nd");
  });

  it("emits only the suffix when a trailing line grows in place", () => {
    assert.equal(diffScreens(["a", "hel"], ["a", "hello"]), "lo");
    assert.equal(diffScreens(["a", "hello wor"], ["a", "hello world", "next"]), "ld\nnext");
  });

  it("emits the whole next screen when there is no overlap", () => {
    assert.equal(diffScreens([], ["fresh", "screen"]), "fresh\nscreen");
    assert.equal(diffScreens(["one"], ["totally", "different"]), "\ntotally\ndifferent");
  });

  it("emits only the changed line when a line is rewritten in place", () => {
    const prev = ["header", "step 3/5", "footer"];
    const next = ["header", "step 4/5", "footer"];
    assert.equal(diffScreens(prev, next), "\nstep 4/5");
  });

  it("does not re-emit the screen when a middle line changes among many", () => {
    const prev = ["a", "b", "c", "d", "e", "f"];
    const next = ["a", "b", "c", "CHANGED", "e", "f"];
    assert.equal(diffScreens(prev, next), "\nCHANGED");
  });

  it("emits nothing when rows disappear without new output", () => {
    assert.equal(diffScreens(["a", "modal", "b"], ["a", "b"]), "");
    assert.equal(diffScreens(["a", "b", "c"], ["a", "b"]), "");
  });

  it("emits an appended line after an in-place rewrite as one block", () => {
    const prev = ["a", "b"];
    const next = ["a", "b2", "c"];
    // "b" -> "b2" grows in place (suffix), then "c" is a new line.
    assert.equal(diffScreens(prev, next), "2\nc");
  });

  it("ignores recoloring: same text, different escapes", () => {
    const prev = normalizeScreen("\u001b[32mok\u001b[0m  \nnext");
    const next = normalizeScreen("\u001b[1;32mok\u001b[0m  \nnext");
    assert.equal(diffScreens(prev, next), "");
  });

  it("does not re-emit unchanged leading lines after a scroll", () => {
    const prev = normalizeScreen("row1\nrow2\nrow3\nrow4\n");
    const next = normalizeScreen("row2\nrow3\nrow4\nrow5\n");
    assert.equal(diffScreens(prev, next), "\nrow5");
  });
});

describe("ScreenTracker", () => {
  it("emits each new bit of output exactly once across captures", () => {
    const tracker = new ScreenTracker("boot\n");
    assert.equal(tracker.update("boot\n"), "");
    assert.equal(tracker.update("boot\nthinking\n"), "\nthinking");
    assert.equal(tracker.update("boot\nthinking\ndone\n"), "\ndone");
    assert.equal(tracker.update("boot\nthinking\ndone\n"), "");
  });

  it("reset drops everything already on screen", () => {
    const tracker = new ScreenTracker("boot");
    tracker.reset("boot\n> my prompt");
    assert.equal(tracker.update("boot\n> my prompt"), "");
    assert.equal(tracker.update("boot\n> my prompt\nanswer"), "\nanswer");
  });
});

describe("chat identity and resume helpers", () => {
  it("reads the chat title out of the footer", () => {
    assert.equal(
      chatTitle("  STORED\n DeepSeek V4.1 Flash Slow · /tmp/x · Chat: Remember the word ORANGE"),
      "Remember the word ORANGE",
    );
  });

  it("reports no title while the footer has none", () => {
    assert.equal(chatTitle("  STORED\n ▍Enter a coding task"), null);
  });

  it("lists the /history picker rows in order", () => {
    const picker = [
      "                            Select a chat to resume",
      "  ▍Search chats...",
      "  ┌──────────────────────────────────────────────────────────────┐",
      "  │ 1m ago    3 msgs   Something else entirely                   │",
      "  │ 5m ago    3 msgs   Remember the word BANANA. Reply with just │",
      "  └──────────────────────────────────────────────────────────────┘",
    ].join("\n");
    assert.equal(isChatHistoryScreen(picker), true);
    assert.deepEqual(chatHistoryRows(picker), ["Something else entirely", "Remember the word BANANA. Reply with just"]);
    assert.equal(isChatHistoryScreen("  ▍Enter a coding task"), false);
  });

  it("reads rows from the picker as the real TUI draws them", () => {
    // Captured from freebuff 0.2.36: each row ends with a [×] control and the
    // scrollbar column sits against the border.
    const picker = [
      "                                                                                         Select a chat to resume",
      "   ▍Search chats...",
      "  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐",
      "  │ 2m ago         3 msgs     Remember the word ORANGE. Reply with just: STORED                                                [×]  █│",
      "  │ 6m ago         4 msgs     Something else entirely                                                                          [×]  █│",
      "  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
    ].join("\n");
    assert.equal(isChatHistoryScreen(picker), true);
    assert.deepEqual(chatHistoryRows(picker), [
      "Remember the word ORANGE. Reply with just: STORED",
      "Something else entirely",
    ]);
  });

  it("splits a restored transcript into user and agent messages", () => {
    const lines = [
      " ██████ freebuff banner",
      "   [02:42 PM]",
      "   Remember the word ORANGE. Reply with just: STORED ⎘",
      "",
      "  STORED",
    ];
    assert.deepEqual(splitTranscriptMessages(lines), [
      { role: "user", text: "Remember the word ORANGE. Reply with just: STORED" },
      { role: "agent", text: "STORED" },
    ]);
  });

  it("keeps a user message that wrapped onto several rows in one message", () => {
    // The badge only marks the last row, so a per-row split would hand the
    // earlier rows to the agent and put the user's prompt in the wrong place.
    const lines = [
      "   [02:42 PM]",
      "   first line of a long prompt",
      "   second line of the same prompt ⎘",
      "",
      "  the answer",
    ];
    assert.deepEqual(splitTranscriptMessages(lines), [
      { role: "user", text: "first line of a long prompt\nsecond line of the same prompt" },
      { role: "agent", text: "the answer" },
    ]);
  });

  it("ignores a Chat: mention in the transcript when reading the title", () => {
    // The footer is the only place the title lives; a message that says `Chat:`
    // would otherwise be recorded as the name of the conversation.
    const screen = [
      "   [02:42 PM]",
      "   how do I rename the Chat: title? ⎘",
      "",
      "  You can edit it.",
      " DeepSeek V4.1 Flash Slow · /tmp/project · Chat: Rename a chat",
    ].join("\n");
    assert.equal(chatTitle(screen), "Rename a chat");
  });

  it("lists the picker row of a chat created a moment ago", () => {
    // `just now` instead of `2m ago`: this is the off-by-one case, where the
    // newest row used to be dropped and every offset below it pointed at the
    // wrong chat.
    const picker = [
      "                              Select a chat to resume",
      "   ▍Search chats...",
      "  ┌─────────────────────────────────────────────────────────────────┐",
      "  │ just now       3 msgs     remember the word BANANA          [×]  █│",
      "  │ 5m ago         3 msgs     remember the word PLUM            [×]  █│",
      "  └─────────────────────────────────────────────────────────────────┘",
    ].join("\n");
    assert.equal(isChatHistoryScreen(picker), true);
    assert.deepEqual(chatHistoryRows(picker), ["remember the word BANANA", "remember the word PLUM"]);
  });

  it("does not mistake a quoted picker phrase for an open picker", () => {
    // An agent can mention the picker in a message. Treating that as a modal
    // would blank out the whole transcript until the phrase scrolled away.
    const screen = [
      "   [02:42 PM]",
      "   where does `Select a chat to resume` come from? ⎘",
      "",
      "  It is the /history picker's header.",
    ].join("\n");
    assert.equal(isChatHistoryScreen(screen), false);
    assert.ok(extractTranscript(screen).join("\n").includes("/history picker"));
  });

  it("keeps a blank paragraph inside a restored user message", () => {
    // The badge sits on the message's last row, below the blank paragraph, so
    // the blank row is part of the message rather than the gap before a reply.
    const lines = [
      "   [02:42 PM]",
      "   first paragraph",
      "",
      "   second paragraph ⎘",
      "",
      "  the answer",
    ];
    assert.deepEqual(splitTranscriptMessages(lines), [
      { role: "user", text: "first paragraph\n\nsecond paragraph" },
      { role: "agent", text: "the answer" },
    ]);
  });

  it("keeps a boxed answer that is not the input box", () => {
    // Only a box holding the prompt glyph is chrome. Cutting at any box would
    // drop the transcript down to a boxed result drawn by the agent.
    const screen = [
      "   [02:42 PM]",
      "   sum the column ⎘",
      "",
      "  ╭───────────────╮",
      "  │ total: 42     │",
      "  ╰───────────────╯",
    ].join("\n");
    const transcript = extractTranscript(screen).join("\n");
    assert.ok(transcript.includes("total: 42"), `lost the boxed answer: ${JSON.stringify(transcript)}`);
    assert.ok(transcript.includes("sum the column"));
  });

  it("treats an open chat picker as having no transcript", () => {
    const picker = [
      "                              Select a chat to resume",
      "   ▍Search chats...",
      "  ┌─────────────────────────────────────────────────────────────────┐",
      "  │ just now       3 msgs     remember the word BANANA          [×]  █│",
      "  └─────────────────────────────────────────────────────────────────┘",
      "  ↑↓ navigate · → / Enter open chat · Click [×] to remove · Esc cancel",
    ].join("\n");
    assert.deepEqual(extractTranscript(picker), []);
  });
});
