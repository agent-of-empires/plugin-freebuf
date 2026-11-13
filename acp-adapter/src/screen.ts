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

// --- TUI chrome ---------------------------------------------------------
//
// A Freebuff screen is not only conversation. Below the transcript sits a
// block that repaints constantly: the input box (its placeholder changes with
// state), an ad box, a live status line ("thinking... 3s ■ Esc" / "24.8K (19%)
// ✕ End session") and the two footer rows (model, cwd, chat title). Diffing the
// whole screen streams all of that as assistant output, so the transcript is
// cut out of it first and only that is diffed.

/**
 * Top border of a bordered block, how Freebuff frames its boxes: `╭──────╮` for
 * the transcript furniture, `┌──────┐` for the modals (chat picker, buttons).
 */
const BOX_TOP = /^[ \t]*[╭┌]─*[╮┐][ \t]*$/;

/** Bottom border of such a block (`╰──────╯`, `└──────┘`). */
const BOX_BOTTOM = /^[ \t]*[╰└]─*[╯┘][ \t]*$/;

/**
 * A live turn status row: the interrupt hint or the post-turn session footer.
 * Anchored at the row's end, because the same words can appear inside an
 * answer (`✕ End session` is a plausible thing to write about) and a row of
 * transcript matched here would be cut away with the chrome.
 */
const STATUS_ROW = /(?:■[ \t]*Esc\b|✕[ \t]*End session)[ \t]*$/;

/** The composer's prompt glyph (`▍` focused, `❯` unfocused) inside its box. */
const PROMPT_ROW = /│[ \t]*(?:▍|❯)/;

/** The live working/thinking status line of a turn in flight. */
const WORKING_ROW = /^[ \t]*(?:thinking|working)\.\.\.[^\n]*■[ \t]*Esc\b[ \t]*$/m;

/** True when the TUI is showing its input box, i.e. it will accept a prompt. */
export function isPromptVisible(lines: readonly string[]): boolean {
  return lines.some((line) => PROMPT_ROW.test(line));
}

// --- chat identity and resume -------------------------------------------
//
// Freebuff names the open chat in its footer (`... · Chat: <title>`), and the
// `/history` picker lists the chats of the current working directory. Both are
// how the adapter recognises which conversation a pane is showing after a
// restart, since the TUI keeps the conversation, not the adapter.

/**
 * Footer row holding the chat title. Anchored to the footer's `·` separators,
 * and at least two of them: the footer is `model · cwd · Chat: <title>`, so a
 * message that mentions `Chat:` (with or without one separator) cannot be read
 * as the name of the conversation.
 */
const CHAT_TITLE_ROW = /·[^·]*·\s*Chat:\s*(.*)$/;

/**
 * How far above the bottom of the screen the footer rows can sit.
 *
 * Freebuff draws two footer rows directly under the status line. Limiting the
 * search to them keeps a message that happens to contain `· Chat:` from being
 * read as the open chat's name.
 */
const FOOTER_ROWS = 4;

/** The chat title shown in the footer, trimmed, or null when absent. */
export function chatTitle(raw: string): string | null {
  const lines = stripAnsi(raw)
    .split("\n")
    .map((line) => line.replace(/\r/g, ""));
  // The pane is padded to its full height with blank rows, so the bottom of the
  // screen is the last row with something on it.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const from = Math.max(0, lines.length - FOOTER_ROWS);
  for (let i = lines.length - 1; i >= from; i--) {
    const match = CHAT_TITLE_ROW.exec(lines[i]);
    if (match === null) continue;
    const title = match[1].replace(/[│┃]+\s*$/, "").trim();
    if (title !== "") return title;
  }
  return null;
}

/** Header of the `/history` picker, always drawn on a line of its own. */
const HISTORY_HEADER = /^[ \t]*Select a chat to resume[ \t]*$/;

/**
 * One row of the `/history` picker: `<age> <n> msgs <title> [×] <scrollbar>`.
 *
 * The age is matched loosely on purpose. The newest chat renders as `just now`
 * rather than `5m ago`, and resume picks a chat by its position in this list:
 * a row that does not parse shifts every offset below it, which silently opens
 * a different conversation than the one asked for.
 */
const HISTORY_ROW = /^[\s│┃]*\S[^│┃]*?\s+(\d+)\s+msgs?\s+(.+)$/;

/** Control glyphs the picker draws after a row's title. */
const HISTORY_ROW_TRAILER = /[\s[\]×█▄▀│┃]+$/u;

