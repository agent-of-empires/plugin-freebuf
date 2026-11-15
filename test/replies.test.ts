import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneDialog } from "../src/dialog";
import { buildSnapshot, type AgentIntegrationSnapshot } from "../src/integration";
import {
  REPLY_FILENAME,
  consumeReply,
  deliverySteps,
  readReply,
  replyPath,
  type Reply,
} from "../src/replies";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

const PROMPT_ID = "freebuff-dialog-0123456789abcdef";
const QUESTION_ID = `${PROMPT_ID}-q1`;
const RESPONSE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function dialog(overrides: Partial<PaneDialog> = {}): PaneDialog {
  return {
    question: "How far should the row shrink?",
    options: [
      { label: "Icon only, drop sort/filter", marker: "○" },
      { label: "Keep the label", marker: "○" },
    ],
    custom: true,
    multi: false,
    isLast: true,
    id: PROMPT_ID,
    ...overrides,
  };
}

function snapshot(
  overrides: { revision?: number; prompt?: boolean; multi?: boolean; layout?: PaneDialog } = {},
): AgentIntegrationSnapshot {
  const layout = overrides.layout ?? dialog({ multi: overrides.multi ?? false });
  return buildSnapshot({
    instanceId: "sess-1",
    providerVersion: "0.2.36",
    providerSessionId: "chat-1",
    status: "waiting",
    writerPid: 4242,
    revision: overrides.revision ?? 0,
    prompt:
      overrides.prompt === false
        ? null
        : {
            kind: "question",
            id: layout.id,
            title: layout.question,
            questions: [
              {
                id: QUESTION_ID,
                question: layout.question,
                options: layout.options.map((option) => ({ label: option.label })),
                ...(layout.multi ? { multi: true } : {}),
              },
            ],
          },
  });
}

function reply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    instance_id: "sess-1",
    provider_session_id: "chat-1",
    writer_pid: 4242,
    revision: 0,
    prompt_id: PROMPT_ID,
    response_id: RESPONSE_ID,
    response: {
      kind: "question",
      answers: [{ id: QUESTION_ID, selected_options: ["Keep the label"] }],
    },
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown>): Record<string, unknown> {
  return reply({ response: { kind: "question", answers: [{ id: QUESTION_ID, ...overrides }] } });
}

function writeReplyFile(dir: string, body: unknown, mode = 0o600): string {
  const file = replyPath(dir);
  writeFileSync(file, JSON.stringify(body), { mode });
  chmodSync(file, mode); // defeat a permissive umask
  return file;
}

