// Freebuff's blocking dialog, read off the pane as the host's reply contract
// needs it: the expanded question, every option the user can pick from, whether
// the question takes several, whether it offers a typed answer, and whether it
// is the form's last question (which decides whether the form still needs
// submitting).
//
// Freebuff draws a rounded modal titled "Some questions for you". Each question
// is a header -- `▼` for the one expanded right now, `▶` for a collapsed one --
// with its options below it (`○` unselected / `●` selected, or `☐`/`☑` for a
// question that takes several, marked by a `(Select multiple options)` line).
// A question with a typed answer ends with an extra row labelled `Custom`,
// which is not one of its options: it opens a text field.
//
// The dialog's own keys (verified against the installed Freebuff bundle) are:
//   - arrows move between rows, Enter/Space selects the focused row;
//   - a single-choice selection advances to the next question, and the last
//     one leaves the Submit button focused, so one more Enter submits the form;
//   - a multi-choice Enter toggles and stays put, so Tab (Submit) then Enter is
//     how its form gets submitted;
//   - Enter on the Custom row opens its text field, and Enter there ends the
//     answer.
// The delivery sequence in src/replies.ts is built from exactly that.
//
// Everything here is a heuristic over captured text, the same trade-off the
// pane classifier makes: a miss only leaves the prompt to the Freebuff window.

import { createHash } from "node:crypto";
import type { IntegrationPrompt } from "./integration.js";
import { stripAnsi } from "./pane.js";

/** Marks the modal. Its absence means there is nothing to answer. */
const DIALOG_TITLE = /Some questions for you/;

/** The question expanded right now. */
const EXPANDED_HEADER = /^[ \t]*[▼▾][ \t]*(.+?)[ \t]*$/;

/** Any other question in the form, collapsed down to its header. */
const COLLAPSED_HEADER = /^[ \t]*[▶▸][ \t]*(.+?)[ \t]*$/;

/** An option row. `●`/`☑` is the selected state, `○`/`☐` the unselected one. */
const OPTION_ROW = /^[ \t]*([○●☐☑])[ \t]*(.+?)[ \t]*$/;

/** Freebuff prints this above the options of a question that takes several. */
const MULTI_SELECT_NOTE = /\(Select multiple options\)/i;

/** The last row of a question that accepts a typed answer. */
const CUSTOM_ROW = /^custom$/i;

/** The modal's bottom border ends its body. */
const BOX_BOTTOM = /^[ \t]*╰/;

/** A leading "1. " is the question's position in the form, not its text. */
const QUESTION_NUMBER = /^\d+\.\s+/;

export interface DialogOption {
  label: string;
  /** The marker Freebuff drew: `○`/`●` single-choice, `☐`/`☑` multi. */
  marker: string;
}

export interface PaneDialog {
  question: string;
  options: DialogOption[];
  /** A `Custom` row is offered, so a typed answer can be delivered. */
  custom: boolean;
  /** The question takes several selections. */
  multi: boolean;
  /** Nothing follows this question, so answering it must also submit the form. */
  isLast: boolean;
  /** Identity of the dialog's content; stable while the question is unchanged. */
  id: string;
}

/**
 * Drop the modal's frame column and padding, so the body's own layout is left.
 * A row without borders (the title row) is only right-trimmed.
 */
function unframe(line: string): string {
  const withoutLeft = line.replace(/^[ \t]*│/, "");
  const withoutRight = withoutLeft.replace(/[ \t]*│[ \t]*$/, "");
  return withoutRight.replace(/[ \t]+$/, "");
}

/** The content-derived id the host validates a reply against. */
function dialogId(dialog: Omit<PaneDialog, "id">): string {
  const material = [
    dialog.question,
    dialog.multi ? "multi" : "single",
    dialog.custom ? "custom" : "options-only",
    dialog.isLast ? "last" : "more",
    ...dialog.options.map((option) => `${option.marker}${option.label}`),
  ].join("\n");
  return `freebuff-dialog-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

/**
 * The replyable question in this pane, or null when the screen shows no modal
 * (or an expanded question with nothing to pick).
 */
export function parsePaneDialog(text: string): PaneDialog | null {
  const lines = stripAnsi(text).split(/\r?\n/);
  const title = lines.findIndex((line) => DIALOG_TITLE.test(line));
  if (title < 0) return null;

  let question: string | null = null;
  let multi = false;
  let anotherQuestion = false;
  const rows: DialogOption[] = [];
  for (let index = title + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (BOX_BOTTOM.test(raw)) break;
    const body = unframe(raw);
    if (MULTI_SELECT_NOTE.test(body)) {
      multi = true;
      continue;
    }
    const expanded = EXPANDED_HEADER.exec(body);
    if (expanded !== null) {
      // One question is expanded at a time: the first block is the live one,
      // and a later header means another question follows.
      if (question === null) question = expanded[1].replace(QUESTION_NUMBER, "").trim();
      else anotherQuestion = true;
      continue;
    }
    if (COLLAPSED_HEADER.test(body)) {
      // A collapsed question before the expanded one is already answered; one
      // after it means the form continues past this question.
      if (question !== null) anotherQuestion = true;
      continue;
    }
    const option = OPTION_ROW.exec(body);
    if (option !== null && question !== null) {
      rows.push({ marker: option[1], label: option[2].trim() });
    }
  }

  if (question === null || question === "") return null;
  // A trailing `Custom` row is not an option: it opens a typed answer.
  const custom = rows.length > 0 && CUSTOM_ROW.test(rows[rows.length - 1].label);
  const options = custom ? rows.slice(0, -1) : rows;
  if (options.length === 0 && !custom) return null;

  const dialog: Omit<PaneDialog, "id"> = { question, options, custom, multi, isLast: !anotherQuestion };
  return { ...dialog, id: dialogId(dialog) };
}

/** The host-facing prompt for a parsed dialog. */
export function dialogPrompt(dialog: PaneDialog): IntegrationPrompt {
  return {
    kind: "question",
    id: dialog.id,
    title: dialog.question,
    questions: [
      {
        id: `${dialog.id}-q1`,
        question: dialog.question,
        options: dialog.options.map((option) => ({ label: option.label })),
        ...(dialog.multi ? { multi: true } : {}),
      },
    ],
  };
}