/**
 * The picker's search field and key hints. The header alone is not enough,
 * since an agent can quote `Select a chat to resume` in a message and treating
 * that as an open picker would blank out a real transcript.
 */
const HISTORY_SEARCH_ROW = /^[ \t]*▍[ \t]*Search chats\.\.\.[ \t]*$/;

/** The picker's key hints, drawn on one row of their own below the box. */
const HISTORY_HINT_ROW = /^[ \t]*↑↓ navigate\b.*\bEsc cancel[ \t]*$/;

/**
 * The picker's own controls, both matched as whole rows.
 *
 * A message can quote `Search chats` or `Esc cancel` inside a sentence, and an
 * unanchored substring match would then turn a transcript into an open picker
 * and blank it out.
 */
const HISTORY_UI = [HISTORY_SEARCH_ROW, HISTORY_HINT_ROW];

/**
 * A picker row as the TUI frames it: a `N msgs` row between the box borders.
 * The borders are what tell a real row from a transcript line that happens to
 * mention a count (`it took 3 msgs total`), which is why the row shape alone is
 * not a picker marker.
 */
const HISTORY_BOX_ROW = /^[ \t]*│.*\d+[ \t]+msgs?\b.*│[ \t]*$/;

/** True when the chat picker is open. */
export function isChatHistoryScreen(raw: string): boolean {
  const lines = stripAnsi(raw).split("\n");
  // Standalone header first: a quoted copy sits inside a sentence.
  if (!lines.some((line) => HISTORY_HEADER.test(line))) return false;
  if (lines.some((line) => HISTORY_UI.some((marker) => marker.test(line)))) return true;
  return lines.some((line) => HISTORY_BOX_ROW.test(line));
}

/** Titles listed by the open `/history` picker, most recent first. */
export function chatHistoryRows(raw: string): string[] {
  const titles: string[] = [];
  for (const line of stripAnsi(raw).split("\n")) {
    const match = HISTORY_ROW.exec(line);
    if (match !== null) {
      const title = match[2].replace(HISTORY_ROW_TRAILER, "").trim();
      if (title !== "") titles.push(title);
    }
  }
  return titles;
}

/** The time stamp Freebuff prints above one of the user's messages. */
const TIMESTAMP_ROW = /^\s*\[\d{1,2}:\d{2}\s*[AP]M\]\s*$/;

/**
 * Splits restored transcript rows into the messages a host can replay.
 *
 * The TUI marks each of the user's own messages with the `⎘` badge on the row
 * that carries its text, and a timestamp row above it; the agent's rows have
 * neither. That is the only signal on screen, so the split is a heuristic.
 */
export function splitTranscriptMessages(lines: readonly string[]): { role: "user" | "agent"; text: string }[] {
  const messages: { role: "user" | "agent"; text: string }[] = [];
  // A restored screen still carries the startup banner and the status card
  // above the conversation. The first user message is stamped with the time it
  // was sent (`[2:42 PM]`), so everything before the first stamp is preamble.
  const firstStamp = lines.findIndex((line) => TIMESTAMP_ROW.test(line));
  const body = firstStamp > 0 ? lines.slice(firstStamp) : lines;
  let current: { role: "user" | "agent"; rows: string[] } | null = null;
  /** True once the user message being read has shown its `⎘` badge. */
  let sawBadge = false;
  const flush = (): void => {
    if (current === null) return;
    const text = dedent(current.rows).trim();
    if (text !== "") messages.push({ role: current.role, text });
    current = null;
    sawBadge = false;
  };
  // True when a prompt's own badge is still to come below the blank row: a
  // prompt can contain blank paragraphs, and its badge sits on its last row.
  // Only a message that has not shown its badge yet can continue: the badge
  // ends the user's rows, so once it is on screen the next blank row ends the
  // message. Looking ahead unconditionally merged an agent reply into the
  // user's message whenever a later badge, without a stamp of its own, sat
  // past that reply.
  const continuesUserMessage = (from: number): boolean => {
    for (let i = from; i < body.length; i++) {
      const row = body[i];
      if (TIMESTAMP_ROW.test(row)) return false;
      if (/⎘\s*$/.test(row)) return true;
    }
    return false;
  };
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    // A stamp opens one of the user's messages. It is the reliable signal: the
    // badge only marks the *last* row of a message that wrapped onto several
    // rows, so deciding per row would turn the earlier rows into agent text.
    if (TIMESTAMP_ROW.test(line)) {
      flush();
      current = { role: "user", rows: [] };
      sawBadge = false;
      continue;
    }
    if (current !== null && current.role === "user") {
      // A blank row ends the message unless the badge is still to come below.
      if (line.trim() === "") {
        if (!sawBadge && continuesUserMessage(i + 1)) {
          current.rows.push("");
          continue;
        }
        flush();
        continue;
      }
      if (/⎘\s*$/.test(line)) sawBadge = true;
      current.rows.push(stripUserBadge(line));
      continue;
    }
    if (/⎘\s*$/.test(line)) {
      // Badge without a stamp: still the user's row.
      flush();
      current = { role: "user", rows: [stripUserBadge(line)] };
      sawBadge = true;
      continue;
    }
    if (current === null || current.role !== "agent") {
      flush();
      current = { role: "agent", rows: [] };
    }
    current.rows.push(line);
  }
  flush();
  return messages;
}

