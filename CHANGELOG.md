# Changelog

All notable changes to Freebuf will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- The shipped `aoe-plugin.toml` is now the `api_version = 19` manifest, so installing from the repository root gets the row-status integration: an `[[agent_integrations]]` entry for `freebuff` with `provider_versions` as a semver list (`>=0.2.36, <1.0.0`), a single-string `command`, no `resume_arg`, and the `session.integration` capability. `aoe_version` is pinned to `>=1.21.0, <2.0.0`, the host line that parses this schema. `aoe-plugin.v19.toml` and `test/manifest-v19.test.ts` are gone: the host only ever installs `aoe-plugin.toml`, so the separate variant was never installable from a branch.
- Pane classification (`src/pane.ts`): `aoe session capture` output is stripped of colour and matched against Freebuff's own chrome — a blocking dialog (`Some questions for you`, `Close ✕`, `Do you want to proceed`, `(y/n)`) is `waiting`, the `working... ■ Esc` status line is `running`, anything else is `idle`. This is the rule shape the host's built-in detectors use, read from the same surface.
- Attention came from the pane: every 10 s each `freebuff` session's class decides the host's urgent flag (`/tmp/aoe-hooks-<euid>/<session id>/attention.json`, `0700` dir, `0600` file, `{ urgent, urgent_expires_at }`), so a session blocked on a question surfaces in the attention order and jump-to-next-attention. The flag is refreshed while the dialog is up and decays two minutes after the last write; an unreadable pane leaves the previous claim to expire rather than guessing.
- `process.spawn` capability, for the pane capture.
- Tests: classification against captured panes (dialog, working line, parked prompt, prose that merely quotes the UI, ANSI), and heartbeat assertions for raising, lowering, unknown panes, other tools, and the host going away.

### Fixed

- Blocking dialogs are found structurally, and only their caption decides: a boxed panel carrying `Close ✕` under its captioned border, with no composer drawn beneath it. A dialog replaces the composer, so a box with a composer under it is output, and a session that quotes the panel in prose, echoes it back in a prompt, or prints it from a tool no longer reads as `waiting` or raises attention. The old unscoped text rules (`Some questions for you`, a bare `Close ✕`, `Do you want to…`, `(y/n)` anywhere in the pane) are gone.
- An error dialog (its caption says error/failed) is reported as `error` instead of as a question, so the row's own status tells the two apart.
- Confirmation prompts outside a dialog are still `waiting`, but only where they are asked: the inline `(y/n)` prompt, `Do you want to…` and the concurrent-session limit modal count in the rows just above the composer, so the same words quoted further up the scrollback no longer block a session.
- A tall question dialog is recognised like a short one: the caption is read from the close row just under it, not from a fixed window at the bottom of the pane.
- A working session whose composer holds a queued message no longer reads as `idle`: `working...` / `thinking...` sits above the "Your message is saved" panel, so that panel anchors the status line the way the prompt box does.
- A working session no longer reads as `idle`: Freebuff 0.2.36 wraps the input prompt in a rounded box, so the `working...` / `thinking...` status line is no longer directly above `❯`. The status line now counts when only the input box's borders and blank rows separate it from the prompt (a typed draft still counts), while the same words quoted in transcript prose are still ignored.

### Changed

- Attention is screen-driven, not mtime-driven: the chat-activity heuristic (`ATTENTION_WINDOW_MS`, `needsAttention`) is gone, so "working" means the pane says working, not that a file moved.
- The manifest carries the agent-integration contract itself instead of a release-time file swap that no install path performed.
- No text is written for a row: no `urgent_reason`, no `row-column` cell, no tooltip.

### Removed

- The `row-column` slot and its `ui.state.set` pushes, and `src/integration.ts` with its `AgentIntegrationSnapshot` writer. The api_version-19 route is the one that sets a row's own status, but released hosts reject the manifest that declares it.

### Not included

- Row status (`Waiting` / `Error`) and the unread marker: a plugin cannot set them before api_version 19 (verified against aoe 1.21.0 — a written `status` hook file is ignored for a plugin-declared agent, and the row stays `Idle`).
- Native replies stay off (`replies` omitted): explicit replies need an in-process provider extension hook Freebuff's CLI does not expose, so claiming them would be false.
