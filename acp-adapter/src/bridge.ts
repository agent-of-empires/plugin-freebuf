// The TUI bridge: drives one prompt turn against a pane and reports what the
// pane shows as ACP `session/update` chunks.
//
// Because Freebuff is a TUI with no headless mode, a turn is heuristic:
//   1. wait for the TUI to settle at its prompt (a prompt typed during startup
//      is dropped), then snapshot the screen as the diff baseline,
//   2. type the prompt, send Enter, and wait for the user's message to reach the
//      transcript so that copy is dropped from the diff,
//   3. poll the pane, streaming every newly appended bit of *transcript* text --
//      the TUI's own chrome (input box, status line, ads, footer) is cut out,
//   4. finish with `end_turn` once the transcript has been quiet for
//      `quiescenceMs` and the status line no longer says the agent is working,
//      or with `cancelled` when `session/cancel` interrupts it.

import type { StopReason } from "@agentclientprotocol/sdk";
import {
  ScreenTracker,
  chatHistoryRows,
  chatTitle,
  extractTranscript,
  isChatHistoryScreen,
  isPromptVisible,
  isWorkingScreen,
  normalizeScreen,
  splitTranscriptMessages,
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
  /** Hard cap on a whole turn; a blocked pane (e.g. a modal) ends here. */
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
  const tracker = new ScreenTracker(baseline);

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
  const promptNeedle = promptText.split("\n")[0].trim();
  // The TUI wraps a long prompt over several rows, so the echo has to be found
  // in whitespace-collapsed text: the needle is one source line and never
  // matches the rows as they are drawn.
  const echoNeedle = collapse(promptNeedle);
  // A prompt the user has sent before is already in the transcript, so finding
  // the needle is not enough: the echo is the one occurrence past the baseline.
  const baselineEchoes = echoNeedle === "" ? 0 : occurrences(collapse(transcriptText(baseline)), echoNeedle);
  const echoed = (screen: string): boolean => {
    if (echoNeedle === "") return false;
    return occurrences(collapse(transcriptText(screen)), echoNeedle) > baselineEchoes;
  };
  // Still waiting for the echo: the main loop keeps watching for it, because a
  // long prompt can take longer to reach the transcript than the initial window
  // and the echo would otherwise be streamed back as assistant output.
  let echoPending = echoNeedle !== "";
  const echoDeadline = config.now() + config.echoTimeoutMs;
  while (echoPending && config.now() < echoDeadline) {
    if (events.isCancelled()) {
      break;
    }
    const screen = await pane.capture();
    if (echoed(screen)) {
      tracker.reset(screen);
      echoPending = false;
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
    if (echoPending && echoed(screen)) {
      // The echo arrived late: rebase on it instead of streaming the user's own
      // message back as assistant output.
      tracker.reset(screen);
      echoPending = false;
      await config.sleep(config.pollIntervalMs);
      continue;
    }
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
      const pattern = findPermissionPrompt(transcriptText(screen));
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

export type ResumeResult = {
  /** True when the pane is showing the chat that was asked for. */
  restored: boolean;
  /** Title of the chat the pane now has open, when it shows one. */
  title: string | null;
  /** The restored conversation, as messages a host can replay. */
  messages: { role: "user" | "agent"; text: string }[];
};

/** How long to wait for the `/history` picker to open, list rows, and close. */
export const RESUME_PICKER_TIMEOUT_MS = 15_000;

export type ResumeRequest = {
  pane: PaneSource;
  config: BridgeConfig;
  /** Title recorded for this session; null when the adapter never saw it. */
  title: string | null;
};

/**
 * Reopens a conversation in a freshly started pane and reports what it shows.
 *
 * `session/new` with `--continue` reopens the working directory's most recent
 * chat, which is usually the right one but not always: a directory can hold
 * several chats. When the recorded title does not match what came up, the TUI's
 * own `/history` picker is used to select the recorded chat instead.
 */
export async function resumeChat(request: ResumeRequest): Promise<ResumeResult> {
  const { pane, config, title: expected } = request;
  if ((await waitForReady(pane, config, () => false)) === "timeout") {
    throw new Error(NOT_READY);
  }

  let screen = await pane.capture();
  let title = chatTitle(screen);
  if (expected === null || titleMatches(title, expected)) {
    return { restored: expected === null || titleMatches(title, expected), title, messages: resumedMessages(screen) };
  }

  // Pick the chat out of the TUI's history list instead.
  await pane.send("/history", { literal: true });
  await pane.send(SUBMIT_KEY);
  const deadline = config.now() + RESUME_PICKER_TIMEOUT_MS;
  let rows: string[] = [];
  while (config.now() < deadline) {
    const listing = await pane.capture();
    if (isChatHistoryScreen(listing)) {
      rows = chatHistoryRows(listing);
      if (rows.length > 0) break;
    }
    await config.sleep(config.pollIntervalMs);
  }

  const index = rows.findIndex((row) => titleMatches(row, expected, "row"));
  if (index < 0) {
    // Nothing matched: close the picker and keep whatever chat is open.
    await pane.send("Escape");
    return { restored: false, title: chatTitle(screen), messages: resumedMessages(screen) };
  }
  for (let i = 0; i < index; i++) {
    await pane.send("Down");
  }
  await pane.send(SUBMIT_KEY);
  if ((await waitForReady(pane, config, () => false)) === "timeout") {
    throw new Error(NOT_READY);
  }
  screen = await pane.capture();
  title = chatTitle(screen);
  return { restored: titleMatches(title, expected), title, messages: resumedMessages(screen) };
}

/**
 * Compares a chat title from the TUI with a recorded one.
 *
 * The picker truncates long titles to its column width, so there a prefix
 * counts as a match. The footer has room for the whole title, so comparing it
 * as a prefix would accept a different chat whose name merely starts the same
 * way (`Fix tests` vs `Fix tests on macOS`) and replay its conversation.
 */
function titleMatches(actual: string | null, expected: string, mode: "footer" | "row" = "footer"): boolean {
  if (actual === null) return false;
  const a = actual.trim();
  const b = expected.trim();
  if (a === "" || b === "") return false;
  if (mode === "footer") return a === b;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function resumedMessages(screen: string): { role: "user" | "agent"; text: string }[] {
  return splitTranscriptMessages(extractTranscript(screen));
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
    if (ready && previous !== null && screen === previous) {
      stable += 1;
      if (stable >= READY_STABLE_CAPTURES) return "ready";
    } else {
      stable = 0;
    }
    previous = screen;
    if (config.now() >= deadline) return "timeout";
    await config.sleep(config.pollIntervalMs);
  }
}

/** The transcript text of a raw capture, joined for substring matching. */
function transcriptText(raw: string): string {
  return extractTranscript(raw).join("\n");
}

/**
 * Text reduced to the characters worth matching: whitespace runs (a wrapped row
 * breaks the line where the source had a space) and decoration glyphs (the copy
 * badge can sit mid-message once the TUI wraps it) both go.
 */
function collapse(text: string): string {
  return text.replace(/[\s⎘•·△▽✕]/gu, "");
}

/** How many times `needle` appears in `haystack` (both already collapsed). */
function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