/** Removes the `⎘` copy badge the TUI trails a user message with. */
function stripUserBadge(line: string): string {
  return line.replace(/\s*⎘\s*$/, "");
}

/**
 * Drops the indentation the TUI adds to every row of a message, so a wrapped
 * message reads as the text that was sent rather than carrying the padding of
 * whichever rows happened to wrap.
 */
function dedent(rows: readonly string[]): string {
  const indents = rows.filter((row) => row.trim() !== "").map((row) => /^\s*/.exec(row)?.[0].length ?? 0);
  if (indents.length === 0) return "";
  const common = Math.min(...indents);
  return rows.map((row) => row.slice(common)).join("\n");
}

/**
 * True when the screen says a turn is in flight. The bridge uses this to avoid
 * ending a turn just because the transcript paused: a thinking agent can be
 * quiet for longer than the quiescence window.
 */
export function isWorkingScreen(raw: string): boolean {
  return WORKING_ROW.test(stripAnsi(raw));
}

/** How far above the input box the bottom chrome block may reach. */
const MAX_CHROME_ROWS = 30;

/**
 * A floating affordance Freebuff draws over the top of a scrolled transcript
 * (`↑ Load previous messages`). It is chrome, not conversation, and it appears
 * and disappears mid-transcript, so it is dropped wherever it shows up.
 */
const OVERLAY_LABEL = /Load previous messages/;

/**
 * The promo card Freebuff rotates above the transcript. It is not part of the
 * bottom chrome block, so the chrome cut does not reach it, and the rotation
 * makes it change mid-turn: without this filter an ad streams as assistant
 * output every time it swaps. Every ad carries a `Ad [Report N]` control on its
 * first inner row, which is the stable thing to match on.
 */
const AD_MARKER = /\bAd\s*\[\s*Report\s*\d+\s*\]/i;

/** Bordered blocks that are chrome rather than conversation. */
const CHROME_BOX_MARKERS: readonly RegExp[] = [OVERLAY_LABEL, AD_MARKER];

/**
 * The badge Freebuff trails each message with (`⎘ • 6s • △▽`): glyphs, digits and
 * a unit. Its elapsed counter repaints, so as a trailing row it would stream as
 * whitespace-and-glyph noise. Only the badge's own glyphs count as a marker:
 * the `•` and `·` bullets and the `✕` control are ordinary punctuation, and a
 * bulleted list of numbers (`• 5%`, `• 10`) is content, not a badge.
 */
const DECORATION_CHARS = /^[\s⎘•·△▽✕0-9sm%().,▄▀█]+$/;
const DECORATION_MARKER = /[⎘△▽]/;

function isDecorationRow(line: string): boolean {
  return line.trim() !== "" && DECORATION_CHARS.test(line) && DECORATION_MARKER.test(line);
}

/**
 * Index where the bottom chrome block starts, so `lines.slice(0, start)` is the
 * transcript. Walks up from the input box's top border consuming border rows,
 * status rows, blank padding rows, and whole bordered boxes (the ad box). Stops
 * at the first row that is real content: the transcript itself.
 */
