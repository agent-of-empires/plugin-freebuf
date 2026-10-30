# Changelog

All notable changes to Freebuf will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- Declare one `[[agent_integrations]]` block (`tool = "freebuff"`, `provider_versions = [">=0.2.0, <1.0.0"]`, `command = "freebuff"`), giving AoE launch and discovery for Freebuff (agent picker, `aoe agents`, `session.default_tool`).
- Native status-only session reporting: the worker heartbeats an `AgentIntegrationSnapshot` per freebuff session every 5 s (running/idle, derived from Freebuff's local chat activity under `~/.config/manicode`), so session rows show real status. No state or unknown runtime version means no report, and the host falls back to pane detection.
- Declared `session.integration`, `session.read`, `fs.read`, and `fs.write` capabilities, required for the status path above.
- Tests: a dependency-free manifest parser asserting `api_version = 19`, exactly one `freebuff` integration, schema-only keys, and the `session.integration`/`provider_versions` invariant; plus coverage for the state probe, report writer, and RPC multiplexing.

### Changed

- Bump manifest `api_version` from 6 to 19 to match the host's agent-integration schema.

### Not included

- Native replies stay off (`replies` omitted): explicit replies need an in-process provider extension hook Freebuff's CLI does not expose, so claiming them would be false.
