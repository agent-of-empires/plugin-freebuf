// The reply side: the host writes `integration-<plugin id>.reply.json` into the
// session's hook directory once the user answers the prompt from the AoE
// session list, and the worker turns that answer into the dialog's own
// keypresses.
//
// Who owns what (aoe docs, "Report and reply files"):
//   - the host validates the report and creates the reply file, atomically and
//     0600, owned by the effective uid;
//   - the provider reads and removes it after processing.
// The host also sends the report's `reply_keys` into the pane after a response,
// which is the only way an in-process extension could notice a reply. A worker
// has no such handle, so it polls the file on its tick instead -- the wake key
// stays harmless in the TUI either way.
//
// Validation mirrors the host: the reply must echo this instance, provider
// session, writer pid, revision and prompt id, carry a UUID response id, and
// name only options the prompt actually offered. Anything else is dropped
// without touching the pane, so a stale or forged file can only ever be
// ignored.
//
// Every question shape is delivered:
//   - single choice: move to the option and Enter (Freebuff selects and moves
//     on, or leaves Submit focused on the last question);
//   - multi choice: each option needs its own toggle, so move/Enter per option,
//     then Tab to Submit when the form ends;
//   - typed answer: the dialog's trailing `Custom` row opens a text field, the
//     answer is typed into it, Enter ends it, and the form is submitted the
//     same way as above.

import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { PaneDialog } from "./dialog.js";
import { PLUGIN_ID, type AgentIntegrationSnapshot, type IntegrationPromptQuestion } from "./integration.js";

/** The file the host writes the user's answer into. */
export const REPLY_FILENAME = `integration-${PLUGIN_ID}.reply.json`;

/** A reply is a small JSON object; anything larger is not one of ours. */
export const MAX_REPLY_BYTES = 64 * 1024;

export interface ReplyAnswer {
  id: string;
  selected_options: string[];
  custom_input?: string;
}

export interface Reply {
  schema_version: number;
  instance_id: string;
  provider_session_id: string;
  writer_pid: number;
  revision: number;
  prompt_id: string;
  response_id: string;
  response: { kind: "question"; answers: ReplyAnswer[] };
}

/** One delivery step: keypresses, or literal text for the dialog's text field. */
export type KeyStep = { keys: string[] } | { text: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function replyPath(dir: string): string {
  return path.join(dir, REPLY_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when the text carries anything a terminal would interpret: the C0 and
 * C1 control ranges (DEL included), or a Unicode line or paragraph separator.
 * The text is typed into the dialog's text field as one line, so none of them
 * travel.
 */
export function hasControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C1 matters as much as C0: xterm still acts on 0x84, 0x85 and 0x88, and
    // U+2028/U+2029 render as line breaks wherever the text is shown.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/** True when `value` is the host's reply to exactly this snapshot's prompt. */
export function validateReply(value: unknown, snapshot: AgentIntegrationSnapshot): value is Reply {
  if (!isRecord(value)) return false;
  const prompt = snapshot.prompt;
  if (prompt === null || prompt.kind !== "question") return false;
  if (value.schema_version !== 1) return false;
  if (value.instance_id !== snapshot.instance_id) return false;
  if (value.provider_session_id !== snapshot.provider_session_id) return false;
  if (value.writer_pid !== snapshot.writer_pid) return false;
  if (value.revision !== snapshot.revision) return false;
  if (value.prompt_id !== prompt.id) return false;
  if (typeof value.response_id !== "string" || !UUID.test(value.response_id)) return false;
  const response = value.response;
  if (!isRecord(response) || response.kind !== "question") return false;
  const answers = response.answers;
  if (!Array.isArray(answers) || answers.length !== prompt.questions.length) return false;
  return prompt.questions.every((question, index) => answerMatches(answers[index], question));
}

function answerMatches(value: unknown, question: IntegrationPromptQuestion): boolean {
  if (!isRecord(value)) return false;
  if (value.id !== question.id) return false;
  const labels = question.options.map((option) => option.label);
  const selected = value.selected_options;
  if (!Array.isArray(selected)) return false;
  if (!selected.every((label) => typeof label === "string" && labels.includes(label))) return false;
  if (new Set(selected).size !== selected.length) return false;
  const custom = value.custom_input;
  if (custom !== undefined && typeof custom !== "string") return false;
  const typed = custom?.trim() ?? "";
  // A typed answer is a single line of text: it is typed into the dialog, so
  // control characters are refused rather than sent.
  if (hasControlCharacters(typed)) return false;
  // Multi choice takes any mix: options checked and a typed answer are not
  // alternatives there, and the dialog submits whichever the user wanted.
  if (question.multi === true) return selected.length + typed.length > 0;
  // Single choice: exactly one option, or a typed answer, never both --
  // delivery can only take one of the two, so the other would be dropped.
  return selected.length === 0 ? typed !== "" : selected.length === 1 && typed === "";
}

/**
 * Read and validate the reply file, or null when it is absent, unreadable, or
 * not a reply to the current prompt. `euid` defaults to the effective uid whose
 * hook directory the host and worker share.
 */
export function readReply(
  dir: string,
  snapshot: AgentIntegrationSnapshot,
  euid: number = os.userInfo().uid,
): Reply | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(replyPath(dir), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== euid) return null;
    // The host creates the reply 0600; anything else (including setuid/sticky
    // bits) is not the file this expects, matching how the host checks it.
    if ((stat.mode & 0o7777) !== 0o600 || stat.size > MAX_REPLY_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    return validateReply(value, snapshot) ? value : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing left to release.
      }
    }
  }
}

