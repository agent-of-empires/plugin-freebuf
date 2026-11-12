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
    const command = watchdogCommand("freebuff --cwd '/tmp/x'", {
      session: "freebuff-acp-1-abc",
      parentPid: 4242,
    });
    assert.match(command, /while kill -0 4242 2>\/dev\/null; do sleep 2; done; 'tmux' kill-session -t 'freebuff-acp-1-abc'/);
    assert.ok(command.endsWith("} & exec freebuff --cwd '/tmp/x'"));
    // The TUI must stay in the foreground: it needs the pty as its terminal.
    assert.ok(!command.includes("freebuff --cwd '/tmp/x' &"));
  });

  it("uses the configured tmux binary", () => {
    const command = watchdogCommand("freebuff", {
      session: "s",
      parentPid: 1,
      tmuxBin: "/opt/homebrew/bin/tmux",
    });
    assert.ok(command.includes(`'${"/opt/homebrew/bin/tmux"}' kill-session -t 's'`));
  });
});

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
    assert.deepEqual(calls[0], ["kill-session", "-t", "freebuff-acp-1-abc"]);
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
    assert.deepEqual(calls[0], ["capture-pane", "-p", "-e", "-t", "s"]);
  });
});
