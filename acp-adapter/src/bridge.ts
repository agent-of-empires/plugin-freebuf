// The TUI bridge: drives one prompt turn against a pane and reports what the
// pane shows as ACP `session/update` chunks.
//
// Because Freebuff is a TUI with no headless mode, a turn is heuristic:
//   1. snapshot the screen, type the prompt, send Enter,
//   2. wait for the TUI to echo the prompt and drop that echo from the diff,
//   3. poll the pane, streaming every newly appended bit of text,
//   4. finish with `end_turn` once the screen has been quiet for
//      `quiescenceMs`, or with `cancelled` when `session/cancel` interrupts it.

import type { StopReason } from "@agentclientprotocol/sdk";
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
    await clearTypedPrompt(pane, Array.from(promptText).length);
    return { stopReason: "cancelled", streamedChars };
  }
  await pane.send(SUBMIT_KEY);

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
      tracker.reset(screen);
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
 * Delete the text this turn typed, so a stopped turn leaves no draft behind.
 *
 * The prompt is then known exactly -- it is what this turn typed -- so removing
 * it one character at a time needs no assumption about a clear-line binding the
 * TUI may not have. The count is in code points, not `String.length`: a prompt
 * holding an astral character such as an emoji would otherwise get two
 * backspaces for one character and delete text typed before this turn.
 */
async function clearTypedPrompt(pane: PaneSource, length: number): Promise<void> {
  for (let i = 0; i < length; i += 1) {
    await pane.send(CLEAR_KEY);
  }
}
