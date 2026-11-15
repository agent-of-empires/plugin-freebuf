// The AgentIntegrationSnapshot half of the host's agent-integration contract
// (aoe-plugin-api/src/agent_integration.rs): a JSON report the host reads from
// the session's private hook directory, `/tmp/aoe-hooks-<euid>/`, and uses to
// override the session row's status and to offer its prompt to the user.
// Directory mode must be 0700 and the report 0600, owned by the effective uid,
// at most 64 KiB and no more than 15 seconds old, written by a live pid -- so
// it is rewritten every heartbeat tick regardless of whether the status
// changed.
//
// The same pane classification that drives the attention flag (src/pane.ts) is
// written here too, so the row's status and the attention flag never disagree.
// The report is one small JSON file per session per tick.
//
// A report that carries a `prompt` is what turns a blocked session into a
// quick response: the host opens its reply dialog for the row, validates the
// answer, and writes it to the reply sidecar (src/replies.ts) -- then wakes the
// provider by sending the report's `reply_keys` into the pane. `revision`
// changes exactly when the prompt does, and the host echoes it back in the
// reply so an answer to a prompt that has since changed is dropped.

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { PaneState } from "./pane.js";

/** Must match `id` in aoe-plugin.toml: the report file is named after it. */
export const PLUGIN_ID = "agent-of-empires.aoe-freebuf";


/** Report file schema version; the host requires exactly 1. */
export const SCHEMA_VERSION = 1;

export interface IntegrationPromptOption {
  label: string;
  description?: string;
}

export interface IntegrationPromptQuestion {
  id: string;
  question: string;
  options: IntegrationPromptOption[];
  multi?: boolean;
  recommended?: number;
}

/** The two prompt shapes the host renders; this plugin publishes questions. */
export type IntegrationPrompt =
  | { kind: "approval"; id: string; title: string; allow_always: boolean }
  | { kind: "question"; id: string; title: string; questions: IntegrationPromptQuestion[] };

export interface AgentIntegrationSnapshot {
  schema_version: number;
  instance_id: string;
  provider_version: string;
  provider_session_id: string;
  writer_pid: number;
  revision: number;
  status: PaneState;
  reply_keys: string[];
  prompt: IntegrationPrompt | null;
}

/**
 * The wake key the host sends into the pane after the user submits a reply.
 * It only has to be a key Freebuff leaves alone; the worker reads the answer
 * from the reply file, not from the keypress.
 */
export const REPLY_WAKE_KEY = "F12";

export function buildSnapshot(input: {
  instanceId: string;
  providerVersion: string;
  providerSessionId: string;
  status: PaneState;
  writerPid: number;
  revision?: number;
  prompt?: IntegrationPrompt | null;
}): AgentIntegrationSnapshot {
  const prompt = input.prompt ?? null;
  return {
    schema_version: SCHEMA_VERSION,
    instance_id: input.instanceId,
    provider_version: input.providerVersion,
    provider_session_id: input.providerSessionId,
    writer_pid: input.writerPid,
    // Changes only when the prompt does, never for a status change.
    revision: input.revision ?? 0,
    status: input.status,
    // Required for a reply-enabled integration: the host refuses a prompt from
    // a report that supplies no wake key.
    reply_keys: prompt === null ? [] : [REPLY_WAKE_KEY],
    prompt,
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
