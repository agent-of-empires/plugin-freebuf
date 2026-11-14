// The TUI bridge: drives one prompt turn against a pane and reports what the
// pane shows as ACP `session/update` chunks.
//
// Because Freebuff is a TUI with no headless mode, a turn is heuristic:
//   1. snapshot the screen, type the prompt, send Enter,
//   2. wait for the TUI to echo the prompt and drop that echo from the diff,
//   3. poll the pane, streaming every newly appended bit of text,
//   4. finish with `end_turn` once the screen has been quiet for
//      `quiescenceMs`, or with `cancelled` when `session/cancel` interrupts it.

import { RequestError, type StopReason } from "@agentclientprotocol/sdk";
import { ScreenTracker, normalizeScreen } from "./screen.ts";
import type { PaneSource } from "./pane.ts";

export const INTERRUPT_KEY = "C-c";
export const SUBMIT_KEY = "Enter";
const CLEAR_KEY = "BSpace";

export type BridgeConfig = {
  /** Delay between `capture-pane` polls. */
  pollIntervalMs: number;
  /** Quiet window that ends the turn with `end_turn`. */
  quiescenceMs: number;
  /** How long to wait for the TUI to echo the prompt before giving up on suppressing it. */
  echoTimeoutMs: number;
  /** Hard cap on a whole turn; a blocked pane (e.g. a modal) ends here. */
  maxTurnMs: number;
  /**
   * Pause between typing the prompt and pressing Enter. Freebuff's input
   * handler treats text that arrives with an Enter in the same burst as a
   * paste and drops the Enter, so the two must not be sent back to back.
   */
  submitDelayMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "now" | "sleep"> = {
  pollIntervalMs: 250,
  quiescenceMs: 2_000,
  echoTimeoutMs: 2_000,
  maxTurnMs: 300_000,
  submitDelayMs: 150,
};

/**
 * Most presses of Enter one turn will make. A TUI can swallow the first one
 * (its paste-burst window has not expired, or it is still settling), and
 * nothing downstream notices: the prompt just sits in the composer and the
 * turn never starts. Retrying is bounded so a pane holding a modal cannot be
 * spammed with blank submits.
 */
export const MAX_SUBMIT_ATTEMPTS = 3;

/** Real-time clock helpers used outside of tests. */
export function systemClock(): Pick<BridgeConfig, "now" | "sleep"> {
  return {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export type TurnNotice = {
  severity: "info" | "warning" | "error";
  title: string;
  description?: string | null;
};

export type TurnEvents = {
  /** Called with each piece of newly visible assistant output; may return a write to await. */
  onChunk(text: string): void | Promise<void>;
  /** Called at most once per turn when a permission prompt is spotted on screen. */
  onNotice(notice: TurnNotice): void | Promise<void>;
  /** True once the turn should stop with `cancelled`. */
  isCancelled(): boolean;
};

export type TurnResult = {
  stopReason: StopReason;
  /** Total characters streamed as `agent_message_chunk` text. */
  streamedChars: number;
};

/**
 * Conservative patterns for a modal permission/confirmation prompt in the
 * Freebuff TUI. They are deliberately rare matches: a miss only means the
 * limitation notice is never shown.
 */
export const PERMISSION_PROMPT_PATTERNS: readonly RegExp[] = [
  /\by\/n\b/i,
  /\[\s*y\s*\/\s*n\s*\]/i,
  /\bdo you want to (?:allow|trust|proceed)\b/i,
  /\bpermission (?:requested|required|prompt)\b/i,
];

/** Returns the matched pattern when the screen shows a recognized permission prompt. */
export function findPermissionPrompt(screenText: string): RegExp | null {
  for (const pattern of PERMISSION_PROMPT_PATTERNS) {
    if (pattern.test(screenText)) {
      return pattern;
    }
  }
  return null;
}

export type RunTurnRequest = {
  pane: PaneSource;
  promptText: string;
  config: BridgeConfig;
  events: TurnEvents;
};

/** Runs one prompt turn to completion and reports why it stopped. */
export async function runTurn(request: RunTurnRequest): Promise<TurnResult> {
  const { pane, promptText, config, events } = request;
  let streamedChars = 0;

  const baseline = await pane.capture();
  const tracker = new ScreenTracker(baseline);

  // Type the prompt as literal text, then submit it. The literal flag matters:
  // unquoted tmux send-keys would read words such as "Enter" inside the prompt
  // as key names.
  await pane.send(promptText, { literal: true });
  // Let the typed text settle before pressing Enter. Sent in one burst, the
  // Enter lands inside the TUI's paste window and is discarded, which looks
  // exactly like a turn that started when it did not: the prompt stays in the
  // composer and the screen never changes.
  await config.sleep(config.submitDelayMs);
  // A cancel during the pause must not be followed by a submit: the user asked
  // for the turn to stop, and pressing Enter would start one anyway.
  if (events.isCancelled()) {
    // The prompt is already typed, so stopping here would leave a draft in the
    // composer, and the next turn's prompt would be typed onto it and submitted
    // together with it.
    await clearDraft(pane, promptText, null);
    return { stopReason: "cancelled", streamedChars };
  }
  const typedScreen = await pane.capture();
  const typedView = normalizeJoined(typedScreen);
  if (events.isCancelled()) {
    await clearDraft(pane, promptText, null);
    return { stopReason: "cancelled", streamedChars };
  }
  await pane.send(SUBMIT_KEY);

  // A submit can still be lost, so press Enter again while the screen is
  // unchanged: the TUI reacts the moment the prompt is really submitted.
  let submitted = false;
  let submitAttempts = 1;
  const submitDeadline = config.now() + config.echoTimeoutMs;
  // Space the presses across the whole budget instead of one per poll: at the
  // poll interval three presses land in the first few hundred milliseconds, so
  // a pane that accepts the first Enter late gets two more and a false "not
  // submitted" while the turn it started is running.
  const retryIntervalMs = Math.ceil(config.echoTimeoutMs / MAX_SUBMIT_ATTEMPTS);
  let lastSubmitAt = config.now();
  while (config.now() < submitDeadline) {
    const remainingMs = submitDeadline - config.now();
    await config.sleep(Math.min(config.pollIntervalMs, remainingMs));
    if (events.isCancelled()) break;
    const screen = await pane.capture();
    if (normalizeJoined(screen) !== typedView) {
      submitted = true; // the TUI reacted: the prompt left the composer
      break;
    }
    // Out of attempts: keep watching until the deadline, in case a press lands
    // late, rather than failing the turn before the budget is spent.
    if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) continue;
    if (config.now() - lastSubmitAt < retryIntervalMs) continue;
    submitAttempts += 1;
    lastSubmitAt = config.now();
    await pane.send(SUBMIT_KEY);
  }

  if (events.isCancelled()) {
    await clearDraft(pane, promptText, typedView);
    return { stopReason: "cancelled", streamedChars };
  }
  // A composer that still holds the typed prompt never accepted the submit.
  // Continuing here would be the original bug in a quieter form: the echo
  // check would match the prompt in the composer, the screen would then stay
  // still, and the turn would report `end_turn` for work that never started.
  if (!submitted) {
    // Leaving the draft behind would corrupt the next turn: its prompt would be
    // typed after it and one Enter would submit both.
    await clearDraft(pane, promptText, typedView);
    throw new RequestError(
      -32000,
      `the prompt was not submitted: the composer did not accept ${SUBMIT_KEY} after ${submitAttempts} attempts`,
    );
  }

  // Wait for the TUI to echo the prompt so it is not streamed back as
  // assistant output. If no echo ever appears, the original baseline is kept
  // and nothing is skipped.
  const promptNeedle = promptText.split("\n")[0].trim();
  const echoDeadline = config.now() + config.echoTimeoutMs;
  while (config.now() < echoDeadline) {
    if (events.isCancelled()) {
      break;
    }
    const screen = await pane.capture();
    if (promptNeedle !== "" && normalizeJoined(screen).includes(promptNeedle)) {
      // When the prompt was already in the composer at submit time, everything
      // else on screen now is output this turn wrote, so the baseline goes back
      // to the typed view. Resetting to the current screen would drop it, which
      // on a slow pane is the turn's first output.
      tracker.reset(typedView.includes(promptNeedle) ? typedScreen : screen);
      break;
    }
    await config.sleep(config.pollIntervalMs);
  }

  const deadline = config.now() + config.maxTurnMs;
  let sawChange = false;
  let lastChangeAt = config.now();
  let permissionNoticed = false;
  let firstChunk = true;

  while (config.now() < deadline) {
    if (events.isCancelled()) {
      await clearDraft(pane, promptText, typedView);
      return { stopReason: "cancelled", streamedChars };
    }

    const screen = await pane.capture();
    const delta = tracker.update(screen);
    if (delta !== "") {
      // New screen lines carry a leading newline for reconstruction; the very
      // first one has nothing before it, so drop the separator.
      const text = firstChunk && delta.startsWith("\n") ? delta.slice(1) : delta;
      if (text !== "") {
        firstChunk = false;
        sawChange = true;
        lastChangeAt = config.now();
        await events.onChunk(text);
        streamedChars += text.length;
      }
    }

    if (!permissionNoticed) {
      const pattern = findPermissionPrompt(normalizeJoined(screen));
      if (pattern !== null) {
        permissionNoticed = true;
        await events.onNotice({
          severity: "warning",
          title: "Permission prompts are not bridged",
          description:
            "A confirmation prompt is visible in the Freebuff TUI. This adapter cannot answer it; " +
            "switch to the Freebuff window to respond. Matched: " +
            String(pattern),
        });
      }
    }

    if (sawChange && config.now() - lastChangeAt >= config.quiescenceMs) {
      return { stopReason: "end_turn", streamedChars };
    }
    await config.sleep(config.pollIntervalMs);
  }

  // The pane never went quiet (or never changed at all): report the turn as
  // finished rather than hanging the client forever.
  return { stopReason: "end_turn", streamedChars };
}

function normalizeJoined(raw: string): string {
  return normalizeScreen(raw).join("\n");
}

/**
 * Delete the text this turn typed, so a stopped or failed turn leaves no draft.
 *
 * One step for every exit, because each of them has to undo the same typing. The
 * prompt is known exactly -- it is what this turn typed -- so removing it one
 * character at a time needs no assumption about a clear-line binding the TUI may
 * not have. The count is in code points, not `String.length`: a prompt holding an
 * astral character such as an emoji would otherwise get two backspaces for one
 * character and delete text typed before this turn.
 *
 * `typedView` is the composer with the prompt typed. Once the screen has moved
 * on, the prompt is gone from the composer and the turn is writing output there,
 * so clearing would delete the turn's own text. Pass `null` while Enter has not
 * been pressed, when the draft is certainly still there.
 */
async function clearDraft(
  pane: PaneSource,
  promptText: string,
  typedView: string | null,
): Promise<void> {
  if (typedView !== null && normalizeJoined(await pane.capture()) !== typedView) {
    return;
  }
  const length = Array.from(promptText).length;
  for (let i = 0; i < length; i += 1) {
    await pane.send(CLEAR_KEY);
  }
}
