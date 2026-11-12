// What Freebuff's own screen says, read the way the host reads its built-in
// agents: capture the pane, then classify top-down -- a blocking dialog first,
// then the working status line, then parked at the prompt.
//
// The host's native detectors do this in-process against their tmux surface. A
// plugin has no pane RPC, so this asks the host CLI (`aoe session capture`) for
// the same text. A failed capture is unknown, not idle: the caller leaves the
// previous claim alone and it decays on its own. Nothing here invents state from
// timestamps, so a pane that says "working" is running even if no file moved.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where a Homebrew or cargo install of the CLI tends to land. */
const KNOWN_LOCATIONS = [
  "/opt/homebrew/bin/aoe",
  "/usr/local/bin/aoe",
  path.join(os.homedir(), ".local", "bin", "aoe"),
  path.join(os.homedir(), ".cargo", "bin", "aoe"),
];

let resolvedBinary: string | null | undefined;

/**
 * Locate the host CLI. The daemon's PATH is not the login shell's, so a bare
 * `aoe` is not enough: check PATH, then the usual install locations, and cache
 * the answer for the process lifetime.
 */
export function resolveAoeBinary(explicit: string | undefined = process.env.AOE_BIN): string | null {
  if (explicit) return explicit;
  if (resolvedBinary !== undefined) return resolvedBinary;
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "aoe");
    if (executable(candidate)) {
      resolvedBinary = candidate;
      return resolvedBinary;
    }
  }
  resolvedBinary = KNOWN_LOCATIONS.find(executable) ?? null;
  return resolvedBinary;
}

/** Lines of scrollback the classifier looks at; the chrome sits at the bottom. */
export const CAPTURE_LINES = 60;

/** How long one capture may take before the session counts as unknown. */
const CAPTURE_TIMEOUT_MS = 4_000;

export type PaneState = "waiting" | "running" | "idle" | "error";

/**
 * Rows a dialog's caption may sit above its close row. The caption *is* the
 * box's top border, and Freebuff puts `Close ✕` on the row under it, so this
 * holds however tall the dialog gets.
 */
const DIALOG_CAPTION_ROWS = 2;

/**
 * The captioned top border of a boxed dialog, `╭─── Some questions for you ───╮`.
 * Freebuff titles its ask-user panel this way, and gives other modals their own
 * caption, so the caption is what says which dialog is up.
 */
const DIALOG_TOP = /^[ \t]*╭─+[ \t]+(.*?)[ \t]+─+╮[ \t]*$/;

/** A row inside a boxed dialog carrying the modal's close affordance. */
const DIALOG_CLOSE_ROW = /^[ \t]*│.*Close ✕.*│[ \t]*$/;

/**
 * Captions of the dialogs that block on the user. Checked before the working
 * line, because a dialog is drawn while the turn is still open.
 */
const WAITING_DIALOG = /Some questions for you|Do you want to (?:proceed|allow|continue)/i;

/**
 * A caption that says the dialog reports a failure rather than asking
 * anything. Conservative on purpose: only the caption counts, because the body
 * of a question is free text and may well mention an error.
 */
const ERROR_DIALOG = /\b(?:error|failed|failure)\b/i;

/** Freebuff's live turn status line. */
const STATUS_LINE = /^[ \t]*(?:working|thinking)\.\.\.[^\n]*■[ \t]*Esc\b[ \t]*$/;

/**
 * The input prompt. Freebuff draws it inside a rounded box (with blank rows)
 * since 0.2.36, so the prompt row starts with a border column; the focused
 * composer shows `▍`, an unfocused one `❯`.
 */
const PROMPT_LINE = /^[ \t]*(?:│[ \t]*)?(?:❯|▍)/;

/** The top border of that input box, which is the prompt row's frame. */
const INPUT_BOX_TOP = /^[ \t]*╭─+╮[ \t]*$/;

/**
 * The panel Freebuff draws over the composer instead of the input box: a
 * message typed while the turn is still running is held until it ends. The
 * composer is gone, so the live-turn status line sits above this panel.
 */
const QUEUED_MESSAGE = /Your message is saved/;

/**
 * Rows that may sit between the status line and the composer: borders and
 * blanks, in either the rounded frame of the input box or the square frame of
 * the panels Freebuff draws in its place.
 */
const CHROME_ROW = /^[ \t]*[│╭╮╰╯─┌┐└┘]*[ \t]*$/;

