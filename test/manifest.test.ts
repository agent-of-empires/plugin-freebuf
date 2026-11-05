import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Minimal, dependency-free TOML reader covering exactly the constructs the
 * shipped manifest uses: comments, bare keys, basic strings, integers,
 * booleans, inline arrays, `[table]` headers, and `[[array.of.tables]]`
 * headers. Root package.json has no TOML dependency, and none is added.
 */
type Value = string | number | boolean | Value[];
type Table = Record<string, Value>;

interface Manifest {
  root: Table;
  /** Sections in file order: `[name]` and `[[name]]` both append one table. */
  sections: Record<string, Table[]>;
}

const MANIFEST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "aoe-plugin.toml");

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

function parseString(text: string, line: number): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) {
    throw new Error(`line ${line}: expected a basic string, got: ${text}`);
  }
  return text.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    switch (escaped[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "u":
        return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
      default:
        return escaped;
    }
  });
}

/** Split on top-level commas, ignoring commas inside quotes or nested brackets. */
function splitArray(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.filter((part) => part.trim() !== "");
}

function parseValue(raw: string, line: number): Value {
  const text = raw.trim();
  if (text.startsWith('"')) return parseString(text, line);
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error(`line ${line}: unterminated array: ${text}`);
    return splitArray(text.slice(1, -1)).map((part) => parseValue(part, line));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  throw new Error(`line ${line}: unsupported value: ${text}`);
}

function parseToml(source: string): Manifest {
  const manifest: Manifest = { root: {}, sections: {} };
  let current: Table = manifest.root;

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim();
    if (line === "") return;

    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      const table: Table = {};
      (manifest.sections[header[1].trim()] ??= []).push(table);
      current = table;
      return;
    }

    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!pair) throw new Error(`line ${index + 1}: cannot parse: ${rawLine}`);
    current[pair[1]] = parseValue(pair[2], index + 1);
  });

  return manifest;
}

describe("aoe-plugin.toml", () => {
  const manifest = parseToml(readFileSync(MANIFEST_PATH, "utf8"));

  it("declares the api_version that carries the agent-integration contract", () => {
    // 19 adds [[agent_integrations]] and the session.integration capability.
    // The host parses this strictly, so a host below aoe_version rejects the
    // manifest rather than silently ignoring the block.
    expect(manifest.root.api_version).toBe(19);
  });

  it("declares the freebuff integration the worker publishes status for", () => {
    const integrations = manifest.sections.agent_integrations ?? [];
    expect(integrations).toHaveLength(1);
    expect(integrations[0].tool).toBe("freebuff");
    expect(integrations[0].command).toBe("freebuff");
    expect(integrations[0].provider_versions).toEqual([">=0.2.36, <1.0.0"]);
    // Status only: claiming replies would need an in-process prompt hook.
    expect(integrations[0].replies).toBeUndefined();
  });

  it("pins the host line that parses this schema", () => {
    expect(manifest.root.aoe_version).toBe(">=1.21.0, <2.0.0");
  });

  it("declares the capabilities its worker uses and nothing else", () => {
    // session.read lists sessions; process.spawn captures each pane;
    // fs.read reads Freebuff's own state; fs.write raises the attention flag;
    // session.integration publishes that classification as the row's status.
    expect(manifest.root.capabilities).toEqual([
      "runtime.worker",
      "session.read",
      "fs.read",
      "fs.write",
      "process.spawn",
      "session.integration",
    ]);
  });

  it("asks for no row-column, since attention is carried by the host's flag", () => {
    const slots = (manifest.sections.ui ?? []).map((entry) => entry.slot);
    expect(slots).not.toContain("row-column");
    expect(slots).toContain("pane");
  });

  it("stays in a namespace a community install may claim", () => {
    // aoe.* and agent-of-empires.* are reserved for bundled/featured plugins.
    expect(manifest.root.id).toBe("dev.example.aoe-freebuf");
  });
});
