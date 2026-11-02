// Where the Freebuff runtime keeps its local state, and how to read a
// project's activity out of it.
//
// The npm `freebuff` package is only a launcher; the real runtime downloads
// itself into `~/.config/manicode` (the path its launcher.js hardcodes) and
// keeps, per project, `projects/<project dir>/chats/<chat id>/` state files
// that are rewritten while a chat is active. That is the only honest local
// signal of "is this freebuff session working right now": the CLI exposes no
// status subcommand and no extension hook.

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";

/** How stale chat activity may be before a session counts as no longer running. */
export const ACTIVITY_WINDOW_MS = 30_000;

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

/**
 * The freshest chat activity for one project directory name, or null when
 * Freebuff has never recorded a chat there. Reads only directory listings and
 * stat mtimes, never file bodies.
 */
function newestChat(configRoot: string, project: string): ChatActivity | null {
  const chatsDir = path.join(configRoot, "projects", project, "chats");
  let chatIds: string[];
  try {
    chatIds = readdirSync(chatsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  let best: ChatActivity | null = null;
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
    if (newest > 0 && (best === null || newest > best.lastActivityMs)) {
      best = { chatId, lastActivityMs: newest };
    }
  }
  return best;
}

/**
 * The freshest chat activity for the project rooted at `projectPath`, or null
 * when Freebuff has never recorded a chat there (so there is nothing to
 * claim).
 */
export function latestChat(configRoot: string, projectPath: string): ChatActivity | null {
  return newestChat(configRoot, path.basename(projectPath));
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
  const chat = newestChat(configRoot, project);
  if (chat === null) return null;
  return {
    project,
    chatId: chat.chatId,
    lastActivityMs: chat.lastActivityMs,
    status: statusForActivity(now - chat.lastActivityMs),
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
