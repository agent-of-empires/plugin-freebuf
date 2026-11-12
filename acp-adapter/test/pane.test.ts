// Pane command construction: the tmux invocation the real `TmuxPaneSource`
// makes, and the watchdog that lets a pane reap itself when its owner is killed
// with a signal no handler can catch.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freebuffCommand, TmuxPaneSource, watchdogCommand, shellQuote } from "../src/pane.ts";

type Call = string[];

function fakeTmux(): { exec: (args: string[]) => Promise<string>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: async (args: string[]) => {
      calls.push(args);
      return "";
    },
  };
}

describe("freebuffCommand", () => {
  it("runs the TUI in the session cwd", () => {
    assert.equal(freebuffCommand("/tmp/project"), "freebuff --cwd '/tmp/project'");
  });

  it("quotes a cwd containing a quote", () => {
    assert.equal(freebuffCommand("/tmp/it's here"), `freebuff --cwd '/tmp/it'\\''s here'`);
  });

  it("continues the directory's most recent chat when resuming", () => {
    assert.equal(freebuffCommand("/tmp/project", "freebuff", { resume: true }), "freebuff --continue --cwd '/tmp/project'");
  });
});

describe("watchdogCommand", () => {
  it("kills the session once the owner pid is gone, then execs the TUI", () => {
    const inner = "freebuff --cwd '/tmp/x'";
    const command = watchdogCommand(inner, {
      session: "freebuff-acp-1-abc",
      parentPid: 4242,
    });
    // `=` makes tmux match the name exactly instead of accepting a prefix.
    assert.match(unwrap(command), /while kill -0 4242 2>\/dev\/null; do sleep 2; done; 'tmux' kill-session -t '=freebuff-acp-1-abc'/);
    // Through a shell: a configured command may start with an assignment prefix.
    assert.ok(unwrap(command).endsWith(`exec ${inner}`));
    // The TUI must stay in the foreground: it needs the pty as its terminal.
    assert.ok(!command.includes(`${inner} &`));
  });

  it("hands tmux one quoted word, whatever the user's login shell is", () => {
    // tmux parses a shell-command with `default-shell`, which can be fish or
    // nushell: `{ ...; } &`, `while ...; do` and quotes would be rejected there,
    // so the job control has to be inside the `sh -c` argument.
    const command = watchdogCommand("freebuff", { session: "s", parentPid: 4242 });
    assert.match(command, /^exec sh -c '.*'$/);
    assert.ok(!/^[{[]/.test(command));
  });

  it("runs an env-prefixed command through a shell so the assignment applies", () => {
    const inner = "MODE=dev freebuff --cwd '/tmp/x'";
    const command = watchdogCommand(inner, { session: "s", parentPid: 1 });
    // `exec MODE=dev freebuff ...` is not a command: the prefix needs a shell.
    assert.ok(unwrap(command).endsWith(`exec ${inner}`));
    assert.ok(!unwrap(command).includes(`exec ${shellQuote(inner)}`));
  });

  it("uses the configured tmux binary", () => {
    const command = watchdogCommand("freebuff", {
      session: "s",
      parentPid: 1,
      tmuxBin: "/opt/homebrew/bin/tmux",
    });
    assert.ok(unwrap(command).includes(`'${"/opt/homebrew/bin/tmux"}' kill-session -t '=s'`));
  });
});

/** The script tmux is handed: the single argument of `exec sh -c <quoted>`. */
function unwrap(command: string): string {
  const prefix = "exec sh -c ";
  assert.ok(command.startsWith(prefix), `not a quoted sh -c: ${command}`);
  const quoted = command.slice(prefix.length);
  assert.equal(quoted[0], "'");
  assert.equal(quoted[quoted.length - 1], "'");
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

describe("TmuxPaneSource.start", () => {
  it("creates a tall detached session and wraps the command in the watchdog", async () => {
    const { exec, calls } = fakeTmux();
    const pane = new TmuxPaneSource({
      session: "freebuff-acp-1-abc",
      cwd: "/tmp/x",
      exec,
      watchParentPid: 4242,
    });
    await pane.start();
    const args = calls[0];
    assert.deepEqual(args.slice(0, 4), ["new-session", "-d", "-s", "freebuff-acp-1-abc"]);
    assert.equal(args[args.indexOf("-x") + 1], "220");
    assert.equal(args[args.indexOf("-y") + 1], "200");
    assert.ok(args[args.length - 1].includes("kill -0 4242"));
  });

  it("leaves the command alone when watching is disabled", async () => {
    const { exec, calls } = fakeTmux();
    const pane = new TmuxPaneSource({
      session: "s",
      cwd: "/tmp/x",
      exec,
      watchParentPid: 0,
    });
    await pane.start();
    assert.equal(calls[0][calls[0].length - 1], `freebuff --cwd ${shellQuote("/tmp/x")}`);
  });

  it("reclaims a leftover session of the same name when resuming", async () => {
    // A resumed session reuses its ACP id as the tmux name, so the pane of a
    // predecessor that was killed has to go before the new one is created.
    const { exec, calls } = fakeTmux();
    const pane = new TmuxPaneSource({
      session: "freebuff-acp-1-abc",
      cwd: "/tmp/x",
      exec,
      watchParentPid: 0,
      resume: true,
    });
    await pane.start();
    assert.deepEqual(calls[0], ["kill-session", "-t", "=freebuff-acp-1-abc"]);
    assert.equal(calls[1][0], "new-session");
    assert.ok(calls[1][calls[1].length - 1].includes("--continue"));
  });

  it("leaves a fresh session alone", async () => {
    const { exec, calls } = fakeTmux();
    const pane = new TmuxPaneSource({ session: "s", cwd: "/tmp/x", exec, watchParentPid: 0 });
    await pane.start();
    assert.equal(calls.length, 1, "a non-resume pane must not kill anything");
  });

  it("keeps the escape sequences when capturing", async () => {
    const { exec, calls } = fakeTmux();
    const pane = new TmuxPaneSource({ session: "s", exec });
    await pane.capture();
    assert.deepEqual(calls[0], ["capture-pane", "-p", "-e", "-t", "=s"]);
  });
});
