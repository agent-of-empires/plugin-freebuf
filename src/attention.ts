// "This session is blocked on you", for hosts that do not parse agent
// integrations yet.
//
// Agent of Empires ranks session rows by status tier and then floats rows
// flagged urgent above non-urgent peers in the same tier -- that is what the
// TUI's jump-to-next-attention lands on and what the web sidebar's Attention
// sort uses. The flag is not a plugin RPC: the host reads it on demand from the
// session's own hook directory, `/tmp/aoe-hooks-<euid>/<instance id>/attention.json`
// (`Instance::is_urgent()` -> `hooks::read_hook_urgent`), so writing that file
// works for any session, plugin-declared agent or not.
//
// Two constraints come from the host reader, not from taste:
//   - the instance directory must be exactly 0700 and owned by the effective
//     uid, or the host ignores the whole directory;
//   - the file is JSON `{ "urgent": true, "urgent_expires_at": <epoch seconds> }`.
//     A flag past its expiry reads as not urgent, which is how a claim decays
//     even if this worker dies mid-turn.
//
// There is deliberately no `urgent_reason`: the row speaks for itself.
//
// The `status` file beside it (`running` / `waiting` / `idle` / `error`) is NOT
// usable here: released hosts read it only for agents whose detection manifest
// declares a hook rule, and a plugin-declared agent has none. Measured against
// aoe 1.21.0, writing it leaves the row's status untouched. Setting a row's own
// status is exactly what api_version 19's AgentIntegrationSnapshot adds.

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** The host's per-user hook base: `/tmp/aoe-hooks-<effective uid>`. */
export function hookBase(euid: number = os.userInfo().uid): string {
  return `/tmp/aoe-hooks-${euid}`;
}

/** The per-instance directory the host reads the flag from. */
export function instanceHookDir(instanceId: string, base: string = hookBase()): string {
  return path.join(base, instanceId);
}

function ensureDir(dir: string): void {
  // Create first (mode subject to umask), then force the exact mode the host
  // verifies: any group/world bit makes the host reject the whole directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function flagPath(dir: string): string {
  return path.join(dir, "attention.json");
}

/**
 * Raise the urgent flag for one session until `expiresAtMs`. Rewritten every
 * tick while the claim holds, so the expiry never drifts out from under a live
 * session. Throws on failure; the caller skips that session for the tick.
 */
export function writeUrgent(dir: string, expiresAtMs: number): void {
  ensureDir(dir);
  const target = flagPath(dir);
  const temp = path.join(dir, `.attention.json.${process.pid}.tmp`);
  const body = JSON.stringify({ urgent: true, urgent_expires_at: Math.floor(expiresAtMs / 1000) });
  try {
    writeFileSync(temp, body, { mode: 0o600 });
    chmodSync(temp, 0o600); // defeat a permissive umask
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

/** Lower the flag. Absent already counts as lowered, so this is idempotent. */
export function clearUrgent(dir: string): void {
  try {
    unlinkSync(flagPath(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
