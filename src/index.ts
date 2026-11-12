// Agent of Empires worker: JSON-RPC 2.0 over newline-delimited JSON on stdio.
//
// The host spawns this process, sends one JSON-RPC request per line on stdin,
// and reads one response per line on stdout. The worker also sends its own
// requests (sessions.list) and receives notifications on the same stream, so
// incoming messages are multiplexed: a message with a `method` is a host
// request (answer it), one without is a response to a request we sent (settle
// it, never answer), and one without an id is a notification (ignore).
//
// Every tick the worker reads each freebuff session's own screen, classifies it
// the way the host classifies its built-in agents (blocking question dialog ->
// waiting, error dialog -> error, working status line -> running, otherwise
// parked), and raises or lowers the host's attention flag from that. The flag is
// what the attention order and jump-to-next-attention read, so a session blocked
// on a question surfaces exactly like a native agent's Waiting row -- without a
// text column.

import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { clearUrgent, hookBase, instanceHookDir, writeUrgent } from "./attention.js";
import { allProjectActivities, configDir, latestChat, providerVersion } from "./freebuff.js";
import { buildSnapshot, writeReport } from "./integration.js";
import { capturePane, classifyPane } from "./pane.js";
import { MethodNotFoundError, RpcResponse, errorResponse, resultResponse } from "./rpc.js";

const RUNTIME = "node";

/** Sessions are listed and flagged for this tool only. */
const TOOL = "freebuff";

/** One capture per session per tick; a slower tick keeps the pane load sane. */
const HEARTBEAT_MS = 10_000;

/** How long a raised flag survives without a fresh tick, so a dead worker decays. */
export const FLAG_TTL_MS = 2 * 60_000;

/** Captures in flight at once, so a long session list cannot stall the tick. */
const CAPTURE_CONCURRENCY = 4;

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
    const root = configDir();
    const version = providerVersion(root);
    const activities = allProjectActivities(root);
    const running = activities.filter((activity) => activity.status === "running").length;
    return {
      ok: true,
      runtime: RUNTIME,
      message:
        version === null
          ? "Freebuf worker is running; no Freebuff runtime state found"
          : `Freebuf worker is running · freebuff ${version} · ${running} of ${activities.length} projects active`,
      provider_version: version,
      projects: activities.length,
      running,
    };
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

// --- attention heartbeat ---------------------------------------------------

export interface HeartbeatOptions {
  configRoot?: string;
  hookBase?: string;
  now?: number;
  /** Pane reader, injectable for tests. Null means the pane is unknown. */
  capture?: (sessionId: string) => Promise<string | null>;
}

/**
 * Classify each freebuff session's screen and set the host's attention flag
 * from it. A session whose pane cannot be read keeps whatever claim it had and
 * lets the expiry retire it, rather than guessing.
 */
export async function heartbeat(options: HeartbeatOptions = {}): Promise<void> {
  const base = options.hookBase ?? hookBase();
  const capture = options.capture ?? capturePane;
  const root = options.configRoot ?? configDir();
  const now = options.now ?? Date.now();
  const version = providerVersion(root);
  let payload: unknown;
  try {
    payload = await sendRequest("sessions.list", { exclude: ["archived", "snoozed", "trashed"] });
  } catch (err) {
    note(`sessions.list failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const sessions = (payload as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) {
    note(`sessions.list returned no session array: ${JSON.stringify(payload)?.slice(0, 200)}`);
    return;
  }
  const targets: Array<{ id: string; projectPath: string }> = [];
  for (const session of sessions) {
    if (session === null || typeof session !== "object") continue;
    const row = session as Record<string, unknown>;
    if (row.tool !== TOOL || typeof row.id !== "string") continue;
    targets.push({ id: row.id, projectPath: typeof row.project_path === "string" ? row.project_path : "" });
  }
  if (!listed) {
    listed = true;
    const tools = sessions
      .slice(0, 5)
      .map((row) => String((row as Record<string, unknown>)?.tool))
      .join(",");
    note(`${targets.length} freebuff of ${sessions.length} listed (tools: ${tools})`);
  }
  for (let index = 0; index < targets.length; index += CAPTURE_CONCURRENCY) {
    const batch = targets.slice(index, index + CAPTURE_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ id, projectPath }) => {
        const pane = await capture(id);
        if (pane === null) {
          note(`pane capture failed for ${id}`); // unknown: leave the claim to decay
          return;
        }
        const dir = instanceHookDir(id, base);
        const state = classifyPane(pane);
        if (seen.get(id) !== state) {
          seen.set(id, state);
          note(`${id}: ${state}`);
        }
        try {
          // Both blocking states need the user: a question wants an answer, an
          // error dialog wants a dismissal. Anything else is not blocked on us.
          if (state === "waiting" || state === "error") writeUrgent(dir, now + FLAG_TTL_MS);
          else clearUrgent(dir);
          // The host reads this report as the row's own status.
          writeReport(
            dir,
            buildSnapshot({
              instanceId: id,
              providerVersion: version ?? "",
              providerSessionId: projectPath === "" ? "" : (latestChat(root, projectPath)?.chatId ?? ""),
              status: state,
              writerPid: process.pid,
            }),
          );
        } catch (err) {
          // Not writable, or the path was squatted: skip this session this tick.
          note(`flag write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let announced = false;
let listed = false;
const seen = new Map<string, string>();

/**
 * One line on the worker's stderr, which the host keeps in its worker log.
 * Failures are worth a line; successful ticks are not.
 */
function note(message: string): void {
  process.stderr.write(`freebuf: ${message}\n`);
}

export function startHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  // First tick waits one interval: a one-shot manual run (echo request | node
  // dist/index.js) exits at EOF before ever writing an outbound request.
  heartbeatTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void heartbeat()
      .then(() => {
        if (!announced) {
          announced = true;
          note("pane heartbeat running");
        }
      })
      .finally(() => {
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
