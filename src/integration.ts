// The status-only AgentIntegrationSnapshot half of the host's agent-integration
// contract (aoe-plugin-api/src/agent_integration.rs): a JSON report the host
// reads from the session's private hook directory, `/tmp/aoe-hooks-<euid>/`,
// and uses to override the session row's status. Directory mode must be 0700
// and the report 0600, owned by the effective uid, at most 64 KiB and no more
// than 15 seconds old, written by a live pid -- so it is rewritten every
// heartbeat tick regardless of whether the status changed.
//
// The same pane classification that drives the attention flag (src/pane.ts) is
// written here too, so the row's status and the attention flag never disagree.
// The report is one small JSON file per session per tick.

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { PaneState } from "./pane.js";

/** Must match `id` in aoe-plugin.toml: the report file is named after it. */
export const PLUGIN_ID = "dev.example.aoe-freebuf";

/** Report file schema version; the host requires exactly 1. */
export const SCHEMA_VERSION = 1;

export interface AgentIntegrationSnapshot {
  schema_version: number;
  instance_id: string;
  provider_version: string;
  provider_session_id: string;
  writer_pid: number;
  revision: number;
  status: PaneState;
  reply_keys: string[];
  prompt: null;
}

export function buildSnapshot(input: {
  instanceId: string;
  providerVersion: string;
  providerSessionId: string;
  status: PaneState;
  writerPid: number;
}): AgentIntegrationSnapshot {
  return {
    schema_version: SCHEMA_VERSION,
    instance_id: input.instanceId,
    provider_version: input.providerVersion,
    provider_session_id: input.providerSessionId,
    writer_pid: input.writerPid,
    // `revision` and `reply_keys` only matter for prompts, and replies are off:
    // status-only reports never change a prompt, so the revision stays 0.
    revision: 0,
    status: input.status,
    reply_keys: [],
    prompt: null,
  };
}

/** The host's per-user hook base: `/tmp/aoe-hooks-<effective uid>`. */
export function hookBase(euid: number = os.userInfo().uid): string {
  return `/tmp/aoe-hooks-${euid}`;
}

/** The per-instance directory the host reads the report from. */
export function instanceHookDir(instanceId: string, base: string = hookBase()): string {
  return path.join(base, instanceId);
}

function ensureDir(dir: string): void {
  // Create first (mode subject to umask), then force the exact mode the host
  // verifies: any group/world bit makes the host reject the whole directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Write the report for one session atomically (temp file + rename, so the host
 * never reads a half-written JSON). Throws on failure; the caller skips that
 * session for the tick.
 */
export function writeReport(dir: string, snapshot: AgentIntegrationSnapshot): void {
  ensureDir(dir);
  const filename = `integration-${PLUGIN_ID}.json`;
  const temp = path.join(dir, `.${filename}.${process.pid}.tmp`);
  const target = path.join(dir, filename);
  try {
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(temp, 0o600); // defeat a permissive umask; host requires exactly 0600
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }
}
