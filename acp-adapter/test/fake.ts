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
  /** Whatever the factory was called with, for assertions. */
  readonly meta: PaneRequest;

  constructor(meta: PaneRequest, screen = "") {
    this.meta = meta;
    this.screen = screen;
  }

  capture(): Promise<string> {
    this.captures += 1;
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
