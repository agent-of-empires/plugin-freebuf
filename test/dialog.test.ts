import { describe, expect, it } from "vitest";
import { dialogPrompt, parsePaneDialog } from "../src/dialog";

/** Real chrome from a Freebuff pane, captured with `aoe session capture`. */
const SINGLE_OPTION = [
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

const TWO_OPTIONS = [
  "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
  "│                                                                                 Close ✕ │",
  "│                                                                                         │",
  "│ ▼ How far should the row shrink?                                                        │",
  "│   ○ Icon only, drop sort/filter                                                         │",
  "│   ○ Keep the label, drop the sort arrows                                                │",
  "│   ○ Custom                                                                              │",
  "│                                                                                         │",
  "│                                  ┌──────────┐     ↑↓ navigate • Enter select            │",
  "│                                  │  Submit  │                                            │",
  "│                                  └──────────┘                                            │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

const MULTI_SELECT = [
  "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
  "│                                                                                 Close ✕ │",
  "│                                                                                         │",
  "│ ▼ Which checks should run?                                                              │",
  "│   (Select multiple options)                                                             │",
  "│   ☐ Unit tests                                                                          │",
  "│   ☑ Lint                                                                                │",
  "│   ☐ Custom                                                                              │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

const TWO_QUESTIONS_FIRST_EXPANDED = [
  "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
  "│                                                                                 Close ✕ │",
  "│ ▼ 1. How far should the row shrink?                                                     │",
  "│   ○ Icon only                                                                           │",
  "│   ○ Custom                                                                              │",
  "│ ▶ 2. Which theme should it use?                                                         │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

const TWO_QUESTIONS_SECOND_EXPANDED = [
  "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
  "│                                                                                 Close ✕ │",
  "│ ▶ 1. How far should the row shrink?                                                     │",
  "│   ↳ \"Icon only\"                                                                         │",
  "│ ▼ 2. Which theme should it use?                                                         │",
  "│   ○ Dark                                                                                │",
  "│   ○ Light                                                                               │",
  "╰─────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

describe("pane dialog parsing", () => {
  it("reads the question and its options off the modal", () => {
    expect(parsePaneDialog(SINGLE_OPTION)).toMatchObject({
      question: "How far should the row shrink?",
      options: [{ label: "Icon only, drop sort/filter", marker: "○" }],
      multi: false,
      custom: false,
      isLast: true,
    });
  });

  it("keeps every option in screen order, so an index is a keypress count", () => {
    const dialog = parsePaneDialog(TWO_OPTIONS);
    expect(dialog?.options.map((option) => option.label)).toEqual([
      "Icon only, drop sort/filter",
      "Keep the label, drop the sort arrows",
    ]);
  });

  it("reads the trailing Custom row as a typed answer, not an option", () => {
    const dialog = parsePaneDialog(TWO_OPTIONS);
    expect(dialog?.custom).toBe(true);
    expect(dialog?.options).toHaveLength(2); // Custom is one row past the options
  });

  it("reads a multi-select question with its checkbox markers", () => {
    const dialog = parsePaneDialog(MULTI_SELECT);
    expect(dialog).toMatchObject({ question: "Which checks should run?", multi: true, custom: true });
    expect(dialog?.options.map((option) => `${option.marker}${option.label}`)).toEqual([
      "☐Unit tests",
      "☑Lint",
    ]);
  });

  it("knows whether the expanded question is the form's last", () => {
    expect(parsePaneDialog(TWO_QUESTIONS_FIRST_EXPANDED)).toMatchObject({
      question: "How far should the row shrink?",
      isLast: false,
    });
    // A collapsed question above it is already answered, so this one ends the form.
    expect(parsePaneDialog(TWO_QUESTIONS_SECOND_EXPANDED)).toMatchObject({
      question: "Which theme should it use?",
      isLast: true,
    });
  });

  it("keeps the selected marker and drops the form's question number", () => {
    const pane = [
      "╭──────────────────────────────── Some questions for you ─────────────────────────────────╮",
      "│ ▼ 1. Which shell should the hook use?                                                  │",
      "│   ● zsh                                                                                │",
      "│   ○ bash                                                                               │",
      "╰────────────────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const dialog = parsePaneDialog(pane);
    expect(dialog?.question).toBe("Which shell should the hook use?");
    expect(dialog?.options.map((option) => option.marker)).toEqual(["●", "○"]);
  });

  it("gives the same question the same id and a different one a different id", () => {
    const first = parsePaneDialog(TWO_OPTIONS);
    const again = parsePaneDialog(`\u001b[1m${TWO_OPTIONS}\u001b[0m`); // colour is not content
    expect(first?.id).toBe(again?.id);
    expect(first?.id).not.toBe(parsePaneDialog(SINGLE_OPTION)?.id);
    expect(first?.id).not.toBe(
      parsePaneDialog(TWO_OPTIONS.replace("Keep the label, drop the sort arrows", "Keep the label"))?.id,
    );
    // The form's position matters: it decides whether answering submits.
    expect(parsePaneDialog(TWO_QUESTIONS_FIRST_EXPANDED)?.id).not.toBe(
      parsePaneDialog(TWO_QUESTIONS_SECOND_EXPANDED)?.id,
    );
  });

  it("finds nothing when the pane shows no modal", () => {
    expect(parsePaneDialog(" working...  10s  ■ Esc\n ❯ Add to the current task")).toBeNull();
    expect(parsePaneDialog("")).toBeNull();
  });

  it("ignores a dialog with nothing to pick", () => {
    expect(parsePaneDialog("│ Some questions for you\n│ ▼ Nothing to pick\n╰────╯")).toBeNull();
  });

  it("builds the host's question prompt from the parsed dialog", () => {
    const dialog = parsePaneDialog(TWO_OPTIONS)!;
    expect(dialogPrompt(dialog)).toEqual({
      kind: "question",
      id: dialog.id,
      title: "How far should the row shrink?",
      questions: [
        {
          id: `${dialog.id}-q1`,
          question: "How far should the row shrink?",
          options: [{ label: "Icon only, drop sort/filter" }, { label: "Keep the label, drop the sort arrows" }],
        },
      ],
    });
  });

  it("marks a multi-select question in the prompt so the host offers several", () => {
    const dialog = parsePaneDialog(MULTI_SELECT)!;
    expect(dialogPrompt(dialog).questions[0]).toMatchObject({ multi: true });
    expect(parsePaneDialog(TWO_OPTIONS)).toMatchObject({ multi: false });
  });
});
