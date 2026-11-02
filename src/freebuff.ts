// Where the Freebuff runtime keeps its local state, and how to read a
// project's activity out of it.
//
// The npm `freebuff` package is only a launcher; the real runtime downloads
// itself into `~/.config/manicode` (the path its launcher.js hardcodes) and
// keeps, per project, `projects/<project dir>/chats/<chat id>/` state files
// that are rewritten while a chat is active.
//
// Two signals live there, and they answer different questions:
//   - the newest state-file mtime says *when* something last happened;
//   - `log.jsonl` says *what* happened last. The runtime logs one
//     `Start agent <template> step N` line per step and a matching
//     `End agent <template> step N`, then `Main prompt finished` at the end of a
//     turn. Freebuff writes those per step, not continuously, so a step that
//     runs for minutes leaves a stale mtime while the agent is plainly working.
//     A Start with no later End or turn-finished line is a step in flight --
//     definitive, and independent of any wall-clock window.
//
// So the log decides when it can, and the mtime window is the fallback for a
// log that is missing, unreadable, or has no step lines yet. Only the tail of
// the log is read: it grows to hundreds of KB.

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** How stale chat activity may be before a session counts as no longer running. */
export const ACTIVITY_WINDOW_MS = 30_000;

/** Bytes of `log.jsonl` read from the end; enough for many steps, not the file. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** The runtime's config directory; overridable for tests and unusual installs. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FREEBUFF_CONFIG_DIR || path.join(os.homedir(), ".config", "manicode");
}

export interface ChatActivity {
  /** The chat directory name, Freebuff's own identity for the conversation. */
  chatId: string;
  /** Epoch ms of the most recent state-file write across the project's chats. */
  lastActivityMs: number;
}

/** What the chat's own log proves about the turn. */
export type StepState = "running" | "idle";

const STEP_START = /^Start agent .+ step \d+/;
const STEP_END = /^End agent .+ step \d+/;
const TURN_FINISHED = "Main prompt finished";

/**
 * Read at most `maxBytes` from the end of a file, reporting whether the window
 * covers the whole file. Returns null when the file cannot be opened or read.
 */
function readLogTail(file: string, maxBytes: number): { text: string; whole: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break; // rotated or truncated under us
      read += chunk;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), whole: start === 0 };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing left to release.
    }
  }
}

/**
 * The in-flight verdict from one chat's `log.jsonl` tail, or null when the log
 * is missing, unreadable, or its tail holds no step or turn lines (so the
 * caller should fall back to mtimes).
 *
 * The last relevant line wins: a Start is in flight, an End or
 * `Main prompt finished` is not -- including when a fresh End merely happened
 * seconds ago. A later Start after a matched pair opens a new step.
 */
export function stepStateFromLog(chatDir: string): StepState | null {
  const tail = readLogTail(path.join(chatDir, "log.jsonl"), LOG_TAIL_BYTES);
  if (tail === null) return null;
  const lines = tail.text.split("\n");
  // A line only counts once a newline follows it: the first segment is a
  // fragment when the window began mid-file, and the last is a write still in
  // progress when the file does not end in a newline. Both are dropped.
  if (!tail.whole) lines.shift();
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.pop();

  let state: StepState | null = null;
  for (const line of lines) {
    if (line === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn or non-JSON record proves nothing either way
    }
    if (record === null || typeof record !== "object") continue;
    const msg = (record as { msg?: unknown }).msg;
    if (typeof msg !== "string") continue;
    if (STEP_START.test(msg)) state = "running";
    else if (STEP_END.test(msg) || msg === TURN_FINISHED) state = "idle";
  }
  return state;
}

interface ChatEntry extends ChatActivity {
  chatDir: string;
}

/**
 * Every chat directory for one project, freshest first. Reads only directory
 * listings and stat mtimes, never file bodies.
 */
function chatsFor(configRoot: string, project: string): ChatEntry[] {
  const chatsDir = path.join(configRoot, "projects", project, "chats");
  let chatIds: string[];
  try {
    chatIds = readdirSync(chatsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const chats: ChatEntry[] = [];
  for (const chatId of chatIds) {
    const chatDir = path.join(chatsDir, chatId);
    let newest = 0;
    try {
      for (const file of readdirSync(chatDir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        try {
          const mtimeMs = statSync(path.join(chatDir, file.name)).mtimeMs;
          if (mtimeMs > newest) newest = mtimeMs;
        } catch {
          // The runtime rewrote the file mid-scan; the next heartbeat re-reads it.
        }
      }
    } catch {
      continue;
    }
    if (newest > 0) chats.push({ chatId, chatDir, lastActivityMs: newest });
  }
  chats.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return chats;
}

/**
 * The freshest chat activity for the project rooted at `projectPath`, or null
 * when Freebuff has never recorded a chat there (so there is nothing to
 * claim).
 */
export function latestChat(configRoot: string, projectPath: string): ChatActivity | null {
  const [chat] = chatsFor(configRoot, path.basename(projectPath));
  if (chat === undefined) return null;
  return { chatId: chat.chatId, lastActivityMs: chat.lastActivityMs };
}

/** Map activity age to the status we are willing to claim. */
export function statusForActivity(ageMs: number): "running" | "idle" {
  return ageMs <= ACTIVITY_WINDOW_MS ? "running" : "idle";
}

export interface ProjectActivity {
  /** Freebuff's project directory name, which is the project basename. */
  project: string;
  chatId: string;
  lastActivityMs: number;
  status: "running" | "idle";
}

function activityFor(configRoot: string, project: string, now: number): ProjectActivity | null {
  const chats = chatsFor(configRoot, project);
  const [newest] = chats;
  if (newest === undefined) return null;

  // Usually the freshest chat is the live one. But a quieter chat can be the
  // one with a step in flight, and its Start/End pair outranks the fresher
  // chat's mtime, so scan for it before settling on the newest.
  let chosen = newest;
  let state = stepStateFromLog(newest.chatDir);
  if (state !== "running") {
    for (const chat of chats.slice(1)) {
      const candidate = stepStateFromLog(chat.chatDir);
      if (candidate === "running") {
        chosen = chat;
        state = candidate;
        break;
      }
    }
  }
  return {
    project,
    chatId: chosen.chatId,
    lastActivityMs: chosen.lastActivityMs,
    status: state ?? statusForActivity(now - chosen.lastActivityMs),
  };
}

/** Every project Freebuff has chat state for, for the status command. */
export function allProjectActivities(configRoot: string, now: number = Date.now()): ProjectActivity[] {
  let projects: string[];
  try {
    projects = readdirSync(path.join(configRoot, "projects"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const activities: ProjectActivity[] = [];
  for (const project of projects) {
    const activity = activityFor(configRoot, project, now);
    if (activity !== null) activities.push(activity);
  }
  return activities;
}

/**
 * The installed runtime version from `freebuff-metadata.json`, or null when
 * unreadable. A null version means no report is written this tick, so the
 * host keeps its own pane detection rather than a version it cannot verify.
 */
export function providerVersion(configRoot: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(path.join(configRoot, "freebuff-metadata.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof meta.version === "string" && meta.version !== "" ? meta.version : null;
  } catch {
    return null;
  }
}
