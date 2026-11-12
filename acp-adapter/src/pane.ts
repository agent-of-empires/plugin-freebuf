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
  /** Start by continuing the working directory's most recent chat (`--continue`). */
  resume?: boolean;
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
  /**
   * Process whose death takes the pane with it. Defaults to this process; pass
   * `0` to leave the pane unattended (tests). See `watchdogCommand`.
   */
  watchParentPid?: number;
  /** Reopen the working directory's most recent conversation (`--continue`). */
  resume?: boolean;
};

export const DEFAULT_COMMAND_BIN = "freebuff";

/**
 * Pane geometry. The pane is never displayed, so it is made tall: the bridge
 * captures the visible screen only, and rows that scroll out of it between two
 * polls are lost, so a tall viewport buys the transcript room to grow. Short
 * bursts (a few dozen lines) then never scroll past the capture.
 */
export const DEFAULT_PANE_COLS = 220;
export const DEFAULT_PANE_ROWS = 200;

/** Quotes one word for the shell command tmux runs. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A tmux session target that matches the name and nothing else.
 *
 * Without the `=` prefix tmux resolves `-t` as a session id, an exact name, or
 * failing both, a prefix and then a pattern. Session names here come from the
 * host's session id, so a bare name could reach a different session whose name
 * starts the same way once ours is gone.
 */
export function exactTarget(session: string): string {
  return `=${session}`;
}

/**
 * The default pane command: launch the Freebuff TUI in the session cwd, or with
 * `--continue` to reopen the most recent conversation of that directory.
 */
export function freebuffCommand(
  cwd: string,
  bin: string = DEFAULT_COMMAND_BIN,
  options: { resume?: boolean } = {},
): string {
  const resume = options.resume === true ? "--continue " : "";
  return `${bin} ${resume}--cwd ${shellQuote(cwd)}`;
}

/**
 * Wraps the pane command so the pane reaps itself when its owner disappears.
 *
 * The host stops a worker with an uncatchable signal, so no signal handler of
 * ours runs and the tmux session of the hosted TUI would outlive the adapter,
 * holding a Freebuff process and its terminal. The watcher runs beside the TUI
 * (never touching the pty, which the TUI needs as its controlling terminal)
 * and kills the session once `parentPid` is gone.
 */
export function watchdogCommand(
  inner: string,
  options: { session: string; parentPid: number; tmuxBin?: string },
): string {
  const tmux = shellQuote(options.tmuxBin ?? "tmux");
  const watch = `while kill -0 ${options.parentPid} 2>/dev/null; do sleep 2; done; ${tmux} kill-session -t ${shellQuote(exactTarget(options.session))} 2>/dev/null`;
  // tmux runs its command through `default-shell`, which is not necessarily
  // POSIX (fish and nushell are common), so tmux must only see plain quoted
  // words: the job control goes to `sh -c` along with the command itself. And
  // through `sh -c` rather than straight after `exec` because a configured
  // command may carry an assignment prefix (`MODE=dev freebuff ...`), which
  // `exec` would read as the name of the program instead of its environment.
  return `exec sh -c ${shellQuote(`{ ${watch}; } & exec ${inner}`)}`;
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
    const inner =
      this.options.command ?? freebuffCommand(cwd ?? process.cwd(), DEFAULT_COMMAND_BIN, { resume: this.options.resume });
    const parentPid = this.options.watchParentPid ?? process.pid;
    const command =
      parentPid === 0
        ? inner
        : watchdogCommand(inner, { session, parentPid, tmuxBin: this.tmuxBin });
    const args = ["new-session", "-d", "-s", session];
    if (cwd !== undefined) {
      args.push("-c", cwd);
    }
    args.push(
      "-x",
      String(this.options.cols ?? DEFAULT_PANE_COLS),
      "-y",
      String(this.options.rows ?? DEFAULT_PANE_ROWS),
      command,
    );
    // A resumed session reuses the ACP session id as its tmux name, so a pane
    // left behind by a killed predecessor has to go before the new one starts.
    if (this.options.resume === true) {
      try {
        await this.exec(["kill-session", "-t", exactTarget(session)]);
      } catch {
        // Nothing to reclaim.
      }
    }
    await this.exec(args);
    trackPane(session, this.tmuxBin);
  }

  async capture(): Promise<string> {
    // `-e` keeps escape sequences so the caller sees exactly what a terminal
    // would; `stripAnsi` runs on the diffing side.
    return await this.exec(["capture-pane", "-p", "-e", "-t", exactTarget(this.options.session)]);
  }

  async send(keys: string, options?: SendOptions): Promise<void> {
    const args = ["send-keys", "-t", exactTarget(this.options.session)];
    if (options?.literal) {
      args.push("-l");
    }
    args.push("--", keys);
    await this.exec(args);
  }

  async stop(): Promise<void> {
    untrackPane(this.options.session);
    try {
      await this.exec(["kill-session", "-t", exactTarget(this.options.session)]);
    } catch {
      // Already gone: stopping twice is not an error.
    }
  }
}

/** True when the tmux session behind `session` still exists. */
export async function tmuxSessionExists(session: string, tmuxBin = "tmux"): Promise<boolean> {
  try {
    await defaultExec(tmuxBin)(["has-session", "-t", exactTarget(session)]);
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
      resume: request.resume,
    });
    await pane.start();
    return pane;
  };
}

// Session name -> the tmux binary that owns it, so teardown uses the same tmux
// the pane was started with (FREEBUFF_ACP_TMUX is not necessarily `tmux`).
const liveSessions = new Map<string, string>();

/** Registers a session so `stopAllPanes` can tear it down on process exit. */
export function trackPane(session: string, tmuxBin = "tmux"): void {
  liveSessions.set(session, tmuxBin);
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
  for (const [session, tmuxBin] of liveSessions) {
    try {
      if (sync) {
        execFileSync(tmuxBin, ["kill-session", "-t", exactTarget(session)], { stdio: "ignore" });
      } else {
        void execFileAsync(tmuxBin, ["kill-session", "-t", exactTarget(session)]).catch(() => {});
      }
    } catch {
      // Session already gone or tmux unavailable: nothing to clean up.
    }
    liveSessions.delete(session);
  }
}
