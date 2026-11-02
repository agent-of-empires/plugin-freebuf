# Changelog

All notable changes to Freebuf will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- Forward compatibility for `api_version = 19`: the worker writes the status-only `AgentIntegrationSnapshot` report (`integration-dev.example.aoe-freebuf.json`, `0700`/`0600`, atomic) from the same pane classification every tick, so a host that ships the contract reads the row's status with no code change; an older host ignores the file. `aoe-plugin.v19.toml` holds the swapped manifest (api_version, `session.integration`, `[[agent_integrations]]` only), and `test/manifest-v19.test.ts` fails if the two manifests drift in anything else.
- Pane classification (`src/pane.ts`): `aoe session capture` output is stripped of colour and matched against Freebuff's own chrome — a blocking dialog (`Some questions for you`, `Close ✕`, `Do you want to proceed`, `(y/n)`) is `waiting`, the `working... ■ Esc` status line is `running`, anything else is `idle`. This is the rule shape the host's built-in detectors use, read from the same surface.
- Attention came from the pane: every 10 s each `freebuff` session's class decides the host's urgent flag (`/tmp/aoe-hooks-<euid>/<session id>/attention.json`, `0700` dir, `0600` file, `{ urgent, urgent_expires_at }`), so a session blocked on a question surfaces in the attention order and jump-to-next-attention. The flag is refreshed while the dialog is up and decays two minutes after the last write; an unreadable pane leaves the previous claim to expire rather than guessing.
- `process.spawn` capability, for the pane capture.
- Tests: classification against captured panes (dialog, working line, parked prompt, prose that merely quotes the UI, ANSI), and heartbeat assertions for raising, lowering, unknown panes, other tools, and the host going away.

### Changed

- Attention is screen-driven, not mtime-driven: the chat-activity heuristic (`ATTENTION_WINDOW_MS`, `needsAttention`) is gone, so "working" means the pane says working, not that a file moved.
- No text is written for a row: no `urgent_reason`, no `row-column` cell, no tooltip.

### Removed

- The `row-column` slot and its `ui.state.set` pushes, and `src/integration.ts` with its `AgentIntegrationSnapshot` writer. The api_version-19 route is the one that sets a row's own status, but released hosts reject the manifest that declares it.

### Not included

- Row status (`Waiting` / `Error`) and the unread marker: a plugin cannot set them before api_version 19 (verified against aoe 1.21.0 — a written `status` hook file is ignored for a plugin-declared agent, and the row stays `Idle`).
- Native replies stay off (`replies` omitted): explicit replies need an in-process provider extension hook Freebuff's CLI does not expose, so claiming them would be false.
