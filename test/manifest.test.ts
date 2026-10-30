import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_ID } from "../src/integration";

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

const ALLOWED_INTEGRATION_KEYS = new Set(["tool", "provider_versions", "command", "replies"]);

describe("aoe-plugin.toml", () => {
  const manifest = parseToml(readFileSync(MANIFEST_PATH, "utf8"));

  it("declares api_version 19", () => {
    expect(manifest.root.api_version).toBe(19);
  });

  it("declares exactly one agent integration for freebuff", () => {
    const integrations = manifest.sections.agent_integrations ?? [];
    expect(integrations).toHaveLength(1);
    expect(integrations[0].tool).toBe("freebuff");
    expect(integrations[0].command).toBe("freebuff");
  });

  it("uses only schema keys on each agent integration", () => {
    for (const integration of manifest.sections.agent_integrations ?? []) {
      const unsupported = Object.keys(integration).filter((key) => !ALLOWED_INTEGRATION_KEYS.has(key));
      expect(unsupported).toEqual([]);
    }
  });

  it("declares session.integration with the provider_versions that requires", () => {
    const capabilities = manifest.root.capabilities;
    expect(capabilities).toEqual(expect.arrayContaining(["runtime.worker", "session.integration"]));
    // The host rejects a manifest that declares session.integration without
    // nonempty provider_versions on every agent integration entry.
    for (const integration of manifest.sections.agent_integrations ?? []) {
      expect(Array.isArray(integration.provider_versions)).toBe(true);
      expect(integration.provider_versions).not.toEqual([]);
    }
  });

  it("matches the plugin id the report file is named after", () => {
    expect(manifest.root.id).toBe(PLUGIN_ID);
  });
});
