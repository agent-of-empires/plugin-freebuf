import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/ansi.ts";

describe("stripAnsi", () => {
  it("removes SGR color sequences", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
    assert.equal(stripAnsi("\u001b[1;32;40mbold green\u001b[m"), "bold green");
  });

  it("removes cursor movement and screen clears", () => {
    assert.equal(stripAnsi("\u001b[2J\u001b[1;1Hhello\u001b[10;5H"), "hello");
    assert.equal(stripAnsi("\u001b[3A\u001b[1B\u001b[2C\u001b[4D"), "");
  });

  it("removes OSC window-title and hyperlink sequences", () => {
    assert.equal(stripAnsi("\u001b]0;my title\u0007body"), "body");
    assert.equal(stripAnsi("\u001b]8;;http://example.com\u001b\\link\u001b]8;;\u001b\\"), "link");
  });

  it("removes 8-bit CSI sequences", () => {
    assert.equal(stripAnsi("\u009b31mred\u009b0m"), "red");
  });

  it("removes two-byte escapes", () => {
    assert.equal(stripAnsi("\u001b(Bplain\u001b="), "plain");
  });

  it("keeps plain text, newlines and tabs untouched", () => {
    const text = "line one\nline\ttwo\n";
    assert.equal(stripAnsi(text), text);
    assert.equal(stripAnsi("no escapes here"), "no escapes here");
  });

  it("leaves adjacent colored text readable", () => {
    const input = "\u001b[33mwarn\u001b[0m: \u001b[90mdetail\u001b[0m ok";
    assert.equal(stripAnsi(input), "warn: detail ok");
  });
});
