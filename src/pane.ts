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

export type PaneState = "waiting" | "running" | "idle";

/** Rows a dialog's caption may sit above its close row. */
const DIALOG_CAPTION_ROWS = 2;

/** The captioned top border of a boxed dialog, `╭─── Some questions for you ───╮`. */
const DIALOG_TOP = /^[ \t]*╭─+[ \t]+(.*?)[ \t]+─+╮[ \t]*$/;

/** A row inside a boxed dialog carrying the modal's close affordance. */
const DIALOG_CLOSE_ROW = /^[ \t]*│.*Close ✕.*│[ \t]*$/;

/** Captions of the dialogs that block on the user. */
const WAITING_DIALOG = /Some questions for you|Do you want to (?:proceed|allow|continue)/i;

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
const QUEUED_MESSAGE = /^[ \t]*│.*Your message is saved.*│[ \t]*$/;

/** The square top border of that panel. */
const PANEL_TOP = /^[ \t]*┌─+┐[ \t]*$/;

/**
 * Rows that may sit between the status line and the composer: borders and
 * blanks, in either the rounded frame of the input box or the square frame of
 * the panels Freebuff draws in its place.
 */
const CHROME_ROW = /^[ \t]*[│╭╮╰╯─┌┐└┘]*[ \t]*$/;

/** How far above the prompt the status line may sit; the input box is a few rows tall. */
const MAX_CHROME_ROWS = 12;

/** How far above the panel's text its top border may sit. */
const PANEL_TOP_ROWS = 2;

/**
 * True when this row is the queued-message panel's own text, with the panel's
 * top border just above it.
 *
 * The phrase alone is not enough: a session can quote it in the transcript, and
 * an unchecked match there would anchor a status line that is nowhere near the
 * composer.
 */
function isQueuedPanel(lines: readonly string[], index: number): boolean {
  if (!QUEUED_MESSAGE.test(lines[index])) return false;
  for (let above = index - 1; above >= 0 && above >= index - PANEL_TOP_ROWS; above -= 1) {
    if (PANEL_TOP.test(lines[above])) return true;
  }
  return false;
}

/**
 * True when a live-turn status line sits in the chrome above the composer.
 *
 * Read from the composer upward: only blank and border rows may separate it
 * from the status line, so the phrase quoted in the transcript -- agent prose,
 * or the prompt quoted back -- never counts, and a status line far up the
 * scrollback is out of reach. The composer is either the prompt row or the
 * panel that replaces it while a message is queued. Reading up from the
 * composer rather than down from the status line reaches the same rows, because
 * each side stops at the first row that is neither status nor chrome.
 */
function statusAbovePrompt(lines: readonly string[]): boolean {
  for (let anchor = 0; anchor < lines.length; anchor += 1) {
    const line = lines[anchor];
    const composer = PROMPT_LINE.test(line) || INPUT_BOX_TOP.test(line) || isQueuedPanel(lines, anchor);
    if (!composer) continue;
    for (let up = anchor - 1; up >= 0 && up >= anchor - MAX_CHROME_ROWS; up -= 1) {
      if (STATUS_LINE.test(lines[up])) return true;
      if (!CHROME_ROW.test(lines[up])) break;
    }
  }
  return false;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching the escape byte is the point
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** The border that closes a boxed panel, `╰────╯`. */
const BOX_BOTTOM = /^[ \t]*╰─+╯[ \t]*$/;

/** The composer a dialog would have replaced: prompt, input box, queued panel. */
function isComposerFrame(lines: readonly string[], index: number): boolean {
  const row = lines[index];
  return PROMPT_LINE.test(row) || INPUT_BOX_TOP.test(row) || isQueuedPanel(lines, index);
}

/**
 * The caption of the dialog drawn at the bottom of the pane, or null when the
 * bottom of the pane is the composer: a boxed panel with a composer under it is
 * output the session printed or quoted, not a dialog waiting on the user.
 */
function bottomDialog(lines: readonly string[]): string | null {
  for (let close = lines.length - 1; close >= 0; close -= 1) {
    if (!DIALOG_CLOSE_ROW.test(lines[close])) continue;
    // A body row can repeat those words, so only a caption over the row opens it.
    for (let top = close - 1; top >= Math.max(0, close - DIALOG_CAPTION_ROWS); top -= 1) {
      const found = DIALOG_TOP.exec(lines[top]);
      if (found === null) continue;
      // Only rows under the dialog's closing border can hold a composer, never
      // its body. A dialog the pane cuts off has no border and so no composer.
      const bottom = lines.findIndex((row, index) => index > close && BOX_BOTTOM.test(row));
      for (let below = bottom + 1; bottom !== -1 && below < lines.length; below += 1) {
        if (isComposerFrame(lines, below)) return null;
      }
      return found[1];
    }
  }
  return null;
}

/** What the dialog at the bottom of the pane is blocking on, or null if there is none. */
function blockedOn(lines: readonly string[]): PaneState | null {
  const caption = bottomDialog(lines);
  if (caption === null) return null;
  if (WAITING_DIALOG.test(caption)) return "waiting";
  return null; // an unrecognised dialog is not a verdict; the composer decides
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