/** How far above the prompt the status line may sit; the input box is a few rows tall. */
const MAX_CHROME_ROWS = 12;

/** The border that closes a boxed panel, `╰────╯`. */
const BOX_BOTTOM = /^[ \t]*╰─+╯[ \t]*$/;

/**
 * The frame a dialog replaces: the composer's box, or the panel drawn over it
 * when a message is queued mid-turn. Only these full-width frames count -- a
 * marker character can appear inside a dialog's own body.
 */
function isComposerFrame(row: string): boolean {
  return INPUT_BOX_TOP.test(row) || QUEUED_MESSAGE.test(row);
}

/**
 * The caption of the dialog drawn at the bottom of the pane, or null when the
 * bottom of the pane is the composer.
 *
 * Read from the `Close ✕` row upward to the captioned border just above it, so
 * the dialog's height does not matter. The dialog replaces the composer, and
 * that is the rule that separates it from the transcript: a boxed panel with a
 * composer drawn *below* it is output the session printed or quoted, not a
 * dialog waiting on the user.
 */
function bottomDialog(lines: readonly string[]): string | null {
  for (let close = lines.length - 1; close >= 0; close -= 1) {
    if (!DIALOG_CLOSE_ROW.test(lines[close])) continue;
    // A body row can repeat the same words, so only a close row with a caption
    // over it opens a dialog; anything else keeps the scan going upward.
    let caption: string | null = null;
    for (let top = close - 1; top >= Math.max(0, close - DIALOG_CAPTION_ROWS); top -= 1) {
      const found = DIALOG_TOP.exec(lines[top]);
      if (found !== null) {
        caption = found[1];
        break;
      }
    }
    if (caption === null) continue;
    // What follows the box is chrome: the dialog's own body ends at its closing
    // border, so a body row is never mistaken for the composer underneath.
    const bottom = lines.findIndex((row, index) => index > close && BOX_BOTTOM.test(row));
    if (lines.slice((bottom === -1 ? close : bottom) + 1).some(isComposerFrame)) return null;
    return caption;
  }
  return null;
}

/**
 * What the dialog at the bottom of the pane is blocking on, or null when there
 * is no dialog there.
 *
 * A dialog's caption decides; nothing else in the pane is read for a block, so
 * no amount of talking about one -- in prose, in a quoted prompt, in tool
 * output -- can claim the session is waiting on the user.
 */
function blockedOn(lines: readonly string[]): PaneState | null {
  const caption = bottomDialog(lines);
  if (caption === null) return null;
  if (WAITING_DIALOG.test(caption)) return "waiting";
  if (ERROR_DIALOG.test(caption)) return "error";
  return null; // an unrecognised dialog is not a verdict; the composer decides
}

/**
 * True when a live-turn status line sits in the chrome above the composer.
 *
 * Read from the composer upward: only blank and border rows may separate it
 * from the status line, so the phrase quoted in the transcript -- agent prose,
 * or the prompt quoted back -- never counts, and a status line far up the
 * scrollback is out of reach.
 */
function statusAbovePrompt(lines: readonly string[]): boolean {
  for (let anchor = 0; anchor < lines.length; anchor += 1) {
    const line = lines[anchor];
    const composer = PROMPT_LINE.test(line) || INPUT_BOX_TOP.test(line) || QUEUED_MESSAGE.test(line);
    if (!composer) continue;
    for (let j = anchor - 1; j >= 0 && j >= anchor - MAX_CHROME_ROWS; j -= 1) {
      if (STATUS_LINE.test(lines[j])) return true;
      if (!CHROME_ROW.test(lines[j])) break;
    }
  }
  return false;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching the escape byte is the point
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Classify a captured pane. Unrecognised content is the idle prompt. */
export function classifyPane(text: string): PaneState {
  const lines = stripAnsi(text).split(/\r?\n/);
  const blocked = blockedOn(lines);
  if (blocked !== null) return blocked;
  if (statusAbovePrompt(lines)) return "running";
  return "idle";
}

/**
 * Capture one session's visible pane through the host CLI, or null when the
 * capture failed (no such pane, CLI missing, timeout).
 */
export async function capturePane(sessionId: string, binary?: string): Promise<string | null> {
  const cli = binary ?? resolveAoeBinary();
  if (cli === null) return null;
  try {
    const { stdout } = await run(cli, ["session", "capture", sessionId, "-n", String(CAPTURE_LINES)], {
      timeout: CAPTURE_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}
