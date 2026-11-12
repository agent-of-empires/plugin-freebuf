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
2. `session/prompt` first waits for the TUI to be **ready**: the input box has
   appeared and the screen has stopped changing for three consecutive polls.
   Freebuff paints its splash (and swaps its model) for seconds after launch and
   drops any keystroke sent in that window, so typing earlier loses the prompt.
3. It sends the prompt as **literal** keys (`send-keys -l`, so a prompt
   containing `Enter` is not interpreted as a keypress), then `Enter`.
4. It waits for the user's message to reach the transcript and resets its diff
   baseline there, so the user's own text is never streamed as assistant output.
   (The *composer* echoes the text the moment it is typed; only the transcript
   copy is suppressed, which is why the search runs over the transcript.)
5. It polls `tmux capture-pane -p -e`, strips ANSI escapes, cuts the TUI's own
   chrome out of the screen, diffs the remaining transcript against the previous
   capture, and emits the new text as `session/update` with
   `agent_message_chunk`.
6. When the transcript has been unchanged for the quiescence window **and** the
   status line no longer says the agent is working, it answers the prompt with
   `stopReason: "end_turn"`.
7. `session/cancel` sends the interrupt key (`C-c`) and the running turn
   answers `stopReason: "cancelled"`.

### What gets streamed

A Freebuff screen is mostly not conversation. Below the transcript sits a block
that repaints continuously — an ad box, a live status line
(`thinking... 3s ■ Esc`), the input box, and two footer rows naming the model,
working directory and chat. Diffing the whole screen streams all of it as
assistant output. So `extractTranscript` (`src/screen.ts`) keeps only the
conversation rows:

- it walks up from the input box's top border, consuming border rows, status
  rows, blank padding and whole bordered boxes, and stops at the first row of
  real content;
- it drops a bordered box labelled `↑ Load previous messages` — a scroll
  affordance Freebuff floats over the top of a scrolled transcript;
- it drops the **promo card**. Ads sit *above* the transcript, not in the bottom
  chrome block, and they rotate mid-turn, so without this filter every rotation
  streams as assistant output. Each ad carries an `Ad [Report N]` control, which
  is what identifies it;
- it drops the message badge (`⎘ • 6s • △▽`) whose timer repaints, wherever it
  sits, not only as the last row: a badge streamed mid-turn would otherwise stay
  in the client's transcript. A row only counts as a badge when it carries
  those glyphs, digits and no prose, so a bare numeric answer survives.

Because the baseline is captured on the settled ready screen, the startup
banner and status card are part of it and never streamed either.

Bridge timing (override via `createAdapter({ bridge })`):

| Option             | Default  | Meaning                                          |
| ------------------ | -------- | ------------------------------------------------ |
| `pollIntervalMs`   | `250`    | Delay between `capture-pane` polls               |
| `quiescenceMs`     | `2000`   | Quiet window that ends the turn                  |
| `echoTimeoutMs`    | `10000`  | How long to wait for the prompt echo             |
| `maxTurnMs`        | `300000` | Hard cap for a whole turn                        |
| `startupTimeoutMs` | `90000`  | How long to wait for the TUI to settle, then type |

## Resuming a conversation

The conversation belongs to Freebuff, not to the adapter, so a resume does not
replay messages into a fresh TUI: it reopens the chat the TUI already has.

`initialize` advertises `loadSession: true`, and `session/load`:

1. starts a pane with `freebuff --continue --cwd <cwd>`, which reopens the most
   recent chat of that directory;
2. compares the chat title in the footer (`· Chat: <title>`) with the title
   recorded for this session. A directory can hold several chats — including one
   from another session — and `--continue` picks the newest, so a mismatch makes
   the adapter drive the TUI's own `/history` picker: `/history`, `Enter`, arrow
   down to the row whose title matches, `Enter`;
3. replays the restored transcript to the host as `user_message_chunk` /
   `agent_message_chunk`, so the host's transcript matches the agent's.

The record (`cwd` plus chat title, one small JSON file per session id under
`$FREEBUFF_ACP_STATE_DIR` or `~/.cache/freebuff-acp/sessions/`) is refreshed
when `session/new` runs and at the end of each turn, since Freebuff renames a
chat after its first prompt.

A prompt that arrives while the resume is still navigating waits for it
(`SessionState.resuming`): hosts wake a resumed session with a prompt
immediately, and those keystrokes would otherwise land in the picker. The
prompt slot is claimed before that wait, so a second prompt during a resume is
still rejected with `-32000` rather than typed into the same composer. If the
resume itself fails, the pane is closed and `session/load` reports the error.

The picker lists a chat created in the last minute as `just now` instead of
`5m ago`; both are parsed, because resume selects a chat by its position in that
list and a row that does not parse would shift every offset below it.