function chromeStart(lines: readonly string[]): number {
  // Only a box holding the prompt glyph is the composer. A box in the
  // transcript (a code block, a table, an answer) is content, and cutting the
  // transcript at its top border would drop everything above it.
  let box = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!BOX_TOP.test(lines[i])) continue;
    let bottom = -1;
    for (let j = i + 1; j < lines.length && j - i <= MAX_CHROME_ROWS; j++) {
      if (BOX_BOTTOM.test(lines[j])) {
        bottom = j;
        break;
      }
    }
    const inside = lines.slice(i, bottom > 0 ? bottom + 1 : lines.length);
    if (inside.some((line) => PROMPT_ROW.test(line))) {
      box = i;
      break;
    }
  }
  if (box < 0) return lines.length;

  let start = box;
  const limit = Math.max(0, box - MAX_CHROME_ROWS);
  for (let i = box - 1; i >= limit; i--) {
    const line = lines[i];
    if (line.trim() === "" || STATUS_ROW.test(line) || BOX_TOP.test(line)) {
      start = i;
      continue;
    }
    if (BOX_BOTTOM.test(line)) {
      // A bordered block above the composer is only chrome when it says so (the
      // ad card, the status card). A boxed answer or code block in the
      // transcript is content: consuming it would drop that answer.
      const top = findBoxTop(lines, i, limit);
      if (top < 0 || !isChromeBox(lines.slice(top, i + 1))) break;
      start = top;
      i = top;
      continue;
    }
    break; // transcript content: the chrome block ends here
  }
  return start;
}

/** The top border of the box that ends at `bottom`, or -1 when there is none. */
function findBoxTop(lines: readonly string[], bottom: number, limit: number): number {
  for (let i = bottom - 1; i >= limit; i--) {
    if (BOX_TOP.test(lines[i])) return i;
  }
  return -1;
}

/** True when a bordered block carries the marks of the TUI's own chrome. */
function isChromeBox(rows: readonly string[]): boolean {
  return rows.some(
    (line) =>
      STATUS_ROW.test(line) ||
      WORKING_ROW.test(line) ||
      CHROME_BOX_MARKERS.some((marker) => marker.test(line)),
  );
}

/**
 * Removes bordered blocks that are chrome rather than conversation. The whole
 * box goes: its borders and text would otherwise stream as prose.
 */
function dropChromeBoxes(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!BOX_TOP.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < lines.length && j - i <= MAX_CHROME_ROWS; j++) {
      if (BOX_BOTTOM.test(lines[j])) {
        end = j;
        break;
      }
    }
    const inside = end > 0 ? lines.slice(i, end + 1) : [lines[i]];
    const labelled = inside.some((line) => CHROME_BOX_MARKERS.some((marker) => marker.test(line)));
    if (!labelled) {
      kept.push(lines[i]);
      continue;
    }
    // The box was floated over the transcript, so the row it sat on is blank
    // in the source of truth: drop the path of blank rows it left behind.
    while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
    i = end;
  }
  return kept;
}

/**
 * The conversation part of a raw pane capture: normalized lines with the
 * bottom chrome block and overlays removed, decoration rows dropped, and
 * trailing padding trimmed. This is what the bridge diffs and streams; the
 * chrome never reaches the ACP client.
 */
export function extractTranscript(raw: string): string[] {
  // The chat picker is a modal, not conversation: while it is open the screen
  // holds no transcript at all, and streaming its rows would send row numbers,
  // ages and buttons to the client as assistant output.
  if (isChatHistoryScreen(raw)) return [];
  const lines = normalizeScreen(raw);
  const transcript = dropChromeBoxes(lines.slice(0, chromeStart(lines)));
  const kept: string[] = [];
  for (const line of transcript) {
    // An ad whose borders were consumed with the bottom chrome block can still
    // leave its text row behind; drop those by marker as well.
    if (AD_MARKER.test(line)) continue;
    // The per-message badge (`⎘ • 6s • △▽`) repaints its elapsed counter, so it
    // has to go wherever it sits, not only when it is the last row: a badge
    // streamed mid-turn would otherwise stay in the client's transcript.
    if (!isDecorationRow(line)) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept;
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
    this.prev = initialRaw === undefined ? [] : extractTranscript(initialRaw);
  }

  reset(raw: string): void {
    this.prev = extractTranscript(raw);
  }

  /** Feeds a raw capture in and returns the transcript text new since the last one. */
  update(raw: string): string {
    // The chat picker covers the transcript, so its empty extraction is not new
    // output. Keeping the previous baseline means closing the picker does not
    // re-stream the whole conversation as if it had just been printed.
    if (isChatHistoryScreen(raw)) return "";
    const next = extractTranscript(raw);
    const delta = diffScreens(this.prev, next);
    this.prev = next;
    return delta;
  }
}
