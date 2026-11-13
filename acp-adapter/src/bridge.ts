// The TUI bridge: drives one prompt turn against a pane and reports what the
// pane shows as ACP `session/update` chunks.
//
// Because Freebuff is a TUI with no headless mode, a turn is heuristic:
//   1. wait for the TUI to settle at its prompt (a prompt typed during startup
//      is dropped), then snapshot the screen as the diff baseline,
//   2. type the prompt, send Enter, and wait for the user's message to reach the
//      transcript so that copy is dropped from the diff,
//   3. poll the pane, streaming every newly appended bit of *transcript* text:
//      the TUI's own chrome (input box, status line, ads, footer) is cut out,
//   4. finish with `end_turn` once the transcript has been quiet for
//      `quiescenceMs` and the status line no longer says the agent is working,
//      or with `cancelled` when `session/cancel` interrupts it.

import type { StopReason } from "@agentclientprotocol/sdk";
import {
  ScreenTracker,
  diffScreens,
  extractTranscript,
  isPromptVisible,
  isWorkingScreen,
  normalizeScreen,
} from "./screen.ts";
import type { PaneSource } from "./pane.ts";

export const INTERRUPT_KEY = "C-c";
export const SUBMIT_KEY = "Enter";

export type BridgeConfig = {
  /** Delay between `capture-pane` polls. */
  pollIntervalMs: number;
  /** Quiet window that ends the turn with `end_turn`. */
  quiescenceMs: number;
  /** How long to wait for the TUI to echo the prompt before giving up on suppressing it. */
  echoTimeoutMs: number;
  /**
   * Cap on the capture loop of a turn; a blocked pane (e.g. a modal) ends here.
   * The readiness wait before the prompt is typed runs on its own budget.
   */
  maxTurnMs: number;
  /** How long to wait for the TUI to settle at its prompt before typing. */
  startupTimeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "now" | "sleep"> = {
  pollIntervalMs: 250,
  quiescenceMs: 2_000,
  echoTimeoutMs: 10_000,
  maxTurnMs: 300_000,
  startupTimeoutMs: 90_000,
};

/**
 * Identical ready screens needed before typing. Freebuff paints its input box
 * while it is still starting up (and swapping models), and keystrokes sent in
 * that window are dropped, so a single sighting of the prompt is not enough.
 */
export const READY_STABLE_CAPTURES = 3;

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

  // Type only once the TUI is up and steady. Without this the prompt is sent
  // into a still-painting startup screen and silently dropped.
  const readiness = await waitForReady(pane, config, () => events.isCancelled());
  if (readiness === "cancelled") {
    return { stopReason: "cancelled", streamedChars };
  }
  if (readiness === "timeout") {
    throw new Error(NOT_READY);
  }

  const baseline = await pane.capture();
  // The capture can take a while; a cancel that landed during it must not be
  // followed by typing the prompt.
  if (events.isCancelled()) {
    return { stopReason: "cancelled", streamedChars };
  }
  const baselineRows = extractTranscript(baseline);
  const tracker = new ScreenTracker(baseline);

  let sawChange = false;
  let lastChangeAt = config.now();
  let firstChunk = true;
  const deliver = async (text: string): Promise<void> => {
    // New screen lines carry a leading newline for reconstruction; the very
    // first chunk has nothing before it, so drop the separator.
    const out = firstChunk && text.startsWith("\n") ? text.slice(1) : text;
    if (out === "") return;
    firstChunk = false;
    sawChange = true;
    lastChangeAt = config.now();
    await events.onChunk(out);
    streamedChars += out.length;
  };

  // Type the prompt as literal text, then submit it. The literal flag matters:
  // unquoted tmux send-keys would read words such as "Enter" inside the prompt
  // as key names.
  await pane.send(promptText, { literal: true });
  await pane.send(SUBMIT_KEY);

  // Wait for the TUI to echo the prompt into the transcript so it is not
  // streamed back as assistant output. The search runs over the transcript, not
  // the whole screen: the composer echoes the text the instant it is typed, and
  // the user's message only reaches the transcript on submit, which is the copy
  // that must be suppressed. If no echo ever appears, the original baseline is
  // kept and nothing is skipped.
  // Every non-empty line, since a prompt may start with a blank line and an
  // empty needle suppresses nothing, and because a multi-line prompt is echoed
  // as several rows: stopping at the first one streamed the rest of the user's
  // message back as assistant output.
  const echoLines = promptText
    .split("\n")
    .map((line) => line.trim())
    .map(collapse)
    .filter((line) => line !== "");
  // The TUI wraps a long prompt over several rows, so the echo has to be found
  // in whitespace-collapsed text: a source line never matches the rows as they
  // are drawn.
  const echoNeedle = echoLines[0] ?? "";
  // The rows drawn since the baseline, which is where the echo has to appear. A
  // count over the whole transcript would miss it whenever an older copy of the
  // same prompt scrolled off the top as the new one was drawn.
  const rowsSinceBaseline = (screen: string): string[] => {
    const delta = diffScreens(baselineRows, extractTranscript(screen));
    return delta === "" ? [] : delta.split("\n");
  };
  // Null while the echo is not visible yet or still being drawn; otherwise the
  // rows after the complete echo (an answer can be drawn in the same capture,
  // and it has to be streamed).
  const rowsAfterEcho = (screen: string): string[] | null => {
    if (echoNeedle === "") return null;
    const rows = rowsSinceBaseline(screen);
    let seen = "";
    let start = -1;
    for (let i = 0; i < rows.length && start === -1; i++) {
      seen += collapse(rows[i]);
      const at = seen.indexOf(echoNeedle);
      if (at !== -1) {
        start = i;
        // Whatever followed the first line inside the same row is the start of
        // the rest of the prompt, or the answer when the prompt is one line.
        seen = seen.slice(at + echoNeedle.length);
      }
    }
    if (start === -1) return null;
    // The remaining lines of a multi-line prompt, joined with no separator
    // because the TUI wraps mid-token: the echo is complete once the rows drawn
    // since the first line account for them in order.
    const rest = echoLines.slice(1).join("");
    let echoed = seen;
    let last = start;
    while (last + 1 < rows.length && echoed !== rest) {
      if (!rest.startsWith(echoed)) break;
      last += 1;
      echoed += collapse(rows[last]);
    }
    if (echoed === rest) return rows.slice(last + 1);
    if (rest.startsWith(echoed)) {
      // The echo is still being drawn. Waiting keeps the suppressed rows whole;
      // the echo deadline covers a prompt whose tail never appears at all.
      return null;
    }
    // The answer started in the same row as the last echo character: keep that
    // row's tail, which is assistant text, and drop only what came before it.
    const excess = echoed.length - rest.length;
    let cut = rows[last].length;
    for (let dropped = 0; dropped < excess && cut > 0; cut--) {
      if (collapse(rows[last][cut - 1]) !== "") dropped += 1;
    }
    return [rows[last].slice(cut), ...rows.slice(last + 1)];
  };
  // Still waiting for the echo: the main loop keeps watching for it, because a
  // long prompt can take longer to reach the transcript than the initial window
  // and the echo would otherwise be streamed back as assistant output.
  let echoPending = echoLines.length > 0;
  // The echo has arrived, possibly with the answer's first rows drawn below it:
  // rebase the tracker on this screen so the user's own message is not streamed
  // back, and stream what came after it rather than losing it.
  const settleEcho = async (screen: string, after: string[]): Promise<void> => {
    tracker.reset(screen);
    echoPending = false;
    await deliver(after.join("\n"));
  };
  const echoDeadline = config.now() + config.echoTimeoutMs;
  while (echoPending && config.now() < echoDeadline) {
    if (events.isCancelled()) {
      break;
    }
    const screen = await pane.capture();
    const after = rowsAfterEcho(screen);
    if (after !== null) {
      await settleEcho(screen, after);
      break;
    }
    await config.sleep(config.pollIntervalMs);
  }

  const deadline = config.now() + config.maxTurnMs;
  let permissionNoticed = false;

  while (config.now() < deadline) {
    if (events.isCancelled()) {
      return { stopReason: "cancelled", streamedChars };
    }

    const screen = await pane.capture();
    const afterEcho = echoPending ? rowsAfterEcho(screen) : null;
    if (afterEcho !== null) {
      // The echo arrived after the initial window closed.
      await settleEcho(screen, afterEcho);
      await config.sleep(config.pollIntervalMs);
      continue;
    }
    await deliver(tracker.update(screen));

    if (!permissionNoticed) {
      // The whole normalized screen, not just the transcript: a modal can be
      // drawn as a bordered box in the bottom chrome, which the transcript cut
      // removes, and then the prompt would be missed.
      const pattern = findPermissionPrompt(normalizeScreen(screen).join("\n"));
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

    // A pause in the transcript is not a finished turn while the status line
    // still says the agent is working.
    if (sawChange && !isWorkingScreen(screen) && config.now() - lastChangeAt >= config.quiescenceMs) {
      return { stopReason: "end_turn", streamedChars };
    }
    await config.sleep(config.pollIntervalMs);
  }

  // The pane never went quiet (or never changed at all): report the turn as
  // finished rather than hanging the client forever.
  return { stopReason: "end_turn", streamedChars };
}

/** Why the wait for a usable TUI ended. */
type Readiness = "ready" | "cancelled" | "timeout";

/** Error text for a pane that never reached its composer. */
const NOT_READY = "the Freebuff pane never showed its input prompt";

/**
 * Polls until the TUI shows its prompt and the screen has stopped changing.
 *
 * A timeout is a failure rather than a ready screen: the wait exists because
 * keystrokes sent into a startup screen or a modal are silently dropped, so
 * typing at the deadline would send the prompt nowhere.
 */
async function waitForReady(
  pane: PaneSource,
  config: BridgeConfig,
  isCancelled: () => boolean,
): Promise<Readiness> {
  const deadline = config.now() + config.startupTimeoutMs;
  let previous: string | null = null;
  let stable = 0;
  for (;;) {
    // Cancellation wins over readiness: a prompt that arrives after the host
    // gave up must not be typed into the pane.
    if (isCancelled()) return "cancelled";
    const screen = await pane.capture();
    if (isCancelled()) return "cancelled";
    const ready = isPromptVisible(normalizeScreen(screen));
    // Compare the transcript, not the raw capture: the footer, the rotating ad
    // box and the status line repaint constantly, and one changed byte there
    // would reset the count forever.
    const settled = extractTranscript(screen).join("\n");
    if (ready) {
      // The first ready capture counts as one, so three captures at a settled
      // composer are enough instead of four.
      stable = previous !== null && settled === previous ? stable + 1 : 1;
      if (stable >= READY_STABLE_CAPTURES) return "ready";
    } else {
      stable = 0;
    }
    previous = settled;
    if (config.now() >= deadline) return "timeout";
    await config.sleep(config.pollIntervalMs);
  }
}

/**
 * Text reduced to the characters worth matching: whitespace runs (a wrapped row
 * breaks the line where the source had a space) and decoration glyphs (the copy
 * badge can sit mid-message once the TUI wraps it) both go.
 */
function collapse(text: string): string {
  return text.replace(/[\s⎘•·△▽✕]/gu, "");
}
