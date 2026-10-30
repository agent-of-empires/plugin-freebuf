import { describe, expect, it } from "vitest";
import { handle, processLine } from "../src/index";

describe("worker", () => {
  it("answers a .status method with ok", () => {
    const response = processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aoe-freebuf.status", params: {} }));
    expect(response?.result).toMatchObject({ ok: true, runtime: "node" });
  });

  it("returns -32601 for an unknown method", () => {
    const response = processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "aoe-freebuf.nope" }));
    expect(response?.error?.code).toBe(-32601);
  });

  it("does not respond to a notification", () => {
    const response = processLine(JSON.stringify({ jsonrpc: "2.0", method: "aoe-freebuf.status" }));
    expect(response).toBeNull();
  });

  it("handle throws on an unknown command", () => {
    expect(() => handle("a.nope", {})).toThrow();
  });
});
