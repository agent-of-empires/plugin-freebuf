// Agent of Empires worker: JSON-RPC 2.0 over newline-delimited JSON on stdio.
//
// The host spawns this process, sends one JSON-RPC request per line on stdin,
// and reads one response per line on stdout. The worker also sends its own
// requests (sessions.list) and receives notifications on the same stream, so
// incoming messages are multiplexed: a message with a `method` is a host
// request (answer it), one without is a response to a request we sent (settle
// it, never answer), and one without an id is a notification (ignore).
//
// Every heartbeat tick the worker reads Freebuff's local chat state and
// rewrites a status-only AgentIntegrationSnapshot per freebuff session into
// the host's hook directory, which is what makes the session rows show real
// running/idle status. When the host is unreachable, Freebuff has no state for
// a session, or this worker exits, the report simply goes missing or stale and
// the host falls back to its own pane detection.

import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { configDir, latestChat, providerVersion, statusForActivity } from "./freebuff.js";
import { buildSnapshot, instanceHookDir, writeReport } from "./integration.js";
import { MethodNotFoundError, RpcResponse, errorResponse, resultResponse } from "./rpc.js";

const RUNTIME = "node";

/** Sessions are listed and reported for this tool only. */
const TOOL = "freebuff";
const HEARTBEAT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
// Outbound ids live in their own range so a host request id can never collide
// with an id this worker is waiting on.
const ID_BASE = 900_000;

export function handle(method: string, _params: Record<string, unknown>): Record<string, unknown> {
  // The host maps a command id to a method; dispatch on the trailing segment so
  // the worker is robust to the host's exact method prefix. A real handler reads
  // `_params` for the request arguments.
  const command = method.split(".").pop();
  if (command === "status") {
    return { ok: true, runtime: RUNTIME, message: "Freebuf worker is running" };
  }
  throw new MethodNotFoundError(method);
}

// --- outbound requests -----------------------------------------------------

type Outbound = (line: string) => void;

let outbound: Outbound = (line) => {
  process.stdout.write(line + "\n");
};

/** Swap the outbound sink; passing null restores writing to stdout. Tests use this. */
export function setOutbound(writer: Outbound | null): void {
  outbound = writer ?? ((line) => process.stdout.write(line + "\n"));
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();
let requestCounter = 0;

/** Send a request to the host and await its response. */
export function sendRequest(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = ID_BASE + ++requestCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`host request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    outbound(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function settleResponse(message: Record<string, unknown>): void {
  const id = message.id;
  if (typeof id !== "number") return;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  const error = message.error;
  if (error !== null && typeof error === "object") {
    const detail = error as { message?: unknown };
    entry.reject(new Error(typeof detail.message === "string" ? detail.message : "host returned an error"));
  } else {
    entry.resolve(message.result);
  }
}

function rejectAllPending(reason: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(reason));
  }
}

// --- line handling ---------------------------------------------------------

export function processLine(line: string): RpcResponse | null {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return null;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return null; // not a JSON-RPC object: ignore
  }
  const message = request as Record<string, unknown>;
  const id = message.id;
  if (id === undefined || id === null) {
    return null; // a notification: no response
  }
  if (!("method" in message)) {
    // A response to a request this worker sent (sessions.list, ...). Settle it
    // and stay silent: the host would treat any reply as a protocol error.
    settleResponse(message);
    return null;
  }
  try {
    const params = message.params;
    const result = handle(
      String(message.method ?? ""),
      params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
    );
    return resultResponse(id, result);
  } catch (err) {
    return errorResponse(id, err);
  }
}

// --- status heartbeat ------------------------------------------------------

export interface HeartbeatOptions {
  configRoot?: string;
  base?: string;
  now?: number;
}

/**
 * List the host's sessions, and for every freebuff session with local state
 * write a fresh status report. Sessions without local state (never chatted
 * here) and ticks where the host does not answer are skipped on purpose: no
 * report is what makes the host keep its own detection.
 */
export async function heartbeat(options: HeartbeatOptions = {}): Promise<void> {
  const root = options.configRoot ?? configDir();
  const now = options.now ?? Date.now();
  const version = providerVersion(root);
  if (version === null) {
    return;
  }
  let payload: unknown;
  try {
    payload = await sendRequest("sessions.list", { exclude: ["archived", "snoozed", "trashed"] });
  } catch {
    return;
  }
  const sessions = (payload as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) {
    return;
  }
  for (const session of sessions) {
    if (session === null || typeof session !== "object") continue;
    const row = session as Record<string, unknown>;
    if (row.tool !== TOOL || typeof row.id !== "string" || typeof row.project_path !== "string") continue;
    const chat = latestChat(root, row.project_path);
    if (chat === null) continue;
    try {
      writeReport(
        instanceHookDir(row.id, options.base),
        buildSnapshot({
          instanceId: row.id,
          providerVersion: version,
          providerSessionId: chat.chatId,
          status: statusForActivity(now - chat.lastActivityMs),
          writerPid: process.pid,
        }),
      );
    } catch {
      // One unwritable report must not stall the other sessions' heartbeats.
    }
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  // First tick waits one interval: a one-shot manual run (echo request | node
  // dist/index.js) exits at EOF before ever writing an outbound request.
  heartbeatTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void heartbeat().finally(() => {
      ticking = false;
    });
  }, HEARTBEAT_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  rejectAllPending("worker shutting down");
}

export function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    const response = processLine(trimmed);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
  // stdin EOF is the host saying goodbye: stop timers so the process can exit.
  rl.on("close", () => {
    stopHeartbeat();
  });
  startHeartbeat();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
