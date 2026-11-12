import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileSessionStore } from "../src/store.ts";

// The on-disk store is what a restarted adapter reads back, and every adapter
// test injects `memorySessionStore()`, so these are the only tests of it.
describe("fileSessionStore", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "freebuff-acp-store-"));
    dir = join(root, "sessions");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips a record through the file system", () => {
    const store = fileSessionStore(dir);
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: "Fix the tests" });
    assert.deepEqual(store.get("freebuff-acp-1-abc"), { cwd: "/tmp/project", title: "Fix the tests" });
    // A new instance, as a restarted adapter would build.
    assert.deepEqual(fileSessionStore(dir).get("freebuff-acp-1-abc"), { cwd: "/tmp/project", title: "Fix the tests" });
  });

  it("keeps a session with no chat title yet", () => {
    // Killed before its first turn: the directory is known, the title is not.
    const store = fileSessionStore(dir);
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: null });
    assert.deepEqual(store.get("freebuff-acp-1-abc"), { cwd: "/tmp/project", title: null });
  });

  it("sanitises a session id into a single file name", () => {
    const store = fileSessionStore(dir);
    store.set("../../etc/passwd", { cwd: "/tmp/project", title: "t" });
    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    assert.equal(names[0], ".._.._etc_passwd.json");
    assert.deepEqual(store.get("../../etc/passwd"), { cwd: "/tmp/project", title: "t" });
    // Nothing was written outside the store directory.
    assert.deepEqual(readdirSync(root), ["sessions"]);
  });

  it("reports no record for a session it never wrote", () => {
    assert.equal(fileSessionStore(dir).get("freebuff-acp-missing"), undefined);
  });

  it("ignores a record that is not valid JSON", () => {
    // A crash mid-write or a hand-edited file must not throw on read.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "freebuff-acp-1-bad.json"), "{\"cwd\": \"/tmp/pro");
    assert.equal(fileSessionStore(dir).get("freebuff-acp-1-bad"), undefined);
  });

  it("ignores a record without a directory", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "freebuff-acp-1-nocwd.json"), JSON.stringify({ title: "x" }));
    writeFileSync(join(dir, "freebuff-acp-1-list.json"), JSON.stringify(["title"]));
    assert.equal(fileSessionStore(dir).get("freebuff-acp-1-nocwd"), undefined);
    assert.equal(fileSessionStore(dir).get("freebuff-acp-1-list"), undefined);
  });

  it("coerces a title that is not a string to null", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "freebuff-acp-1-title.json"), JSON.stringify({ cwd: "/tmp/project", title: 42 }));
    assert.deepEqual(fileSessionStore(dir).get("freebuff-acp-1-title"), { cwd: "/tmp/project", title: null });
  });

  it("keeps the store directory and the records private", () => {
    const store = fileSessionStore(dir);
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: "Fix the tests" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "freebuff-acp-1-abc.json")).mode & 0o777, 0o600);
  });

  it("tightens a store directory that was created wider", () => {
    // `mode` only applies to a directory this call creates, so an older store
    // left at 0755 has to be closed on the next write.
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const store = fileSessionStore(dir);
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: "t" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("leaves no staging file behind", () => {
    const store = fileSessionStore(dir);
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: "t" });
    store.set("freebuff-acp-1-abc", { cwd: "/tmp/project", title: "u" });
    assert.deepEqual(readdirSync(dir), ["freebuff-acp-1-abc.json"]);
    assert.equal(readFileSync(join(dir, "freebuff-acp-1-abc.json"), "utf8"), JSON.stringify({ cwd: "/tmp/project", title: "u" }));
  });
});
