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
  "╭────────────── Error ──────────────╮",
  "│                        Close ✕ │",
  "│ The agent step failed: request timed out.     │",
  "╰───────────────────────────────────────────╯",
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

  it("reads a dialog whose body echoes the queued-message panel", () => {
    // The phrase is dialog text, not the panel: it sits inside the box.
    const body = "╭─── Some questions for you ───╮\n│ Close ✕ │\n│ Your message is saved │";
    expect(classifyPane(`${body}\n╰──────────────────────────────╯`)).toBe("waiting");
  });

  it("keeps a dialog the pane cuts off waiting over a transcript prompt", () => {
    // The pane ends before the closing border, so nothing below it is a composer.
    const cut = ["❯ hello", "╭─── Some questions for you ───╮", "│ Close ✕ │"];
    expect(classifyPane(cut.join("\n"))).toBe("waiting");
  });

  it("ignores a question dialog the transcript merely quotes", () => {
    // Only a dialog drawn over the bottom of the pane blocks: prose about the
    // panel, however close to the composer, is still prose.
    const quoting = [
      '  The modal reads "Some questions for you" with a Close ✕ row, so the',
      "  classifier can match it and report waiting for the session.",
      "",
      " working...  9m 21s   ■ Esc",
      "╭──────────────────────────────────────╮",
      "│  ▍Add to the current task            │",
      "╰──────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(quoting)).toBe("running");
    expect(classifyPane(quoting.replace(" working...  9m 21s   ■ Esc\n", ""))).toBe("idle");
  });

  it("ignores a question quoted inside a transcript panel", () => {
    // Tool output draws boxes too: a captioned panel without the modal's close
    // row under its top border is transcript, not a dialog.
    const panel = [
      "  ╭─────── Some questions for you ───────╮",
      "  │ the modal, as captured by an earlier run │",
      "  ╰─────────────────────────────────────────╯",
      " working...  1m 31s   ■ Esc",
      "╭───────────────────────────────────╮",
      "│  ▍Add to the current task         │",
      "╰───────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(panel)).toBe("running");
  });

  it("reads a quote whose only border is the composer's as output", () => {
    // The caption and close row were printed without a bottom border of their
    // own, so the first border under them closes the input box: the composer is
    // drawn, which a live dialog never leaves room for.
    const truncated = [
      "╭────────────── Some questions for you ──────────────╮",
      "│                                          Close ✕ │",
      " working...  2m 04s   ■ Esc",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(truncated)).toBe("running");
    expect(classifyPane(truncated.replace(" working...  2m 04s   ■ Esc\n", ""))).toBe("idle");
  });

  it("reads a tall question dialog as waiting", () => {
    // The caption sits on the top border with Close under it, so a dialog taller
    // than the pane's footer still counts, however many rows it holds.
    const tall = [
      "╭────────────── Some questions for you ──────────────╮",
      "│                                          Close ✕ │",
      ...Array.from({ length: 24 }, (_, i) => `│ ▼ question ${i + 1}${' '.repeat(50)}│`),
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(tall)).toBe("waiting");
  });

  it("never takes a confirmation phrase in the transcript for a block", () => {
    // Only a dialog's caption counts: prose, a quoted prompt or tool output can
    // say "(y/n)" or "Do you want to proceed" without anything being asked.
    const asking = [
      "  To continue, the tool would have prompted (y/n) -- it did not, so it just ran.",
      '  The harness asked "Do you want to proceed?" and the answer was yes.',
      "",
      " working...  2m 04s   ■ Esc",
      "╭───────────────────────────────────────────────────────╮",
      "│  ▍Add to the current task (/ for commands)            │",
      "╰───────────────────────────────────────────────────────╯",
      " ← for history · ? for help",
    ].join("\n");
    expect(classifyPane(asking)).toBe("running");
    expect(classifyPane(asking.replace(" working...  2m 04s   ■ Esc\n", ""))).toBe("idle");
  });

  it("reads a question dialog whose body mentions clicking Close", () => {
    // A body row can carry the close words too; only a caption over the row
    // opens a dialog, so the scan keeps looking rather than giving up.
    const mentioning = [
      "╭────────────── Some questions for you ──────────────╮",
      "│                                          Close ✕ │",
      "│ ▼ How should the dialog be dismissed?            │",
      "│   Click Close ✕ in the top right, or press Esc    │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(mentioning)).toBe("waiting");
  });

  it("ignores a printed dialog above an unboxed prompt", () => {
    // The prompt is not always drawn inside a box, and it still gives the
    // dialog away as output: a dialog replaces whatever composer is there.
    const printed = [
      "  The panel reads:",
      "╭──────────────── Some questions for you ────────────────╮",
      "│                                                Close ✕ │",
      "╰────────────────────────────────────────────────────────╯",
      " ❯ Add to the current task",
    ].join("\n");
    expect(classifyPane(printed)).toBe("idle");
  });

  it("reads a boxed Do you want to proceed caption as waiting", () => {
    const proceed = [
      "╭────────────── Do you want to proceed? ──────────────╮",
      "│                                          Close ✕ │",
      "│  This runs the command above.                    │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(proceed)).toBe("waiting");
  });

  it("leaves a dialog it does not recognise to the composer", () => {
    // An unknown caption is not a verdict: only the dialogs known to block on
    // the user decide, and the absence of a composer decides the rest.
    const other = [
      "╭────────────────── Preferences ──────────────────╮",
      "│                                          Close ✕ │",
      "│  Theme, model, shortcuts.                        │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(other)).toBe("idle");
  });

  it("keeps a bare Close row in prose from blocking a session", () => {
    // The close affordance on its own is not a dialog.
    const prose = [
      "│ Press Close ✕ in the top right of the panel to dismiss it. │",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(prose)).toBe("idle");
  });

  it("reads an error dialog as error, not as a question", () => {
    expect(classifyPane(ERROR_PANE)).toBe("error");
  });

  it("keeps a question waiting when its body mentions an error", () => {
    // Only the caption decides: a question's body is free text, and the agent's
    // own words about a failed step do not turn the question into an error.
    const asking = [
      "╭────────────── Some questions for you ──────────────╮",
      "│                                          Close ✕ │",
      "│ ▼ The previous step failed with an error. Retry?  │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(asking)).toBe("waiting");
  });

  it("reads a caption that both asks and reports as waiting", () => {
    // The question is what blocks; a failure in the same caption does not make
    // it an error, because the user is still the one who has to answer.
    const both = [
      "╭────────── Do you want to proceed? A step failed ──────────╮",
      "│                                              Close ✕ │",
      "╰──────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(both)).toBe("waiting");
  });

  it("leaves a caption that only names errors to the composer", () => {
    // The caption has to say the dialog reports a failure; `Errors` on its own is
    // not a verdict, so the absence of a composer decides.
    const plural = [
      "╭────────────────── Errors ──────────────────╮",
      "│                                      Close ✕ │",
      "│  3 rows failed to sync.                     │",
      "╰─────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(plural)).toBe("idle");
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

  it("reads a live inline confirmation prompt as waiting", () => {
    // Freebuff asks some confirmations in the composer itself rather than in a
    // boxed dialog, so the question is the text just above the input.
    const inline = [
      "  The last turn finished in 2s.",
      "  Do you want to proceed? (y/n)",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(inline)).toBe("waiting");
  });

  it("reads the concurrent-session limit drawn over the composer as waiting", () => {
    // Freebuff keeps the typed message as an unsent draft behind this modal, so
    // the session is blocked on the user rather than parked at the prompt.
    const limit = [
      "  You have reached the concurrent session limit.",
      "  Upgrade to run two sessions at once.",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(limit)).toBe("waiting");
  });

  it("reads a boxed concurrent-session limit modal as waiting", () => {
    const boxed = [
      "╭───────── You have reached the concurrent-session limit ─────────╮",
      "│                                                    Close ✕ │",
      "│  Upgrade to run two sessions at once.                      │",
      "╰─────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(boxed)).toBe("waiting");
  });

  it("keeps a transcript line quoting (y/n) from blocking a parked session", () => {
    // The same words further up the scrollback are output, not a question.
    const quoted = [
      "  The tool would have asked (y/n), but it never did.",
      "  After that the turn ended and the session parked.",
      "  Three more lines of recap follow this one.",
      "  Four lines, in fact, before the composer.",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(quoted)).toBe("idle");
  });

  it("reads a prompt above a live turn status line as running, not waiting", () => {
    // The status line separates the prompt from the composer: the turn is still
    // going, so the question is not the thing the session is blocked on.
    const live = [
      "Do you want to proceed? (y/n)",
      " working...  1m 31s   ■ Esc",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(live)).toBe("running");
  });

  it("keeps a rhetorical question just above the composer from blocking it", () => {
    // The window is measured at the composer, so a row close to the input counts
    // toward it, but the question still has to end where the row does.
    const rhetorical = [
      "  The turn ended after 2s.",
      "  Do you want to proceed? That depends on the cost.",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(classifyPane(rhetorical)).toBe("idle");
  });

  it("reads a prompt the session already answered as scrollback", () => {
    // The echoed prompt and its answer look like a composer and the question is
    // still above them, but the pane's own composer is below: only the rows above
    // the nearest composer are read, so the answer ends the walk whether or not
    // recap rows sit between it and the input box.
    const exchange = ["  Do you want to proceed? (y/n)", "  │ ❯ y"];
    const composer = [
      "  The turn finished in 4s.",
      "╭──────────────────────────────────────────╮",
      "│  ▍Add to the current task                │",
      "╰──────────────────────────────────────────╯",
    ];
    expect(classifyPane([...exchange, ...composer].join("\n"))).toBe("idle");
    expect(classifyPane([...exchange, ...composer.slice(1)].join("\n"))).toBe("idle");
  });

  it("strips colour codes before matching", () => {
    expect(stripAnsi("\u001b[1m\u001b[32mworking...\u001b[0m  ■ Esc")).toBe("working...  ■ Esc");
    expect(classifyPane("\u001b[2m working...   10s   ■ Esc\u001b[0m\n ❯ Add to the current task")).toBe("running");
  });
});
