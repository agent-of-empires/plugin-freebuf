// Key delivery into a session's pane.
//
// A worker cannot press keys inside the agent the way an in-process extension
// can, so it goes through tmux: the host runs every terminal session as a tmux
// session named `aoe_<slug>_<first 8 characters of the session id>`. The slug
// follows the title (or the tool) and changes, the id suffix does not, so the
// suffix is what the worker matches on.
//
// Keys are passed as separate argv words to `tmux send-keys`, and only names on
// the allowlist below are sent, so nothing a reply carries can turn into
// arbitrary input or a shell word. A typed answer is sent with `-l` (literal),
// which is what keeps a word such as "Enter" inside the text from being read as
// a key name.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasControlCharacters, type KeyStep } from "./replies.js";

const run = promisify(execFile);

/** How long one tmux call may take before the reply counts as undelivered. */
const TMUX_TIMEOUT_MS = 3_000;

/** The keys this bridge sends: navigation and a selection. */
const ALLOWED_KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Space", "Tab"]);

/** The tmux binary; overridable for unusual installs and for tests. */
export function tmuxBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.AOE_TMUX || "tmux";
}

/** The suffix every tmux session of this AoE session ends with. */
export function tmuxNameSuffix(sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return `_${sessionId.slice(0, 8)}`;
}

/**
 * The tmux session backing this AoE session, or null when none matches (the
 * session is stopped, or tmux is not installed). An ambiguous match is null
 * too: an id prefix is not unique enough to guess with.
 */
export async function resolveTmuxSession(sessionId: string, binary: string = tmuxBinary()): Promise<string | null> {
  const suffix = tmuxNameSuffix(sessionId);
  if (suffix === null) return null;
  let stdout: string;
  try {
    const result = await run(binary, ["list-sessions", "-F", "#{session_name}"], {
      timeout: TMUX_TIMEOUT_MS,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch {
    return null; // no server, no tmux, or a refused connection
  }
  const matches = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.endsWith(suffix));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * How much of a sequence reached the pane. `none` is safe to retry; `partial`
 * is not, because replaying the sequence from the start would press the keys
 * that already landed a second time (toggling an option back, typing the answer
 * twice), so the caller has to give up on that reply instead.
 */
export type DeliveryOutcome = "sent" | "partial" | "none";

export interface DeliveryOptions {
  /** The tmux binary; overridden for tests. */
  binary?: string;
  /**
   * Asked after the pane has been resolved and immediately before the first
   * key. Resolving the target is asynchronous, so the dialog the sequence was
   * built for can be gone by then, and an answer must never be pressed into a
   * different question.
   */
  confirm?: () => Promise<boolean>;
}

/** How a sequence is sent into a session's pane. */
export type KeySender = (
  sessionId: string,
  steps: readonly KeyStep[],
  options?: DeliveryOptions,
) => Promise<DeliveryOutcome>;

/** A typed answer travels as one literal word; control characters are refused. */
function sendableText(text: string): boolean {
  return text !== "" && !hasControlCharacters(text);
}

/** Send the delivery steps into one session's pane, resolving the target first. */
export async function sendKeysToPane(
  sessionId: string,
  steps: readonly KeyStep[],
  options: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const binary = options.binary ?? tmuxBinary();
  if (steps.length === 0) return "none";
  for (const step of steps) {
    const valid = "text" in step ? sendableText(step.text) : step.keys.length > 0 && step.keys.every((key) => ALLOWED_KEYS.has(key));
    if (!valid) return "none";
  }
  const target = await resolveTmuxSession(sessionId, binary);
  if (target === null) return "none";
  // The dialog may have moved on while the target was being resolved.
  const confirm = options.confirm;
  if (confirm !== undefined && !(await confirm().catch(() => false))) return "none";
  let applied = 0;
  for (const step of steps) {
    const args =
      "text" in step
        ? ["send-keys", "-t", target, "-l", "--", step.text]
        : ["send-keys", "-t", target, ...step.keys];
    try {
      await run(binary, args, { timeout: TMUX_TIMEOUT_MS, windowsHide: true });
    } catch {
      return applied === 0 ? "none" : "partial";
    }
    applied += 1;
  }
  return "sent";
}
