# Freebuf

An Agent of Empires plugin for the FreeBuff coding agent.

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It contributes a `status` command, one setting, a `pane` UI slot, and a
worker that speaks JSON-RPC 2.0 over newline-delimited JSON on stdio.

## Session attention

Every 10 s, for each session whose tool is `freebuff`, the worker captures that
session's pane with `aoe session capture` and classifies it the way the host
classifies its built-in agents:

| Pane | Class | Flag |
|---|---|---|
| `Some questions for you`, `Close ✕`, `Do you want to proceed`, `(y/n)` | waiting | raised |
| `working...` or `thinking...` with `■ Esc` | running | lowered |
| the input prompt and its footer, nothing else | idle | lowered |
| capture failed (no pane, CLI missing, timeout) | unknown | left alone, so it expires |

A blocking dialog is checked first, because Freebuff draws it over a turn that
is still open. The flag is the file the host reads for any session,
plugin-declared or not: `/tmp/aoe-hooks-<euid>/<session id>/attention.json` with
`{"urgent": true, "urgent_expires_at": <epoch secs>}`, `0600` in a `0700`
directory, refreshed each tick while the dialog is up and decaying two minutes
after the last write. That is what the TUI's jump-to-next-attention and the web
sidebar's Attention sort read: urgent rows float above non-urgent peers within
their status tier.

Nothing decorative is written: no row column, no tooltip, no reason string. The
host's own status field is out of reach pre-19 — released hosts read a plugin's
`status` hook file only for agents whose detection manifest declares a hook
rule, which a plugin-declared agent has none of (verified against aoe 1.21.0:
the file is ignored and the row stays `Idle`). The flag is the attention signal
that does work today.

### Row status (api_version 22)

Agent of Empires' first-class route sets the row's own status: the shipped
manifest declares `api_version = 22` with an `[[agent_integrations]]` entry, the
`session.integration` capability, and `send_keys_enter_delay_ms = 150`, the pause
the host leaves between typing a message and pressing `Enter` (Freebuff's
composer reads a burst as a paste and drops an `Enter` inside that window). The
worker writes
`AgentIntegrationSnapshot` reports into the session's hook directory
(`integration-agent-of-empires.aoe-freebuf.json`). The host reads those to override
the row's status and to expose Freebuff in `aoe agents`, the agent picker, and
`session.default_tool`.

That schema version is also the install floor. The host parses manifests
strictly and rejects one whose schema version it does not know. `aoe_version`
stays at `>=1.21.0, <2.0.0` because no released host parses API 22 yet: the
latest host main is API 21, and 22 exists only in open host work. So this
manifest cannot be released against a released host, and the `aoe_version` floor
moves to the release that first parses 22, in the same change that ships it.
`src/integration.ts` writes the report from the same pane classification as the
attention flag, every tick; the attention flag still works on its own, so a
session stays visible in the attention order either way.

### Quick responses in the terminal session list

When the blocker is a question, the session row can answer it: the worker
publishes the dialog's own prompt and the manifest opts into provider-native
replies (`replies = true`). Select the Freebuff session, press `a`, pick an
option, and the answer reaches the TUI.

| Step | Who | What |
|---|---|---|
| 1 | worker | parses `Some questions for you` off the pane: the expanded question, its `○`/`☐` option labels, whether it takes several, whether it offers a `Custom` typed answer, and whether it is the form's last question |
| 2 | worker | reports `prompt` as `{ kind: "question", id, title, questions }` (`multi: true` for a multi-select question) with `reply_keys: ["F12"]` and a `revision` that changes only when the prompt does |
| 3 | host | shows the question, validates the answer against the prompt, writes `integration-agent-of-empires.aoe-freebuf.reply.json` into the hook directory, then sends the wake key into the pane |
| 4 | worker | on its next tick, validates that reply against the report it published, replays the answer as the dialog's own keypresses through `tmux send-keys`, and removes the reply file |

Every question shape is delivered, because the dialog's own key semantics are
replayed rather than guessed:

