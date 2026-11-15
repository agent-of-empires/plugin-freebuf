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
 * Models the TUI reacting to a submit, which is what tells `runTurn` the prompt
 * left the composer: an unchanged screen after Enter reads as a lost submit, so
 * the press is retried and then the turn fails. The caret is flipped rather than
 * the draft cleared, so the transcript rows a test is watching stay as scripted.
 * Call this after setting `pane.onSend`, since it wraps it.
 */
export function acceptsSubmit(pane: FakePane): void {
  const inner = pane.onSend;
  pane.onSend = (keys, options) => {
    inner?.(keys, options);
    if (options?.literal || keys !== "Enter") return;
    // Toggling a character on the last row is enough of a change to read as a
    // reaction. It is not whitespace, which the normalization drops, and it
    // touches neither the picker caret nor the footer title, both of which the
    // bridge parses.
    const rows = pane.screen.split("\n");
    const last = rows.length - 1;
    rows[last] = rows[last].endsWith(".") ? rows[last].slice(0, -1) : `${rows[last]}.`;
    pane.screen = rows.join("\n");
  };
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
