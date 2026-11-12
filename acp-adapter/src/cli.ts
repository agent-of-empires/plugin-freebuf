#!/usr/bin/env node
// ACP-over-stdio entry point: the host (aoe, Zed, ...) spawns this process,
// writes newline-delimited JSON-RPC to stdin and reads it back on stdout.
// Nothing else may be written to stdout: the tmux/freebuff child processes
// keep their own stdio.

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAdapter } from "./adapter.ts";
import { createTmuxPaneFactory, stopAllPanes } from "./pane.ts";

export function main(): void {
  const createPane = createTmuxPaneFactory({
    tmuxBin: process.env.FREEBUFF_ACP_TMUX ?? "tmux",
    command: process.env.FREEBUFF_ACP_COMMAND,
  });
  const app = createAdapter({ createPane });

  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  app.connect(ndJsonStream(output, input));

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      // Synchronously: `process.exit` immediately after an async kill would
      // win the race and leave the tmux pane behind.
      stopAllPanes(true);
      process.exit(130);
    });
  }
  process.on("exit", () => {
    // Last resort: synchronous tmux kill, since async work cannot run here.
    stopAllPanes(true);
  });
}

main();
