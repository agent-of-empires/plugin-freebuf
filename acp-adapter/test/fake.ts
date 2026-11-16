// Test doubles: a scripted pane (no tmux, no freebuff) and a fake clock so the
// bridge's polling/quiescence logic runs deterministically without timers.

import type { PaneFactory, PaneRequest, SendOptions, SessionPane } from "../src/pane.ts";

/**
 * A minimal stand-in for Freebuff's settled screen: a transcript row above the
 * input box, then the housekeeping rows the bridge must not stream (status
 * line, footer). Shaped like the real thing so the chrome cut is exercised.
 */
export const READY_SCREEN = [
  "  freebuff",
  "",
  "╭──────────────────────────────╮",
  "│                              │",
  "│  ▍Enter a coding task        │",
  "│                              │",
  "╰──────────────────────────────╯",
  " DeepSeek V4.1 Flash Slow · /tmp · Chat: New chat",
  " ← for history · ? for help",
].join("\n");

/**
 * Builds a settled screen out of the given transcript rows: anything a test
 * wants on screen, with the real composer box below it, so the readiness wait
 * and the chrome cut see the shape the TUI actually draws.
 */
export function composerScreen(...rows: string[]): string {
  return [...rows, "", ...READY_SCREEN.split("\n").slice(2)].join("\n");
}

/**
 * Models the TUI accepting a submit, which is what tells `runTurn` the prompt
 * left the composer: the TUI takes the text out of the composer box and starts
 * the turn. Only the composer's own row is rewritten, so the transcript rows a
 * test is watching stay exactly as scripted. Call this after setting
 * `pane.onSend`, since it wraps it.
 */
export function acceptsSubmit(pane: FakePane): void {
  const inner = pane.onSend;
  pane.onSend = (keys, options) => {
    inner?.(keys, options);
    if (options?.literal || keys !== "Enter") return;
    pane.screen = drawDraft(pane.screen, "");
  };
}
/**
 * The screen with `draft` typed into the composer, the way the TUI draws what it
 * has been sent. The composer row is rewritten in place so the transcript rows
 * above it, which tests script and assert on, stay exactly as they were.
 */
export function drawDraft(screen: string, draft: string): string {
  const rows = screen.split("\n");
  const index = rows.findIndex((row) => row.includes("▍"));
  if (index === -1) return screen;
  // The text is written whole rather than clipped to the box's width: the
  // bridge compares the composer against the prompt it typed, and clipping would
  // drop the tail a long prompt is matched on.
  rows[index] = `│  ▍${draft}│`;
  return rows.join("\n");
}

/**
 * A settled screen whose composer holds `draft`: the shape the TUI draws while a
 * prompt is typed but not yet submitted. `composerScreen` puts its rows in the
 * transcript instead, where the composer's text never reaches, so a draft built
 * with it would read as already submitted.
 */
export function draftScreen(draft: string, footer = "← for history · ? for help"): string {
  return [
    "  freebuff",
    "",
    "╭──────────────────────────────╮",
    "│                              │",
    `│  ▍${draft}`,
    "│                              │",
    "╰──────────────────────────────╯",
    " DeepSeek V4.1 Flash Slow · /tmp · Chat: chat",
    ` ${footer}`,
  ].join("\n");
}

/**
 * A settled screen whose composer holds `draft` wrapped over the box's rows the
 * way the TUI wraps it: the first row carries the prompt glyph and the rows below
 * continue the text, each framed by the box's own border column. A real prompt
 * longer than one row is exactly what the whole-screen comparison could not see
 * past, so a test that wants a long draft has to draw it like this.
 */
export function wrappedDraftScreen(draft: string, footer = "← for history · ? for help"): string {
  const inner = READY_SCREEN.split("\n")[2].length - 2;
  const rows: string[] = [];
  let rest = draft;
  let prefix = "  ▍";
  do {
    const width = inner - prefix.length;
    rows.push(`│${`${prefix}${rest.slice(0, width)}`.padEnd(inner)}│`);
    rest = rest.slice(width);
    prefix = "  ";
  } while (rest !== "");
  return [
    "  freebuff",
    "",
    "╭──────────────────────────────╮",
    "│                              │",
    ...rows,
    "│                              │",
    "╰──────────────────────────────╯",
    " DeepSeek V4.1 Flash Slow · /tmp · Chat: chat",
    ` ${footer}`,
  ].join("\n");
}

/** Deterministic clock: `sleep` advances virtual time instead of waiting. */
export class FakeClock {
  time = 0;
  /** Invoked after every virtual sleep with the new virtual time. */
  onAdvance?: (time: number) => void;

  now = (): number => this.time;

  sleep = async (ms: number): Promise<void> => {
    this.time += ms;
    this.onAdvance?.(this.time);
    await Promise.resolve();
  };
}

export type SentKeys = { keys: string; options?: SendOptions };

/** A pane backed by a mutable screen string and a recorded send log. */
export class FakePane implements SessionPane {
  screen: string;
  /**
   * Whether a literal send draws the text into the composer, as the TUI does.
   * Turned off to model a pane that has not painted the draft yet.
   */
  drawsTyping = true;
  captures = 0;
  sent: SentKeys[] = [];
  stopped = false;
  /** Hook invoked on every `send`, used to model the TUI echoing a prompt. */
  onSend?: (keys: string, options?: SendOptions) => void;
  /** Hook invoked on every `capture`, used to model events during a poll. */
  onCapture?: () => void;
  /** Whatever the factory was called with, for assertions. */
  readonly meta: PaneRequest;

  constructor(meta: PaneRequest, screen = "") {
    this.meta = meta;
    this.screen = screen;
  }

  capture(): Promise<string> {
    this.captures += 1;
    this.onCapture?.();
    return Promise.resolve(this.screen);
  }

  send(keys: string, options?: SendOptions): Promise<void> {
    this.sent.push({ keys, options });
    if (options?.literal && this.drawsTyping) this.screen = drawDraft(this.screen, keys);
    this.onSend?.(keys, options);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

/**
 * Pane factory that records every pane it created. `configure` runs on each new
 * pane before it is handed back, so behaviour can be scripted without having to
 * grab the pane afterwards.
 */
export function fakePaneFactory(
  initialScreen = READY_SCREEN,
  configure?: (pane: FakePane) => void,
): {
  factory: PaneFactory;
  panes: FakePane[];
} {
  const panes: FakePane[] = [];
  const factory: PaneFactory = async (request) => {
    const pane = new FakePane(request, initialScreen);
    panes.push(pane);
    configure?.(pane);
    return pane;
  };
  return { factory, panes };
}
