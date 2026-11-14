// Pane sources: the injectable `capture()` / `send()` interface the bridge
// talks to, plus the real tmux-backed implementation that hosts the Freebuff
// TUI. Tests substitute a fake implementation of `SessionPane`; nothing in the
// test suite runs tmux or freebuff.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SendOptions = {
  /** Send the keys verbatim instead of interpreting them as tmux key names. */
  literal?: boolean;
  /**
   * Send the same keys this many times, in one tmux call. Clearing a long draft
   * would otherwise spawn one subprocess per character.
   */
  repeat?: number;
};

/**
 * The pane the bridge reads from and writes to. Injectable so tests can drive
 * the bridge with scripted screens instead of a real terminal.
 */
export interface PaneSource {
  /** Raw contents of the pane, including any live ANSI escape sequences. */
  capture(): Promise<string>;
  /** Sends keys to the pane (`C-c`, `Enter`, ...), or literal text with `{ literal: true }`. */
  send(keys: string, options?: SendOptions): Promise<void>;
}

/** A pane plus the lifecycle hook that tears the hosted session down. */
export interface SessionPane extends PaneSource {
  stop(): Promise<void>;
}

export type PaneRequest = {
  /** ACP session id; also used as the tmux session name so they stay in sync. */
  sessionId: string;
  /** Working directory the agent session was created for. */
  cwd: string;
};

export type PaneFactory = (request: PaneRequest) => Promise<SessionPane>;

/** Runs tmux subcommands and returns stdout. */
export type TmuxExec = (args: string[]) => Promise<string>;

export type TmuxPaneOptions = {
  session: string;
  /** Shell command started inside the pane. Defaults to `freebuff --cwd <cwd>`. */
  command?: string;
  cwd?: string;
  tmuxBin?: string;
  /** Override for tests; defaults to spawning the real tmux binary. */
  exec?: TmuxExec;
  cols?: number;
  rows?: number;
};

export const DEFAULT_COMMAND_BIN = "freebuff";

/** Quotes a path for the POSIX shell command tmux runs with `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The default pane command: launch the Freebuff TUI in the session cwd. */
export function freebuffCommand(cwd: string, bin: string = DEFAULT_COMMAND_BIN): string {
  return `${bin} --cwd ${shellQuote(cwd)}`;
}

function defaultExec(tmuxBin: string): TmuxExec {
  return async (args: string[]) => {
    const { stdout } = await execFileAsync(tmuxBin, args);
    return stdout;
  };
}

/**
 * Runs one Freebuff TUI inside a dedicated tmux session and exposes it through
 * the `PaneSource` interface.
 */
export class TmuxPaneSource implements SessionPane {
  private readonly tmuxBin: string;
  private readonly exec: TmuxExec;
  // Declared explicitly instead of as a constructor parameter property: those
  // are not erasable syntax, so Node's TypeScript strip-only mode rejects them.
  private readonly options: TmuxPaneOptions;

  constructor(options: TmuxPaneOptions) {
    this.options = options;
    this.tmuxBin = options.tmuxBin ?? "tmux";
    this.exec = options.exec ?? defaultExec(this.tmuxBin);
  }

  /** Creates the detached tmux session and starts the TUI inside it. */
  async start(): Promise<void> {
    const { session, cwd } = this.options;
    const command = this.options.command ?? freebuffCommand(cwd ?? process.cwd());
    const args = ["new-session", "-d", "-s", session];
    if (cwd !== undefined) {
      args.push("-c", cwd);
    }
    args.push("-x", String(this.options.cols ?? 220), "-y", String(this.options.rows ?? 50), command);
    await this.exec(args);
    trackPane(session);
  }

  async capture(): Promise<string> {
    // `-e` keeps escape sequences so the caller sees exactly what a terminal
    // would; `stripAnsi` runs on the diffing side.
    return await this.exec(["capture-pane", "-p", "-e", "-t", this.options.session]);
  }

  async send(keys: string, options?: SendOptions): Promise<void> {
    const args = ["send-keys", "-t", this.options.session];
    if (options?.literal) {
      args.push("-l");
    }
    args.push("--");
    // Separate arguments are separate keys, so a repeat goes in one call.
    for (let i = 0; i < Math.max(1, options?.repeat ?? 1); i += 1) {
      args.push(keys);
    }
    await this.exec(args);
  }

  async stop(): Promise<void> {
    untrackPane(this.options.session);
    try {
      await this.exec(["kill-session", "-t", this.options.session]);
    } catch {
      // Already gone: stopping twice is not an error.
    }
  }
}

/** True when the tmux session behind `session` still exists. */
export async function tmuxSessionExists(session: string, tmuxBin = "tmux"): Promise<boolean> {
  try {
    await defaultExec(tmuxBin)(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the factory used by `session/new`: spawns `freebuff --cwd <cwd>` in a
 * dedicated tmux session named after the ACP session id.
 */
export function createTmuxPaneFactory(
  options: { tmuxBin?: string; command?: string; cols?: number; rows?: number } = {},
): PaneFactory {
  return async (request) => {
    const pane = new TmuxPaneSource({
      session: request.sessionId,
      cwd: request.cwd,
      tmuxBin: options.tmuxBin,
      command: options.command,
      cols: options.cols,
      rows: options.rows,
    });
    await pane.start();
    return pane;
  };
}

const liveSessions = new Set<string>();

/** Registers a session so `stopAllPanes` can tear it down on process exit. */
export function trackPane(session: string): void {
  liveSessions.add(session);
}

/** Unregisters a session after it has been stopped. */
export function untrackPane(session: string): void {
  liveSessions.delete(session);
}

/**
 * Best-effort teardown of every tmux session this process started. The sync
 * kill is used from a process `exit` handler, where async work cannot finish.
 */
export function stopAllPanes(sync = false): void {
  for (const session of liveSessions) {
    try {
      if (sync) {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      } else {
        void execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => {});
      }
    } catch {
      // Session already gone or tmux unavailable: nothing to clean up.
    }
    liveSessions.delete(session);
  }
}
