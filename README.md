# Freebuf

An Agent of Empires plugin for the FreeBuff coding agent.

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It contributes a `status` command, one setting, a `pane` UI slot, and an
agent integration for launching `freebuff`, backed by a worker that speaks
JSON-RPC 2.0 over newline-delimited JSON on stdio.

## Agent integration

The manifest declares `api_version = 19` with exactly one `[[agent_integrations]]`
block, `tool = "freebuff"`, `provider_versions = [">=0.2.0, <1.0.0"]`, and
`command = "freebuff"`. Two things follow:

- **Launch and discovery.** `freebuff` appears in AoE's agent picker, in
  `aoe agents`, and as a candidate for `session.default_tool`; the host spawns
  it via the declared command.
- **Native session status (status-only).** For every session whose tool is
  `freebuff`, the worker heartbeats a status-only `AgentIntegrationSnapshot`
  every 5 seconds into the host's hook directory
  (`/tmp/aoe-hooks-<euid>/<instance id>/integration-dev.example.aoe-freebuf.json`,
  dir `0700`, file `0600`, refreshed well inside the host's 15-second freshness
  window). The host uses it to set the session row's status directly.

### How status is decided, and its limits

The signal is Freebuff's own local state under `~/.config/manicode`: the worker
stats the newest chat directory in `projects/<project>/chats/` for the
session's `project_path` and maps it onto what it is willing to claim:

| Local state | Reported | Why |
|---|---|---|
| chat files written within 30 s | `running` | the runtime rewrites them while it works |
| chat files older than 30 s | `idle` | nothing is happening in that project |
| no chat state, unknown runtime version, or worker down | *no report* | the host falls back to its own pane detection |

It never claims `waiting` or `error`: the CLI exposes no status subcommand and
no extension hook, so those states cannot be observed honestly. **Replies are
deliberately off** (`replies` omitted, i.e. false): explicit replies need an
in-process provider extension Freebuff does not have, and with `replies = false`
the host drops any prompt and offers no provider-native response. The
`provider_versions` range gates the whole path: a runtime version outside it
makes the host reject our reports and fall back to pane detection instead of
trusting unverified state. The manifest integration block carries only the four
keys the host's `deny_unknown_fields` schema accepts (`tool`,
`provider_versions`, `command`, `replies`) — `resume_arg` is not one of them.

Because status reads Freebuff's state directory, writes the report into `/tmp`,
and lists sessions through the host, the manifest declares `session.integration`,
`session.read`, `fs.read`, and `fs.write` alongside `runtime.worker`; each is
prompted at install and pinned to the manifest hash.

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
aoe-plugin.toml        the manifest (agent integration, commands, settings, ui slots, runtime)
package.json           build + dev tooling (tsc, eslint, vitest)
tsconfig.json
src/
  index.ts             the JSON-RPC worker loop, RPC multiplexing, status heartbeat
  rpc.ts               response builders
  freebuff.ts          reads Freebuff's local state for running/idle
  integration.ts       builds and writes the host's status report
scripts/
  write-aoe-wrapper.mjs generates the plugin-relative launcher
test/                  worker, heartbeat, report, state-probe, and manifest tests
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
echo '{"jsonrpc":"2.0","id":1,"method":"aoe-freebuf.status","params":{}}' \
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
and the [plugin API reference](https://agent-of-empires.com/docs/api/plugin-api/).

## Release

Push a `v0.1.0`-style tag to run the release workflow: it
runs checks, generates the changelog from conventional commits, and publishes a
GitHub Release with a source archive and `sha256`. To get listed in the Agent of
Empires featured index, see the authoring guide's publishing section.

## License

MIT
