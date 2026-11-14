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
| question dialog: caption `Some questions for you`, `Do you want to proceed` | waiting | raised |
| inline prompt at the composer: `(y/n)`, `Do you want to…`, the session limit | waiting | raised |
| error dialog: caption says error/failed | error | raised |
| `working...` or `thinking...` with `■ Esc` above the composer | running | lowered |
| the input prompt and its footer, nothing else | idle | lowered |
| capture failed (no pane, CLI missing, timeout) | unknown | left alone, so it expires |

A blocking dialog is checked first, because Freebuff draws it over a turn that
is still open. It is found structurally, and only its *caption* decides: a
boxed panel with `Close ✕` under its captioned border, with no composer drawn
below it (a dialog replaces the composer; output the session printed does not).
So a session that merely talks about, quotes, or prints a dialog stays
`running`/`idle` -- text is never read for a block -- and a question is never
reported as an error. A confirmation asked outside a dialog, like `(y/n)`, or the
modal Freebuff draws once the account is over its concurrent-session limit,
counts only in the rows just above the composer, where the question is put to
the user. The flag is the file the host reads for any session,
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

### Row status (api_version 19)

Agent of Empires' first-class route sets the row's own status: the shipped
manifest declares `api_version = 19` with an `[[agent_integrations]]` entry and
the `session.integration` capability, and the worker writes
`AgentIntegrationSnapshot` reports into the session's hook directory
(`integration-agent-of-empires.aoe-freebuf.json`). The host reads those to override
the row's status and to expose Freebuff in `aoe agents`, the agent picker, and
`session.default_tool`.

That schema version is also the install floor. The host parses manifests
strictly and rejects one whose schema version it does not know, so
`aoe_version` is `>=1.21.0, <2.0.0` -- the host line that parses this contract.
`src/integration.ts` writes the report from the same pane classification as the
attention flag, every tick; the attention flag still works on its own, so a
session stays visible in the attention order either way.

Replies stay off: explicit replies need an in-process provider extension
Freebuff's CLI does not have, so `reply_keys` stays empty and `prompt` stays
null in the report.

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
aoe-plugin.toml        the manifest (api_version 19, integration, settings, ui, runtime)
package.json           build + dev tooling (tsc, eslint, vitest)
tsconfig.json
src/
  index.ts             the JSON-RPC worker loop, RPC multiplexing, attention heartbeat
  rpc.ts               response builders
  freebuff.ts          reads Freebuff's local state for the status command
  pane.ts              captures a session pane and classifies its screen
  attention.ts         writes the host's per-session urgent flag
  integration.ts       writes the row-status report the host reads
scripts/
  write-aoe-wrapper.mjs generates the plugin-relative launcher
test/                  worker, heartbeat, pane, attention-flag, state-probe, manifest tests
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
