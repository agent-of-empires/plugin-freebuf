// What the adapter remembers about a session between processes.
//
// The conversation itself lives in the Freebuff TUI (it is what `--continue`
// reopens), but the adapter has to know *which* chat of a working directory
// belongs to a given ACP session id: Freebuff identifies chats by the directory
// they were started in, several AoE sessions can share one directory, and the
// chat title is the only handle the TUI shows. So the title is recorded here,
// next to the session id, and used to pick the right chat back out of
// `/history` when a session is resumed.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionRecord = {
  /** Working directory the session was created for. */
  cwd: string;
  /** Title Freebuff shows for the chat this session is talking in. */
  title: string | null;
};

export interface SessionStore {
  get(sessionId: string): SessionRecord | undefined;
  set(sessionId: string, record: SessionRecord): void;
}

/** In-memory store: the default in tests, where nothing outlives the process. */
export function memorySessionStore(initial: Record<string, SessionRecord> = {}): SessionStore {
  const records = new Map<string, SessionRecord>(Object.entries(initial));
  return {
    get: (sessionId) => records.get(sessionId),
    set: (sessionId, record) => {
      records.set(sessionId, record);
    },
  };
}

/** Default directory for the on-disk store. */
export function defaultStoreDir(): string {
  return join(process.env.FREEBUFF_ACP_STATE_DIR ?? join(homedir(), ".cache", "freebuff-acp"), "sessions");
}

function recordPath(dir: string, sessionId: string): string {
  // Session ids are adapter-generated (`freebuff-acp-<n>-<random>`), but they
  // are used as file names, so anything unexpected is replaced.
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/**
 * Store backed by one small JSON file per session. Writes are best-effort: a
 * session that cannot be recorded still works, it just cannot be resumed by
 * title if another chat in the same directory is more recent.
 */
export function fileSessionStore(dir: string = defaultStoreDir()): SessionStore {
  return {
    get(sessionId) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(recordPath(dir, sessionId), "utf8"));
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as Partial<SessionRecord>;
          if (typeof record.cwd === "string") {
            return { cwd: record.cwd, title: typeof record.title === "string" ? record.title : null };
          }
        }
      } catch {
        // Missing or unreadable: treated as "never seen this session".
      }
      return undefined;
    },
    set(sessionId, record) {
      try {
        // Session ids and chat titles are private to the user: keep the
        // directory closed to other accounts instead of relying on the umask.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // `mode` only applies to a directory this call creates, so a store
        // directory left wider by an earlier version is tightened here too.
        try {
          chmodSync(dir, 0o700);
        } catch {
          // Not ours to chmod (a shared state dir, or another user's): the
          // record itself is still written 0600 below.
        }
        const path = recordPath(dir, sessionId);
        // Written aside and renamed over the record: a crash mid-write would
        // otherwise leave truncated JSON, which reads back as if the session
        // had never been recorded and would reopen the wrong chat.
        // `wx` and a unique suffix: two writers must never share a staging file,
        // and one must not overwrite the other's half-written record.
        const staged = `${path}.${process.pid}-${randomUUID()}.tmp`;
        writeFileSync(staged, JSON.stringify(record), { mode: 0o600, flag: "wx" });
        renameSync(staged, path);
      } catch {
        // Best-effort: see the doc comment above.
      }
    },
  };
}
