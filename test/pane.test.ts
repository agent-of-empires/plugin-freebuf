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

  it("ignores the queued-message phrase quoted in the transcript", () => {
    // The words alone are prose: the panel is what has its square border over it.
    // The composer below keeps the row in range, so the guard is what decides.
    expect(
      classifyPane(
        [
          " working...  2m 10s   ■ Esc",
          '│ The panel reads "Your message is saved" while a turn runs │',
          "╭───────────────────────────────────╮",
          "│  ▍Add to the current task         │",
          "╰───────────────────────────────────╯",
        ].join("\n"),
      ),
    ).toBe("idle");
  });

  it("reads a parked prompt with no status line as idle", () => {
    expect(classifyPane(IDLE_PANE)).toBe("idle");
  });

  it("ignores a dialog-shaped panel the session printed above the composer", () => {
    // A real dialog replaces the composer, so the box drawn as output is given
    // away by the composer underneath it.
    const printed = [
      "  The panel reads:",
      "╭──────────────── Some questions for you ────────────────╮",
      "│                                                Close ✕ │",
      "╰────────────────────────────────────────────────────────╯",
      " working...  1m 31s   ■ Esc",
      "╭────────────────────────────────────────────────────────╮",
      "│  ▍Add to the current task (/ for commands)             │",
      "╰────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(printed)).toBe("running");
    expect(classifyPane(printed.replace(" working...  1m 31s   ■ Esc\n", ""))).toBe("idle");
  });

  it("prefers a dialog over the working line it was drawn across", () => {
    expect(classifyPane(`${RUNNING_PANE}\n${WAITING_PANE}`)).toBe("waiting");
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