describe("reply sidecar", () => {
  it("is named after the plugin id, beside the report", () => {
    expect(REPLY_FILENAME).toBe("integration-agent-of-empires.aoe-freebuf.reply.json");
    expect(replyPath("/tmp/aoe-hooks-501/sess-1")).toBe(`/tmp/aoe-hooks-501/sess-1/${REPLY_FILENAME}`);
  });

  it("accepts the host's answer to the current prompt", () => {
    const dir = tempDir("aoe-hooks-");
    writeReplyFile(dir, reply());
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toMatchObject({
      prompt_id: PROMPT_ID,
      response: { answers: [{ selected_options: ["Keep the label"] }] },
    });
  });

  it("accepts every question shape the dialog can pose", () => {
    const dir = tempDir("aoe-hooks-");
    const current = snapshot({ multi: true });
    writeReplyFile(dir, answer({ selected_options: ["Keep the label", "Icon only, drop sort/filter"] }));
    expect(readReply(dir, current, os.userInfo().uid)).not.toBeNull();

    writeReplyFile(dir, answer({ selected_options: [], custom_input: "Shrink it to a dot" }));
    expect(readReply(dir, current, os.userInfo().uid)).not.toBeNull();

    // A single choice takes one option, or typed text, never both.
    const single = snapshot();
    writeReplyFile(dir, answer({ selected_options: ["Keep the label"], custom_input: "dot" }));
    expect(readReply(dir, single, os.userInfo().uid)).toBeNull();
    // Nor two options and typed text: delivery can only take one of the two, so
    // the other would be dropped without a word.
    writeReplyFile(
      dir,
      answer({ selected_options: ["Keep the label", "Icon only, drop sort/filter"], custom_input: "dot" }),
    );
    expect(readReply(dir, single, os.userInfo().uid)).toBeNull();
    writeReplyFile(dir, answer({ selected_options: [], custom_input: " dot " }));
    expect(readReply(dir, single, os.userInfo().uid)).not.toBeNull();
  });

  it("rejects an answer to a prompt that has since changed", () => {
    const dir = tempDir("aoe-hooks-");
    writeReplyFile(dir, reply());
    expect(readReply(dir, snapshot({ revision: 7 }), os.userInfo().uid)).toBeNull();
    unlinkSync(replyPath(dir));
    writeReplyFile(dir, reply({ prompt_id: "freebuff-dialog-ffffffffffffffff" }));
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
  });

  it("rejects a reply for another instance, session or writer", () => {
    const dir = tempDir("aoe-hooks-");
    for (const override of [
      { instance_id: "sess-2" },
      { provider_session_id: "chat-2" },
      { writer_pid: 1 },
      { schema_version: 2 },
      { response_id: "not-a-uuid" },
    ]) {
      writeReplyFile(dir, reply(override));
      expect(readReply(dir, snapshot(), os.userInfo().uid), JSON.stringify(override)).toBeNull();
    }
  });

  it("rejects an option the prompt never offered and a malformed selection", () => {
    const dir = tempDir("aoe-hooks-");
    const answers = [
      { selected_options: ["Delete the row"] },
      { selected_options: ["Keep the label", "Keep the label"] },
      { selected_options: [] },
      { selected_options: [], custom_input: "   " },
      { selected_options: [], custom_input: "two\nlines" },
    ];
    for (const entry of answers) {
      writeReplyFile(dir, answer(entry));
      expect(readReply(dir, snapshot(), os.userInfo().uid), JSON.stringify(entry)).toBeNull();
    }
    writeReplyFile(dir, answer({ selected_options: ["Keep the label"], id: `${PROMPT_ID}-q9` }));
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
  });

  it("rejects a file the host would not have written: wrong owner, wrong mode, or too large", () => {
    const dir = tempDir("aoe-hooks-");
    writeReplyFile(dir, reply());
    expect(readReply(dir, snapshot(), os.userInfo().uid + 1)).toBeNull();

    writeReplyFile(dir, reply(), 0o644);
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();

    writeFileSync(replyPath(dir), "x".repeat(70 * 1024), { mode: 0o600 });
    chmodSync(replyPath(dir), 0o600);
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
  });

  it("reads no reply when the file is absent, not JSON, or the report has no prompt", () => {
    const dir = tempDir("aoe-hooks-");
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
    writeFileSync(replyPath(dir), "{not json", { mode: 0o600 });
    chmodSync(replyPath(dir), 0o600);
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
    writeReplyFile(dir, reply());
    expect(readReply(dir, snapshot({ prompt: false }), os.userInfo().uid)).toBeNull();
  });

  it("removes the reply once delivered, and removing an absent one is not an error", () => {
    const dir = tempDir("aoe-hooks-");
    writeReplyFile(dir, reply());
    consumeReply(dir);
    expect(readReply(dir, snapshot(), os.userInfo().uid)).toBeNull();
    consumeReply(dir);
  });
});

