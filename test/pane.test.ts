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

  it("reads a parked prompt with no status line as idle", () => {
    expect(classifyPane(IDLE_PANE)).toBe("idle");
  });

  it("prefers a dialog over the working line it was drawn across", () => {
    expect(classifyPane(`${RUNNING_PANE}\n${WAITING_PANE}`)).toBe("waiting");
  });

  it("ignores status text quoted in an idle transcript", () => {
    expect(classifyPane(`The pane says thinking...  2m 31s  ■ Esc\n${IDLE_PANE}`)).toBe("idle");
    expect(classifyPane(` thinking...  2m 31s  ■ Esc\nSome explanation\n${IDLE_PANE}`)).toBe("idle");
  });

  it("ignores a status line far above the prompt in transcript text", () => {
    const transcript = [" thinking...  2m 31s  ■ Esc", ...Array(20).fill(" prose"), " ❯ prompt"].join("\n");
    expect(classifyPane(transcript)).toBe("idle");
  });

  it("strips colour codes before matching", () => {
    expect(stripAnsi("\u001b[1m\u001b[32mworking...\u001b[0m  ■ Esc")).toBe("working...  ■ Esc");
    expect(classifyPane("\u001b[2m working...   10s   ■ Esc\u001b[0m\n ❯ Add to the current task")).toBe("running");
  });
});
