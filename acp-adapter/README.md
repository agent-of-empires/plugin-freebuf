# freebuff-acp-adapter (experimental)

An experimental [ACP](https://agentclientprotocol.com) agent that lets an ACP
client drive the **Freebuff TUI**. It speaks JSON-RPC over stdio with
`@agentclientprotocol/sdk` (2.x) and bridges each session to a `freebuff`
process running inside a dedicated tmux session.

It is a spike, not a product: the package is **not** wired into the plugin
worker (`src/`), the manifest (`aoe-plugin.toml`), or the root `package.json`.
Nothing here changes plugin behavior.

## Why a TUI bridge

The `freebuff` npm package is only a launcher that downloads a prebuilt
binary, and that CLI is TUI-only: `--help` exposes `login`,
`--continue [conversation-id]`, `--cwd` and `--trust-agents`, but no `acp`,
no `--acp`, and no print/JSON mode. There is no in-process extension hook
either, so this plugin cannot serve ACP from inside Freebuff. Until Freebuff
grows a headless mode, the only way to automate it is to drive its screen:
type into it, watch it, and translate what appears into ACP updates.

## Requirements

- Node >= 22.18 (the package runs TypeScript directly via Node's strip-only
  type stripping; keep sources to erasable syntax — no `enum`, no namespaces,
  no constructor parameter properties)
- `tmux` on `PATH`
- a logged-in `freebuff` on `PATH`

## Usage

```bash
cd acp-adapter
npm install
npm start          # node src/cli.ts, ACP over stdio
```

Point an ACP client at the adapter as the agent command, e.g.:

```jsonc
{
  "command": "node",
  "args": ["/path/to/plugin-freebuf/acp-adapter/src/cli.ts"]
}
```

Environment variables:

| Variable              | Effect                                                        |
| --------------------- | ------------------------------------------------------------- |
| `FREEBUFF_ACP_COMMAND`| Command run inside the pane instead of `freebuff --cwd <cwd>` |
| `FREEBUFF_ACP_TMUX`   | tmux binary to use (default `tmux`)                           |

Scripts: `npm test` (node's built-in test runner), `npm run typecheck`.

## How a turn works

1. `session/new` spawns `freebuff --cwd <cwd>` in a tmux session named after
   the ACP session id and returns that id.
2. `session/prompt` sends the prompt as **literal** keys (`send-keys -l`, so a
   prompt containing `Enter` is not interpreted as a keypress), waits out the
   TUI's paste window, then presses `Enter`. Sent in one burst the `Enter` is
   read as part of a paste and dropped, which leaves the prompt typed in the
   composer with no turn running. If the pane does not react, the press is
   retried, up to three in total, spaced across the whole `echoTimeoutMs` so a
   slow pane is not given up on early; a composer that never accepts it fails
   the turn instead of reporting an `end_turn` that never ran.
3. It waits for the TUI to echo the prompt and resets its diff baseline, so
   the user's own text is never streamed back as assistant output.
4. It polls `tmux capture-pane -p -e`, strips ANSI escapes, diffs the
   normalized screen against the previous one, and emits each new piece of
   text as a `session/update` with `agent_message_chunk`.
5. When the screen has been unchanged for the quiescence window, it answers
   the prompt with `stopReason: "end_turn"`.
6. `session/cancel` sends the interrupt key (`C-c`) and the running turn
   answers `stopReason: "cancelled"`. A turn cancelled before it was submitted
   deletes the text it typed, so the next prompt does not start from a stale
   draft in the composer.

Bridge timing (override via `createAdapter({ bridge })`):

| Option            | Default  | Meaning                                     |
| ----------------- | -------- | ------------------------------------------- |
| `pollIntervalMs`  | `250`    | Delay between `capture-pane` polls          |
| `quiescenceMs`    | `2000`   | Quiet window that ends the turn             |
| `echoTimeoutMs`   | `2000`   | How long to wait for the prompt echo        |
| `maxTurnMs`       | `300000` | Hard cap for a whole turn                   |
| `submitDelayMs`   | `150`    | Wait out the paste window before `Enter`    |

## Limitations of a TUI bridge

This adapter sees pixels, not events. Specifically:

- **No tool-call events.** Freebuff's screen may *render* tool calls, but the
  adapter cannot attribute them, so the ACP client only ever receives
  `agent_message_chunk` text. No `tool_call` / `tool_call_update`, no
  `agent_thought_chunk`, no `plan`, no `usage_update`, no session modes, no
  MCP servers. Session-scoped ACP features such as `session/load`,
  `session/resume` and `session/set_mode` are not implemented.
- **Heuristic turn end.** "The pane did not change for 2 seconds" is the only
  signal that a turn finished. A quiet pause longer than the window ends the
  turn early (later output is attributed to nothing); an always-repainting
  pane (spinners, progress bars) or a turn blocked on an interactive prompt
  never goes quiet and is cut off at `maxTurnMs`, reported as `end_turn`
  even though the agent did not actually finish. There is no way to
  distinguish "done" from "waiting for input".
- **Permission prompts are not bridged.** `session/request_permission` is an
  agent-to-client request in ACP, and this adapter has no trustworthy way to
  detect or answer a Freebuff confirmation prompt. When the screen matches a
  recognized pattern (`y/n`, `[y/N]`, "Do you want to allow ...", "Permission
  required ...") it emits a single `notice` update saying prompts are not
  bridged; the user must switch to the Freebuff window to respond. The turn
  then ends at `maxTurnMs` if nobody does. The patterns are conservative
  heuristics and will both miss and occasionally misfire.
- **Only text prompts.** Non-text content blocks in `session/prompt`
  (images, resources) are dropped; everything is typed into the TUI.
- **Diff heuristics.** Only the visible pane rows are captured (no
  scrollback beyond the pane height). A full-screen repaint with no
  overlapping lines re-emits the whole screen as "new" output, and a mid-line
  rewrite (spinner glyph swap) can surface as a short suffix artifact.
- **One turn at a time per session.** A second overlapping `session/prompt`
  is rejected with `-32000`. There is no `session/close`; tmux sessions are
  torn down when the adapter process exits (SIGINT/SIGTERM/SIGHUP and on
  `exit`).
- **Timing is untested against the real TUI** (see below).

## Follow-up for first-class support

1. **Upstream, in the Freebuff CLI:** a headless/ACP mode — e.g. `freebuff
   acp` speaking JSON-RPC over stdio — so the agent emits structured events
   (tool calls, permission prompts, stop reasons) instead of pixels. That is
   the only way most of the limitations above disappear.
2. **Then, in aoe core:** register the agent in
   `src/acp/agent_registry.rs` and describe it in
   `src/acp/agent_profiles.rs`, pointing at the native ACP entry point. Until
   then, this package is the experimental adapter such a registration would
   eventually spawn (or be replaced by).

## Development

```bash
npm install        # inside acp-adapter/
npm run typecheck  # tsc --noEmit
npm test           # node --test (test/*.test.ts)
```

Tests use a scripted fake pane source and a fake clock: **no tmux, no
freebuff, no network**. The injectable seam is
`createAdapter({ createPane })`, where `createPane` returns a
`SessionPane` (`capture()` / `send()` / `stop()`), and `TmuxPaneSource` is
the real implementation.

Covered by tests: ANSI stripping, incremental pane diffing (append, scroll,
in-place growth, recoloring), quiescence and turn-end decisions, cancellation,
permission-notice behavior, and ACP request/response framing over the real
SDK transport (including the pre-initialize `-32600` gate and `-32601` for
unknown methods).

**Not verified without a real `freebuff` login:** how the actual TUI behaves —
real colors/reflow and whether the diff heuristic holds up on its screens, real
turn/quiet timing, whether `C-c` interrupts a live Freebuff turn as expected,
the real permission-prompt wording (so the notice patterns), startup latency
of `freebuff`, and multi-line prompt echoing. Run a manual session against a
logged-in `freebuff` before trusting any of it.
