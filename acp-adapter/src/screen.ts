// Screen normalization and incremental pane diffing.
//
// The bridge polls the tmux pane and gets a full-screen snapshot every time.
// Only the text that appeared since the previous snapshot may be streamed to
// the ACP client, so snapshots are normalized to plain-text lines and diffed
// line by line (common prefix/suffix trimming plus an LCS over the middle).
// That covers the three shapes a terminal produces: rows appended at the
// bottom, rows scrolled off the top, and a single row rewritten in place
// (spinners, progress counters) — the last one must not re-emit the screen.

import { stripAnsi } from "./ansi.ts";

/**
 * Reduces one raw pane capture to the normalized lines used for comparison:
 * escape sequences removed, carriage returns dropped, trailing whitespace
 * trimmed, and trailing blank rows dropped (tmux pads the pane to a fixed
 * height with blank rows).
 */
export function normalizeScreen(raw: string): string[] {
  const lines = stripAnsi(raw)
    .split("\n")
    .map((line) => line.replace(/\r/g, "").replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

type LineOp = { kind: "eq" | "del" | "ins"; line: string };

// Above this many cells the DP table would get large; fall back to treating
// the whole differing block as replaced (defensive: panes are far smaller).
const MAX_DP_CELLS = 250_000;

/** Longest-common-subsequence diff over the two middle blocks. */
function lcsOps(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [
      ...a.map((line) => ({ kind: "del" as const, line })),
      ...b.map((line) => ({ kind: "ins" as const, line })),
    ];
  }
  if (n * m > MAX_DP_CELLS) {
    return [
      ...a.map((line) => ({ kind: "del" as const, line })),
      ...b.map((line) => ({ kind: "ins" as const, line })),
    ];
  }
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + (j + 1)] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "ins", line: b[j] });
    j++;
  }
  return ops;
}

/** Line ops for the whole screen: trim the equal ends, LCS the middle. */
function lineOps(prev: readonly string[], next: readonly string[]): LineOp[] {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) {
    start++;
  }
  const maxEnd = Math.min(prev.length - start, next.length - start);
  let end = 0;
  while (end < maxEnd && prev[prev.length - 1 - end] === next[next.length - 1 - end]) {
    end++;
  }
  const ops: LineOp[] = [];
  for (let i = 0; i < start; i++) {
    ops.push({ kind: "eq", line: prev[i] });
  }
  ops.push(...lcsOps(prev.slice(start, prev.length - end), next.slice(start, next.length - end)));
  for (let i = prev.length - end; i < prev.length; i++) {
    ops.push({ kind: "eq", line: prev[i] });
  }
  return ops;
}

function sameLines(prev: readonly string[], next: readonly string[]): boolean {
  if (prev.length !== next.length) {
    return false;
  }
  return prev.every((line, i) => line === next[i]);
}

/**
 * Returns the text `next` adds on top of `prev`, or "" when nothing new
 * appeared. Both inputs must already be normalized (`normalizeScreen`).
 *
 * Every newly appeared line is prefixed with a newline so concatenated chunks
 * reconstruct the screen; the exception is a trailing line that grew in place
 * (streaming output arriving character by character), where only the suffix is
 * returned. `prev` being empty means "fresh screen", which is returned whole.
 */
export function diffScreens(prev: readonly string[], next: readonly string[]): string {
  if (prev.length === 0) {
    return next.join("\n");
  }
  if (sameLines(prev, next)) {
    return "";
  }

  const ops = lineOps(prev, next);
  const pieces: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "eq") {
      i++;
      continue;
    }
    const deleted: string[] = [];
    while (i < ops.length && ops[i].kind === "del") {
      deleted.push(ops[i].line);
      i++;
    }
    const inserted: string[] = [];
    while (i < ops.length && ops[i].kind === "ins") {
      inserted.push(ops[i].line);
      i++;
    }
    if (inserted.length === 0) {
      continue; // rows disappeared (a modal closed): no new output to stream
    }
    // One line replaced by a longer version of itself: the line grew in place,
    // so only its suffix is new.
    const grewInPlace =
      deleted.length === 1 && deleted[0] !== "" && inserted[0].startsWith(deleted[0]);
    let consumed = 0;
    if (grewInPlace) {
      const suffix = inserted[0].slice(deleted[0].length);
      if (suffix !== "") {
        pieces.push(suffix);
      }
      consumed = 1;
    }
    for (let k = consumed; k < inserted.length; k++) {
      pieces.push(`\n${inserted[k]}`);
    }
  }
  return pieces.join("");
}

/**
 * Keeps the previous normalized snapshot and returns only the new text on each
 * capture. `reset` establishes a new baseline (used after the TUI echoes the
 * user's prompt so the echo is not streamed back as assistant output).
 */
export class ScreenTracker {
  private prev: string[];

  constructor(initialRaw?: string) {
    this.prev = initialRaw === undefined ? [] : normalizeScreen(initialRaw);
  }

  reset(raw: string): void {
    this.prev = normalizeScreen(raw);
  }

  /** Feeds a raw capture in and returns the text that is new since the last one. */
  update(raw: string): string {
    const next = normalizeScreen(raw);
    const delta = diffScreens(this.prev, next);
    this.prev = next;
    return delta;
  }
}
