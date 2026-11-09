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

/**
 * Freebuff's blocking UI: the "Some questions for you" modal (with its Close
 * affordance) and the inline confirmation prompts. Checked before the working
 * line, because a dialog is drawn while the turn is still open.
 */
const WAITING: RegExp[] = [
  /Some questions for you/,
  /^\s*Close ✕\s*$/m,
  /Do you want to (?:proceed|allow|continue)/i,
  /\(y\/n\)/i,
];

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

/** Rows that may sit between the status line and the prompt: borders and blanks. */
const CHROME_ROW = /^[ \t]*[│╭╮╰╯─]*[ \t]*$/;

/** How far above the prompt the status line may sit; the input box is a few rows tall. */
const MAX_CHROME_ROWS = 12;

/**
 * True when a live-turn status line sits in the chrome above the input prompt.
 * The phrase also shows up in the transcript (agent prose, or the prompt quoted
 * back), so it only counts when nothing but blank and border rows separate it
 * from the prompt -- not the explanation lines a quoted status is followed by.
 */
function statusAbovePrompt(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i += 1) {
    if (!STATUS_LINE.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && j <= i + MAX_CHROME_ROWS; j += 1) {
      if (PROMPT_LINE.test(lines[j]) || INPUT_BOX_TOP.test(lines[j])) return true;
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
  const clean = stripAnsi(text);
  if (WAITING.some((rule) => rule.test(clean))) return "waiting";
  if (statusAbovePrompt(clean.split(/\r?\n/))) return "running";
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