/** The reset prefix: see the comment on `deliverySteps`. */
const RESET_KEYS = ["Up", "Down", "Left", "Down"] as const;

/** The marker Freebuff draws on an option of a multi-choice question that is on. */
const CHECKED_MARKER = "☑";

/** Remove the reply file once it has been delivered. Absent counts as removed. */
export function consumeReply(dir: string): void {
  try {
    unlinkSync(replyPath(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * The steps that deliver this answer in the open dialog, or null when the
 * answer needs something the visible question does not offer (an option it does
 * not list, or typed text where the dialog has no text field).
 *
 * The sequence starts by putting the dialog back to "this question expanded, its
 * first option focused" (RESET_KEYS). Freebuff focuses the first option when a
 * question expands, so that reset makes "option N is N presses of Down" true no
 * matter where the focus was: a reply lands on the chosen row even if the user
 * had been arrowing around in the Freebuff window, or if an earlier quick
 * response left the focus somewhere else. Answers already given are kept --
 * collapsing a question does not clear them -- so the reset changes nothing
 * except the focus.
 *
 * Multi-choice Enter toggles rather than selects, so the sequence presses it
 * only on options whose checked state differs from the answer: one the pane
 * already shows as checked and the answer keeps is left alone, and one that is
 * checked but not answered is turned off, so the form submits exactly the
 * answer rather than whatever it happened to have marked.
 */
export function deliverySteps(
  reply: Reply,
  snapshot: AgentIntegrationSnapshot,
  dialog: PaneDialog,
): KeyStep[] | null {
  const prompt = snapshot.prompt;
  if (prompt === null || prompt.kind !== "question") return null;
  if (prompt.id !== dialog.id) return null; // a dialog other than the one answered
  const question = prompt.questions[0];
  const answer = reply.response.answers[0];
  if (question === undefined || answer === undefined) return null;

  const typed = answer.custom_input?.trim() ?? "";
  const indices: number[] = [];
  for (const label of answer.selected_options) {
    const index = question.options.findIndex((option) => option.label === label);
    if (index < 0) return null;
    indices.push(index);
  }
  if (typed !== "" && !dialog.custom) return null;
  if (indices.length === 0 && typed === "") return null;

  const customRow = dialog.options.length; // the `Custom` row sits right after the options
  const steps: KeyStep[] = [];
  // Settle the focus at the question's first option before counting presses.
  steps.push({ keys: [...RESET_KEYS] });
  let focus = 0;
  // Adjacent keypresses travel in one tmux call; a typed answer is a step of
  // its own, so nothing merges across it.
  const press = (...names: string[]): void => {
    const last = steps[steps.length - 1];
    if (last !== undefined && "keys" in last) last.keys.push(...names);
    else steps.push({ keys: [...names] });
  };
  const move = (target: number): void => {
    if (target > focus) press(...Array<string>(target - focus).fill("Down"));
    focus = target;
  };
  const select = (): void => press("Enter");

  if (dialog.multi) {
    // Toggling leaves the focus where it is, so every option that has to change
    // needs its own trip -- and one already in the answered state must not be
    // pressed at all.
    for (let index = 0; index < dialog.options.length; index += 1) {
      const wanted = indices.includes(index);
      if (wanted === (dialog.options[index]?.marker === CHECKED_MARKER)) continue;
      move(index);
      select();
    }
    if (typed !== "") {
      move(customRow);
      select(); // opens the text field
    }
  } else if (typed !== "") {
    move(customRow);
    select(); // opens the text field
  } else {
    move(indices[0]);
    select(); // selects, and either advances or leaves Submit focused
  }

  if (typed !== "") {
    steps.push({ text: typed });
    press("Enter"); // ends the typed answer
  }

  if (dialog.isLast) {
    if (dialog.multi) press("Tab"); // Submit, which a single choice already reached
    press("Enter"); // submits the form
  } else if (dialog.multi) {
    // A multi-choice question never advances on its own: one Down from its last
    // row (the Custom row when offered, otherwise the last option) moves the
    // dialog on to the next question. Aiming past a Custom row that is not
    // there would step into the next question's first option instead.
    move(dialog.custom ? customRow : dialog.options.length - 1);
    press("Down");
  }

  return steps;
}