One host-side caveat: a host that fences resume after its own stop action will
refuse to respawn regardless of what the agent advertises. Agent of Empires does
this — after `aoe acp stop` / `aoe acp kill` the daemon logs `worker stop intent
fences automatic or superseded resume` — so revival goes through its own path
(the dashboard's Retry, or `POST /api/sessions/<id>/restart`) rather than an
automatic respawn.

## Limitations of a TUI bridge

This adapter sees pixels, not events. Specifically:

- **No tool-call events.** Freebuff's screen may *render* tool calls, but the
  adapter cannot attribute them, so the ACP client only ever receives
  `agent_message_chunk` text. No `tool_call` / `tool_call_update`, no
  `agent_thought_chunk`, no `plan`, no `usage_update`, no session modes, no
  MCP servers. `session/load` is implemented (see below); everything else
  session-scoped — `session/resume`, `session/set_mode`, `session/close` — is
  not.
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
  scrollback), so output that scrolls past the pane between two polls is lost.
  The pane is therefore made tall (220x200, see `DEFAULT_PANE_ROWS`) to give a
  burst room to land; sustained output still scrolls, just later. A full-screen
  repaint with no overlapping lines re-emits the whole screen as "new" output,
  and a mid-line rewrite can surface as a short suffix artifact. The chrome cut
  is a layout heuristic too: it assumes Freebuff keeps its transcript above a
  bordered input box, so a bordered box sitting directly against the chrome is
  taken for chrome and dropped, and a screen that does not fit the shape at all
  is streamed whole rather than truncated.
- **Resume is title-matching, not identity.** The adapter knows a chat by the
  title Freebuff shows for it, so a hand-renamed chat, a title truncated past the
  recorded prefix, or two chats in one directory sharing a prefix can reopen the
  wrong conversation. The conversation itself is whatever Freebuff restores; the
  adapter cannot inspect it.
- **One turn at a time per session.** A second overlapping `session/prompt`
  is rejected with `-32000`. There is no `session/close`; tmux sessions are
  torn down when the adapter process exits (SIGINT/SIGTERM/SIGHUP and on
  `exit`), and — because a host may stop the worker with a signal no handler can
  catch — the pane command also carries a watchdog that kills the tmux session
  once the adapter pid is gone.
- **Slow first prompt.** The readiness wait means a session's first turn does
  not start until Freebuff has settled, so it includes Freebuff's startup time
  (several seconds). Later turns on the same session skip most of that wait.

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

Covered by tests: ANSI stripping, transcript extraction (chrome cut, badge,
overlay and ad stripping), incremental pane diffing (append, scroll, in-place
growth, recoloring), readiness, quiescence and turn-end decisions (including the
working-status gate and a late prompt echo), cancellation, permission-notice
behavior, pane command construction (pane geometry, quoting, watchdog), the
resume path (`--continue`, chat-title matching, `/history` selection, replay,
and holding a wake prompt until the resume finishes), and ACP request/response
framing over the real SDK transport (including the pre-initialize `-32600` gate
and `-32601` for unknown methods).

## Verified against the real TUI

Exercised end to end against `freebuff` 0.2.36 and tmux 3.8 on macOS by
driving the adapter over ACP stdio with a real tmux pane behind it:

| Check | Result |
|---|---|
| `initialize` / `session/new` | answers in ~100 ms, tmux session starts |
| first turn on a fresh session | prompt lands (no longer swallowed by the splash), streams only `"\n  HELLO-ACP-OK"` |
| second turn, same session | streams only `"\n  SECOND-OK"` |
| `session/cancel` mid-answer | `stopReason: "cancelled"` in ~1.7 s |
| process exit | leaves no `freebuff-acp-*` tmux sessions behind |

Then again through the Agent of Empires **web dashboard** (aoe 1.22.3), with
the adapter registered as the ACP command for the `freebuff` tool
(`[session.agent_acp_cmd]` in the AoE config) and a structured-view session
created with `aoe add --tool freebuff --structured-view`:

| Check | Result |
|---|---|
| ACP handshake in the AoE worker | `acp_session_assigned` within a second of the session starting |
| prompt typed in the browser | reaches the TUI and the reply renders in the web view |
| second turn, same session | works; only the answer is rendered, no TUI chrome |
| a 400-line answer | 400 of 400 numbers streamed, in order, no duplicates, no chrome |
| stop button in the browser | `CancelRequested` then `Stopped{cancelled}`; pane survives for the next turn |
| `aoe acp stop` | the Freebuff tmux pane is reaped (watchdog), nothing left running |

The web run found four defects the tmux-only run missed, all now fixed: the
`↑ Load previous messages` overlay and a mid-transcript badge were streamed as
assistant text; the 50-row pane let lines scroll past the capture between polls
(8 of 400 numbers were lost); and `aoe acp stop` left the Freebuff pane running,
because the async kill in the signal handler lost the race with `process.exit`
and the host's own stop was not catchable at all.

Resume, ads and the prompt echo were verified against the real TUI afterwards:

| Check | Result |
|---|---|
| worker killed, host restarts it | `session/load` runs, pane reopens with `--continue`, `load_session: true` |
| context after resume | asked "what word did I ask you to remember?" it answered the word from before the kill |
| two chats in one directory | resuming the older session lands on the older chat (picked out of `/history`), not the newest |
| rotating ad card mid-turn | no ad text in any streamed chunk |
| long prompt, echo later than the window | the user's own message is not streamed back |
| 25-line answer in one turn | every line present, no chrome, no echo

Still unverified: multi-line prompts, image/inline file handling (contents are
dropped), how the permission-prompt patterns line up with the real wording,
behavior when a turn is blocked on an interactive prompt for longer than
`maxTurnMs`, and resuming a session after the host stops the worker (it cannot;
see Limitations).
