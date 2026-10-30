// ANSI escape stripping for pane snapshots.
//
// tmux `capture-pane -e` replays the escape sequences that are still live on
// the screen (colors, cursor movement, window-title escapes, ...). Diffing raw
// captures would report a "change" whenever the TUI merely recolors a cell, so
// every snapshot is reduced to plain text first.

const ESC = "\u001b";
const BEL = "\u0007";

// OSC sequences (window title, hyperlinks, ...): ESC ] ... terminated by BEL
// or by ST (ESC \). OSC payloads may contain arbitrary printable text.
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

// DCS / SOS / PM / APC sequences: ESC (X|^|_) ... terminated by ST.
const STRING_RE = new RegExp(`${ESC}[PX^_][^${ESC}]*(?:${ESC}\\\\)?`, "g");

// CSI sequences: ESC [ params/intermediates final byte in @-~.
// Handles 8-bit CSI (0x9B) after normalizeCsi below.
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

// Remaining escapes: ESC + optional intermediate bytes (0x20-0x2F) + a final
// byte (0x30-0x7E), e.g. ESC ( B, ESC 7, ESC =.
const SHORT_RE = new RegExp(`${ESC}[ -/]*[0-~]`, "g");

/** Removes ANSI/VT escape sequences from `input`, leaving plain text. */
export function stripAnsi(input: string): string {
  // Promote the 8-bit CSI single character to its 7-bit equivalent so the CSI
  // pattern below can match it.
  const text = input.replace(/\u009b/g, `${ESC}[`);
  return text
    .replace(OSC_RE, "")
    .replace(STRING_RE, "")
    .replace(CSI_RE, "")
    .replace(SHORT_RE, "");
}