describe("delivery steps", () => {
  function steps(body: Record<string, unknown>, layout: PaneDialog = dialog()): unknown {
    const current = snapshot({ layout });
    return deliverySteps(body as unknown as Reply, current, layout);
  }
  const keys = (...names: string[]): { keys: string[] } => ({ keys: names });

  it("settles the focus on the first option before counting presses", () => {
    // Up leaves Submit if it had the focus, Down undoes a step back to the
    // previous question, and Left/Down collapse and re-expand this question:
    // that is what makes "option N is N presses of Down" true wherever the
    // focus was.
    expect(steps(answer({ selected_options: ["Icon only, drop sort/filter"] }))).toEqual([
      keys("Up", "Down", "Left", "Down", "Enter", "Enter"),
    ]);
  });

  it("walks to a single choice and submits the form behind it", () => {
    // On the last question the selection leaves Submit focused, so the second
    // Enter is what submits the form.
    expect(steps(answer({ selected_options: ["Keep the label"] }))).toEqual([
      keys("Up", "Down", "Left", "Down", "Down", "Enter", "Enter"),
    ]);
  });

  it("stops after selecting when the form has more questions", () => {
    expect(steps(answer({ selected_options: ["Keep the label"] }), dialog({ isLast: false }))).toEqual([
      keys("Up", "Down", "Left", "Down", "Down", "Enter"),
    ]);
  });

  it("toggles every chosen option on a multi-select question, then tabs to Submit", () => {
    const layout = dialog({ multi: true });
    expect(
      steps(answer({ selected_options: ["Icon only, drop sort/filter", "Keep the label"] }), layout),
    ).toEqual([keys("Up", "Down", "Left", "Down", "Enter", "Down", "Enter", "Tab", "Enter")]);
  });

  it("turns off a checked multi-select option the answer does not include", () => {
    const layout = dialog({
      multi: true,
      options: [
        { label: "Icon only, drop sort/filter", marker: "☑" },
        { label: "Keep the label", marker: "☐" },
      ],
    });
    // Only the second option is answered, so the checked first one has to be
    // toggled off or the form would submit it as well.
    expect(steps(answer({ selected_options: ["Keep the label"] }), layout)).toEqual([
      keys("Up", "Down", "Left", "Down", "Enter", "Down", "Enter", "Tab", "Enter"),
    ]);
  });

  it("leaves an already-checked multi-select option alone instead of toggling it off", () => {
    const layout = dialog({
      multi: true,
      options: [
        { label: "Icon only, drop sort/filter", marker: "☑" },
        { label: "Keep the label", marker: "☐" },
      ],
    });
    // Both are wanted, but Enter toggles: the checked one only needs the focus
    // to pass over it, so the press is skipped and it stays on.
    expect(
      steps(answer({ selected_options: ["Icon only, drop sort/filter", "Keep the label"] }), layout),
    ).toEqual([keys("Up", "Down", "Left", "Down", "Down", "Enter", "Tab", "Enter")]);
  });

  it("steps past the Custom row to reach the next question on a multi-select form", () => {
    const layout = dialog({ multi: true, isLast: false });
    // From option 1: one Down to the Custom row, one more to the next question.
    expect(steps(answer({ selected_options: ["Keep the label"] }), layout)).toEqual([
      keys("Up", "Down", "Left", "Down", "Down", "Enter", "Down", "Down"),
    ]);
  });

  it("steps straight to the next question when a multi-select question has no Custom row", () => {
    const layout = dialog({ multi: true, isLast: false, custom: false });
    // The row after the last option is the next question itself, so one Down
    // from there moves on: pressing one more would walk into its first option.
    expect(steps(answer({ selected_options: ["Keep the label"] }), layout)).toEqual([
      keys("Up", "Down", "Left", "Down", "Down", "Enter", "Down"),
    ]);
  });

  it("types a custom answer into the dialog's text field", () => {
    expect(steps(answer({ selected_options: [], custom_input: "  Shrink it to a dot  " }))).toEqual([
      keys("Up", "Down", "Left", "Down", "Down", "Down", "Enter"), // reset, then option 0 → 1 → Custom
      { text: "Shrink it to a dot" },
      keys("Enter", "Enter"), // ends the typed answer, then submits the form
    ]);
  });

  it("refuses a custom answer when the dialog offers no text field", () => {
    expect(steps(answer({ selected_options: [], custom_input: "dot" }), dialog({ custom: false }))).toBeNull();
  });

  it("refuses an answer for a dialog other than the one published", () => {
    const other = dialog({ id: "freebuff-dialog-ffffffffffffffff" });
    expect(deliverySteps(reply() as unknown as Reply, snapshot(), other)).toBeNull();
  });
});