| Question | Sent |
|---|---|
| every reply | `Up`, `Down`, `Left`, `Down` first: `Up` leaves Submit (where the form sits between being answered and being submitted) or steps the focus up a row, `Down` undoes a step back to the previous question, and `Left`/`Down` collapse and re-expand the open question, which puts the focus back on its first option, so the counts below hold wherever the focus was |
| single choice | `Down` × option index, then `Enter`, which selects and advances |
| multi choice | `Down`/`Enter` on every option whose checked state differs from the answer (Enter toggles and stays put), then `Tab` (Submit) on the form's last question |
| typed answer | `Down` to the trailing `Custom` row, `Enter` to open its text field, the text itself, `Enter` to end it, then submit |
| last question in the form | one more `Enter` submits (a single choice already leaves Submit focused; a multi choice needs the `Tab` first) |

Only one question is expanded at a time, so a multi-question form is answered
one prompt at a time: each tick publishes the question currently on screen, and
the form submits itself once the last one is answered.

What it will not do: approve anything automatically, or send anything the
dialog does not offer: a miss, a stale reply, a reply naming an option that is
not on screen, or a failed `tmux send-keys` just leaves the prompt to the
Freebuff window, exactly as before. A reply that arrives after the dialog
changed, or from another uid/mode/pid, is dropped rather than delivered, and the
dialog is read a second time immediately before the first key, since resolving
the pane is slower than the window in which the question can be answered by
hand. A sequence that only partly reached the pane is not retried: the reply is
discarded rather than replayed, because pressing the keys that already landed
again would toggle an option back or type the answer twice.

Limits worth knowing: a stopped session has no tmux pane to send to (`aoe
session start` it first), and the wake key `F12` lands in the TUI unbound: the
worker reads the answer from the reply file, not from the keypress.

## Status command

`Freebuf: status` answers with the installed runtime version and how many of
Freebuff's projects are active right now:

```json
{"ok": true, "runtime": "node", "message": "Freebuf worker is running · freebuff 0.2.35 · 1 of 2 projects active",
 "provider_version": "0.2.35", "projects": 2, "running": 1}
```

## Install into Agent of Empires

```bash
# from a local checkout
aoe plugin install ./aoe-freebuf

# or from GitHub once published
aoe plugin install gh:your-org/aoe-freebuf
```

The host runs the manifest's `[[runtime.build]]` steps at install time and then
launches the plugin-relative worker entrypoint under `.aoe-build/`. Manage the
plugin from the TUI, the web dashboard, or `aoe plugin {enable,disable,update}`.

## Layout

```
aoe-plugin.toml        the manifest (api_version 22, integration, settings, ui, runtime)
package.json           build + dev tooling (tsc, eslint, vitest)
tsconfig.json
src/
  index.ts             the JSON-RPC worker loop, RPC multiplexing, attention heartbeat
  rpc.ts               response builders
  freebuff.ts          reads Freebuff's local state for the status command
  pane.ts              captures a session pane and classifies its screen
  dialog.ts            parses the blocking question modal into a prompt
  replies.ts           validates the host's reply and maps it to keypresses
  tmux.ts              resolves a session's pane and sends the keys
  attention.ts         writes the host's per-session urgent flag
  integration.ts       writes the row-status report the host reads
scripts/
  write-aoe-wrapper.mjs generates the plugin-relative launcher
test/                  worker, heartbeat, pane, dialog, reply, tmux, attention-flag, state-probe, manifest tests
```

## Develop

```bash
npm ci          # install deps
npm run lint    # eslint
npm run build   # compile TypeScript to dist/
npm test        # vitest
```

Drive the worker by hand (it reads one JSON-RPC request per line on stdin):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"plugin.agent-of-empires.aoe-freebuf.status","params":{}}' \
  | node dist/index.js
```

## Worker protocol

The host spawns the worker and exchanges newline-delimited JSON-RPC 2.0 messages
over stdio. The worker answers a request whose method ends in `.status` and exits
cleanly when stdin reaches EOF. A request:

```json
{"jsonrpc": "2.0", "id": 1, "method": "aoe-freebuf.status", "params": {}}
```

A response:

```json
{"jsonrpc": "2.0", "id": 1, "result": {"ok": true, "runtime": "node", "message": "..."}}
```

Unknown methods return a JSON-RPC error with code `-32601`. See the
[plugin authoring guide](https://agent-of-empires.com/docs/development/writing-plugins/)
and the [plugin API reference](https://agent-of-empires.com/docs/plugin-api/).

## Release

Push a `v0.1.0`-style tag to run the release workflow: it
runs checks, generates the changelog from conventional commits, and publishes a
GitHub Release with a source archive and `sha256`. To get listed in the Agent of
Empires featured index, see the authoring guide's publishing section.

## License

MIT
