import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScreenTracker, diffScreens, normalizeScreen } from "../src/screen.ts";

describe("normalizeScreen", () => {
  it("strips ANSI escapes from the capture", () => {
    assert.deepEqual(normalizeScreen("\u001b[32mgreen\u001b[0m"), ["green"]);
  });

  it("trims trailing whitespace and carriage returns", () => {
    assert.deepEqual(normalizeScreen("padded   \r\nnext\t\n"), ["padded", "next"]);
  });

  it("drops the trailing blank rows tmux pads the pane with", () => {
    assert.deepEqual(normalizeScreen("line\n\n\n"), ["line"]);
    assert.deepEqual(normalizeScreen(""), []);
  });

  it("keeps interior blank lines", () => {
    assert.deepEqual(normalizeScreen("a\n\nb\n"), ["a", "", "b"]);
  });
});

describe("diffScreens", () => {
  it("returns nothing when the screen did not change", () => {
    const screen = ["ready", "prompt>"];
    assert.equal(diffScreens(screen, screen), "");
  });

  it("returns only lines appended since the previous capture", () => {
    assert.equal(diffScreens(["a", "b"], ["a", "b", "c", "d"]), "\nc\nd");
  });

  it("handles scrollback: the previous tail lines up with the new head", () => {
    assert.equal(diffScreens(["a", "b", "c"], ["b", "c", "d"]), "\nd");
  });

  it("emits only the suffix when a trailing line grows in place", () => {
    assert.equal(diffScreens(["a", "hel"], ["a", "hello"]), "lo");
    assert.equal(diffScreens(["a", "hello wor"], ["a", "hello world", "next"]), "ld\nnext");
  });

  it("emits the whole next screen when there is no overlap", () => {
    assert.equal(diffScreens([], ["fresh", "screen"]), "fresh\nscreen");
    assert.equal(diffScreens(["one"], ["totally", "different"]), "\ntotally\ndifferent");
  });

  it("emits only the changed line when a line is rewritten in place", () => {
    const prev = ["header", "step 3/5", "footer"];
    const next = ["header", "step 4/5", "footer"];
    assert.equal(diffScreens(prev, next), "\nstep 4/5");
  });

  it("does not re-emit the screen when a middle line changes among many", () => {
    const prev = ["a", "b", "c", "d", "e", "f"];
    const next = ["a", "b", "c", "CHANGED", "e", "f"];
    assert.equal(diffScreens(prev, next), "\nCHANGED");
  });

  it("emits nothing when rows disappear without new output", () => {
    assert.equal(diffScreens(["a", "modal", "b"], ["a", "b"]), "");
    assert.equal(diffScreens(["a", "b", "c"], ["a", "b"]), "");
  });

  it("emits an appended line after an in-place rewrite as one block", () => {
    const prev = ["a", "b"];
    const next = ["a", "b2", "c"];
    // "b" -> "b2" grows in place (suffix), then "c" is a new line.
    assert.equal(diffScreens(prev, next), "2\nc");
  });

  it("ignores recoloring: same text, different escapes", () => {
    const prev = normalizeScreen("\u001b[32mok\u001b[0m  \nnext");
    const next = normalizeScreen("\u001b[1;32mok\u001b[0m  \nnext");
    assert.equal(diffScreens(prev, next), "");
  });

  it("does not re-emit unchanged leading lines after a scroll", () => {
    const prev = normalizeScreen("row1\nrow2\nrow3\nrow4\n");
    const next = normalizeScreen("row2\nrow3\nrow4\nrow5\n");
    assert.equal(diffScreens(prev, next), "\nrow5");
  });
});

describe("ScreenTracker", () => {
  it("emits each new bit of output exactly once across captures", () => {
    const tracker = new ScreenTracker("boot\n");
    assert.equal(tracker.update("boot\n"), "");
    assert.equal(tracker.update("boot\nthinking\n"), "\nthinking");
    assert.equal(tracker.update("boot\nthinking\ndone\n"), "\ndone");
    assert.equal(tracker.update("boot\nthinking\ndone\n"), "");
  });

  it("reset drops everything already on screen", () => {
    const tracker = new ScreenTracker("boot");
    tracker.reset("boot\n> my prompt");
    assert.equal(tracker.update("boot\n> my prompt"), "");
    assert.equal(tracker.update("boot\n> my prompt\nanswer"), "\nanswer");
  });
});
