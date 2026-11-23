# Changelog

All notable changes to Freebuf will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [0.1.2](https://github.com/agent-of-empires/plugin-freebuf/releases/tag/v0.1.2) (2026-11-17)

0.1.0 through 0.1.2 shipped without per-version entries. This section records
what 0.1.2 contains -- the version the Agent of Empires featured index pins --
and later versions are written by release-please from the merged commit
subjects.

### Added

- The shipped `aoe-plugin.toml` is now the `api_version = 19` manifest, so installing from the repository root gets the row-status integration: an `[[agent_integrations]]` entry for `freebuff` with `provider_versions` as a semver list (`>=0.2.36, <1.0.0`), a single-string `command`, no `resume_arg`, and the `session.integration` capability. `aoe_version` is pinned to `>=1.21.0, <2.0.0`, the host line that parses this schema. `aoe-plugin.v19.toml` and `test/manifest-v19.test.ts` are gone: the host only ever installs `aoe-plugin.toml`, so the separate variant was never installable from a branch.
- Pane classification (`src/pane.ts`): `aoe session capture` output is stripped of colour and matched against Freebuff's own chrome — a blocking dialog (`Some questions for you`, `Close ✕`, `Do you want to proceed`, `(y/n)`) is `waiting`, the `working... ■ Esc` status line is `running`, anything else is `idle`. This is the rule shape the host's built-in detectors use, read from the same surface.
- Attention came from the pane: every 10 s each `freebuff` session's class decides the host's urgent flag (`/tmp/aoe-hooks-<euid>/<session id>/attention.json`, `0700` dir, `0600` file, `{ urgent, urgent_expires_at }`), so a session blocked on a question surfaces in the attention order and jump-to-next-attention. The flag is refreshed while the dialog is up and decays two minutes after the last write; an unreadable pane leaves the previous claim to expire rather than guessing.
- A dialog that reports a failure is `error`, not `waiting` or `idle`, and it raises the attention flag: only the caption decides (`error`, `failed`, `failure`), so a question whose body happens to mention an error stays `waiting`, and a caption that does not say it reports a failure stays whatever the composer says.
- `process.spawn` capability, for the pane capture.
- Tests: classification against captured panes (dialog, working line, parked prompt, prose that merely quotes the UI, ANSI), and heartbeat assertions for raising, lowering, unknown panes, other tools, and the host going away.
- A blocked Freebuff session can be answered from AoE's terminal session list: the worker parses the `Some questions for you` modal (`src/dialog.ts`), publishes it as an agent-integration `prompt` with `reply_keys: ["F12"]` and a `revision` that changes only when the prompt does, and the manifest now sets `replies = true`. Selecting the session and pressing `a` offers the question's own options.
- The parser reads every shape the modal can pose: the expanded question's single-choice (`○`) and multi-choice (`☐`) options (reported with `multi: true`), the trailing `Custom` row that opens a typed answer, and whether the question is the form's last (which decides whether answering submits it).
- The answer comes back as `integration-agent-of-empires.aoe-freebuf.reply.json` (`src/replies.ts`), validated against the report the worker published: instance, provider session, writer pid, revision, prompt id, response UUID, and only options the prompt offered; a wrong uid/mode, a stale revision, a single choice answered twice, or control characters in typed text is dropped rather than delivered.
- Delivery replays the dialog's own key semantics through `tmux send-keys` (`src/tmux.ts`): single choice is `Down` × index then `Enter` (which selects and advances), multi choice is `Down`/`Enter` per option then `Tab` for Submit, a typed answer is `Down` to the `Custom` row, `Enter`, the text sent literally with `-l` (so a word such as `Enter` inside the answer is not read as a key), and `Enter`; the form's last question then gets the `Enter` that submits it. Every sequence starts with `Up`/`Down`/`Left`/`Down`: `Up` is the only way out of Submit focus (where an answered form waits to be submitted, and every other key is ignored), `Down` steps back from a jump to the previous question, and `Left`/`Down` collapse and re-expand the open question to put the focus back on its first option, so a reply lands on the chosen row even if the dialog had been arrowed around since it opened, and answers already given survive the reset. On a multi-choice question `Enter` toggles, so only options whose checked state differs from the answer are pressed: one already checked and answered is left alone, and one checked but not answered is turned off, so the form submits exactly the answer instead of whatever it happened to have marked. The dialog is read again immediately before the first key, since resolving the tmux target is asynchronous and the question can be answered by hand meanwhile. Delivery reports `sent`, `partial` or `none`: nothing that reached the pane is replayed (a retry would toggle an option back or type the answer twice), so a partly delivered reply is discarded with a note, while one that never left the worker is retried on the next tick. The target is the tmux session whose name ends with `_<first 8 characters of the session id>`, an ambiguous or missing match sends nothing, and only navigation/selection key names are allowed.
- Not done by design: anything automatic. Freebuff stays the approval authority, and a failed delivery leaves the reply file for the next tick.

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

- The `row-column` slot and its `ui.state.set` pushes: the api_version-19 route sets a row's own status directly, so no text is written for a row.
- The experimental `acp-adapter/` package and the CI job that tested it. It drove the Freebuff TUI through a tmux pane, which the Freebuff terms of service do not allow. Nothing in the plugin's shipped surface depended on it.
