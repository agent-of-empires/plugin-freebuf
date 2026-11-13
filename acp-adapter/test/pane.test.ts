import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TmuxPaneSource } from "../src/pane.ts";

function recordingPane() {
  const calls: string[][] = [];
  const pane = new TmuxPaneSource({
    session: "s1",
    exec: async (args) => {
      calls.push(args);
      return "";
    },
  });
  return { pane, calls };
}

describe("TmuxPaneSource.send", () => {
  it("sends a repeated key as separate keys in one call", async () => {
    const { pane, calls } = recordingPane();

    await pane.send("BSpace", { repeat: 3 });

    // One subprocess for the whole draft: clearing it key by key would spawn one
    // per character and hold the error path up for seconds.
    assert.deepEqual(calls, [["send-keys", "-t", "s1", "--", "BSpace", "BSpace", "BSpace"]]);
  });

  it("sends literal text without repeating it", async () => {
    const { pane, calls } = recordingPane();

    await pane.send("hi there", { literal: true });

    assert.deepEqual(calls, [["send-keys", "-t", "s1", "-l", "--", "hi there"]]);
  });
});
