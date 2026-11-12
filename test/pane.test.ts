import { describe, expect, it } from "vitest";
import { classifyPane, stripAnsi } from "../src/pane";

/** Real chrome from a Freebuff pane, captured with `aoe session capture`. */
const WAITING_PANE = [
  "│  Get Started  getdx.com                                                               │",
  "╰───────────────────────────────────────────────────────────────────────────────────────╯",
  "                                                                                    1m 23s",
  "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
  "│                                                                                 Close ✕ │",
  "│                                                                                         │",
  "│ ▼ How far should the row shrink?                                                        │",
  "│   ○ Icon only, drop sort/filter                                                         │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

/** Real bottom-of-screen chrome, captured from a working Freebuff 0.2.36 pane. */
const RUNNING_PANE = [
  "     Row badge becomes one status icon/glyph tinted by workflow state, and the",
  " working...                                                                 1m 31s   ■ Esc",
  "╭───────────────────────────────────────────────────────────────────────────────────────╮",
  "│                                                                                       │",
  "│  ▍Add to the current task (/ for commands)                                            │",
  "│                                                                                       │",
  "╰───────────────────────────────────────────────────────────────────────────────────────╯",
  " DeepSeek Fast • high · ~/code/.worktrees/aoe-freebuf/status · /model to change",
  " ← for history · ? for help",
].join("\n");

const IDLE_PANE = [
  "     Row badge becomes one status icon/glyph tinted by workflow state, and the",
  "╭───────────────────────────────────────────────────────────────────────────────────────╮",
  "│                                                                                       │",
  "│  ▍Add to the current task (/ for commands)                                            │",
  "│                                                                                       │",
  "╰───────────────────────────────────────────────────────────────────────────────────────╯",
  " DeepSeek Fast • high · ~/code/.worktrees/aoe-freebuf/status · /model to change",
  " ← for history · ? for help",
].join("\n");

/** Freebuff's failure surface, drawn in place of the composer like the question panel. */
const ERROR_PANE = [
  "     Row badge becomes one status icon/glyph tinted by workflow state, and the",
  "╭──────────────────────────────────── Error ─────────────────────────────────────╮",
  "│                                                                        Close ✕ │",
  "│ The agent step failed: request timed out.                                      │",
  "╰───────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

describe("pane classification", () => {
  it("reads a blocking question modal as waiting", () => {
    expect(classifyPane(WAITING_PANE)).toBe("waiting");
  });

  it("reads the working status line as running", () => {
    expect(classifyPane(RUNNING_PANE)).toBe("running");
  });

  it("reads the thinking status line as running", () => {
    expect(classifyPane(" thinking...  2m 31s  ■ Esc\n ❯ Add to the current task")).toBe("running");
  });

  it("reads the status line above the boxed prompt, including a typed draft", () => {
    // 0.2.36 draws the composer in a box; a draft changes the prompt row, so
    // the box top is what anchors the live-turn chrome.
    expect(
      classifyPane(" working...  10s  ■ Esc\n╭──────────╮\n│ my draft │\n╰──────────╯"),
    ).toBe("running");
  });

  it("reads a working pane whose composer holds a queued message as running", () => {
    // Captured live: typing while the turn runs replaces the composer with this
    // panel, so the status line anchors on the panel instead of the prompt box.
    expect(
      classifyPane(
        [
          " working...              55m 23s   ■ Esc",
          "┌───────────────────────────────────────┐",
          "│ Your message is saved and will send   │",
          "│ after the current turn.               │",
          "│ Enter: change       Esc: back to draft│",
          "│ model                                 │",
          "└───────────────────────────────────────┘",
          " DeepSeek V4.1 Flash Slow · ~/code/x · /model to change",
          " ← for history · ? for help",
        ].join("\n"),
      ),
    ).toBe("running");
  });

  it("reads a parked prompt with no status line as idle", () => {
    expect(classifyPane(IDLE_PANE)).toBe("idle");
  });

  it("prefers a dialog over the working line it was drawn across", () => {
    expect(classifyPane(`${RUNNING_PANE}\n${WAITING_PANE}`)).toBe("waiting");
  });

  it("reads an error dialog as error, not as a question", () => {
    expect(classifyPane(ERROR_PANE)).toBe("error");
  });

  it("reads a question dialog whose body echoes the queued-message panel", () => {
    // The phrase in a question's body is text, not the panel: it sits inside the
    // box, above the border that closes it, so the dialog still blocks.
    const echoing = [
      "╭──────────────────────────────── Some questions for you ────────────────────────────────╮",
      "│                                                                                 Close ✕ │",
      "│ ▼ Quoted from the composer:                                                             │",
      "│   Your message is saved and will send after the current turn                            │",
      "╰─────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(echoing)).toBe("waiting");
  });

  it("reads a question dialog whose body mentions clicking Close", () => {
    // A body row can carry the close words too; only the row under the caption
    // is the real one, and the scan keeps looking rather than giving up on it.
    const mentioning = [
      "╭──────────────────────────────── Some questions for you ────────────────────────────────╮",
      "│                                                                                 Close ✕ │",
      "│ ▼ How should the dialog be dismissed?                                                   │",
      "│   Click Close ✕ in the top right, or press Esc                                          │",
      "╰─────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(mentioning)).toBe("waiting");
  });

  it("never takes a confirmation phrase in the transcript for a block", () => {
    // Only a dialog's caption counts: prose, a quoted prompt or tool output can
    // say "(y/n)" or "Do you want to proceed" without anything being asked.
    const asking = [
      "  To continue, the tool would have prompted (y/n) -- it did not, so it just ran.",
      "  The harness asked \"Do you want to proceed?\" and the answer was yes.",
      "",
      " working...                                                                   2m 04s   ■ Esc",
      "╭───────────────────────────────────────────────────────────────────────────────────╮",
      "│  ▍Add to the current task (/ for commands)                                        │",
      "╰───────────────────────────────────────────────────────────────────────────────────╯",
      " ← for history · ? for help",
    ].join("\n");
    expect(classifyPane(asking)).toBe("running");
    expect(classifyPane(asking.replace(" working...                                                                   2m 04s   ■ Esc\n", ""))).toBe("idle");
  });

  it("ignores a question dialog the transcript merely quotes", () => {
    // The transcript scrolls away above the composer; only a dialog drawn over
    // the bottom of the pane blocks the session. A working session whose own
    // output mentions the panel is still working, and must not be flagged.
    const quoting = [
      '  The modal reads "Some questions for you" with a Close ✕ row, so the',
      "  classifier can match it. Then the worker reports waiting for it.",
      "",
      " working...                                                                   9m 21s   ■ Esc",
      "╭───────────────────────────────────────────────────────────────────────────────────╮",
      "│                                                                                   │",
      "│  ▍Add to the current task (/ for commands)                                        │",
      "│                                                                                   │",
      "╰───────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(quoting)).toBe("running");

    // Same for a parked composer: prose about the dialog is not a dialog.
    expect(classifyPane(`${quoting}\n ← for history · ? for help`)).toBe("running");
    const parked = [
      '  The modal reads "Some questions for you" with a Close ✕ row.',
      "╭───────────────────────────────────────────────────────────────────────────────────╮",
      "│  ▍Add to the current task (/ for commands)                                        │",
      "╰───────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(parked)).toBe("idle");
  });

  it("ignores a question quoted inside a transcript panel", () => {
    // Tool output draws boxes too: a captioned panel above the composer is
    // still transcript, so it needs the modal's close row to count.
    const panel = [
      "  ╭──────────────────────────── Some questions for you ────────────────────────────╮",
      "  │ the modal, as captured by an earlier run                                        │",
      "  ╰────────────────────────────────────────────────────────────────────────────────╯",
      " working...                                                                   1m 31s   ■ Esc",
      " ╭─────────────────────────────────────────────────────────────────────────────╮",
      " │  ▍Add to the current task (/ for commands)                                   │",
      " ╰─────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(panel)).toBe("running");
  });

  it("reads a tall question dialog as waiting", () => {
    // The caption sits on the box's top border with Close under it, so a dialog
    // taller than the pane's footer still counts, however many rows it holds.
    const tall = [
      "╭──────────────────────────────── Some questions for you ────────────────────────────────╮",
      "│                                                                                 Close ✕ │",
      ...Array.from({ length: 24 }, (_, i) => `│ ▼ question ${i + 1}${" ".repeat(84)}│`),
      "╰─────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(tall)).toBe("waiting");
  });

  it("ignores a dialog-shaped panel the session printed above the composer", () => {
    // The same box, drawn as output: the composer under it is what gives it
    // away, because a real dialog replaces the composer.
    const printed = [
      "  The panel reads:",
      "╭──────────────────────────────── Some questions for you ──────────────────╮",
      "│                                                                Close ✕ │",
      "╰─────────────────────────────────────────────────────────────────────────╯",
      " working...                                                        1m 31s   ■ Esc",
      "╭─────────────────────────────────────────────────────────────────────────╮",
      "│  ▍Add to the current task (/ for commands)                              │",
      "╰─────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(printed)).toBe("running");

    // Parked instead of working, the same output still is not a dialog.
    expect(classifyPane(printed.replace(" working...                                                        1m 31s   ■ Esc\n", ""))).toBe(
      "idle",
    );
  });

  it("ignores status text quoted in an idle transcript", () => {
    expect(classifyPane(`The pane says thinking...  2m 31s  ■ Esc\n${IDLE_PANE}`)).toBe("idle");
    expect(classifyPane(` thinking...  2m 31s  ■ Esc\nSome explanation\n${IDLE_PANE}`)).toBe("idle");
  });

  it("ignores a status line far above the prompt in transcript text", () => {
    // Blank rows exercise the MAX_CHROME_ROWS distance limit; prose rows stop the matcher early.
    const transcript = [" thinking...  2m 31s  ■ Esc", ...Array(20).fill(""), " ❯ prompt"].join("\n");
    expect(classifyPane(transcript)).toBe("idle");
  });

  it("strips colour codes before matching", () => {
    expect(stripAnsi("\u001b[1m\u001b[32mworking...\u001b[0m  ■ Esc")).toBe("working...  ■ Esc");
    expect(classifyPane("\u001b[2m working...   10s   ■ Esc\u001b[0m\n ❯ Add to the current task")).toBe("running");
  });
});
