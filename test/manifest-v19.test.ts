import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The shipped manifest and its api_version-19 variant must differ only in the
 * keys that schema adds. If they drift anywhere else, swapping the file in at
 * release would silently ship something other than the tested plugin.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Value = string | number | boolean | Value[];
type Table = Record<string, Value>;

interface Manifest {
  root: Table;
  /** Headers in file order; `[a.b]` is stored under its literal name. */
  sections: Record<string, Table[]>;
}

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

function parseValue(raw: string): Value {
  const text = raw.trim();
  if (text.startsWith('"')) return text.slice(1, -1);
  if (text.startsWith("[")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(parseValue);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === "null") throw new Error("null is not used in the manifests");
  throw new Error(`unsupported value: ${text}`);
}

function parse(source: string): Manifest {
  const manifest: Manifest = { root: {}, sections: {} };
  let current: Table = manifest.root;
  for (const raw of source.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === "") continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      const table: Table = {};
      (manifest.sections[header[1].trim()] ??= []).push(table);
      current = table;
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!pair) throw new Error(`cannot parse: ${raw}`);
    current[pair[1]] = parseValue(pair[2]);
  }
  return manifest;
}

describe("aoe-plugin.v19.toml", () => {
  const current = parse(readFileSync(path.join(root, "aoe-plugin.toml"), "utf8"));
  const forward = parse(readFileSync(path.join(root, "aoe-plugin.v19.toml"), "utf8"));

  it("raises api_version and declares the integration block", () => {
    expect(current.root.api_version).toBe(18);
    expect(forward.root.api_version).toBe(19);
    const integrations = forward.sections.agent_integrations ?? [];
    expect(integrations).toHaveLength(1);
    expect(integrations[0].tool).toBe("freebuff");
    expect(integrations[0].command).toEqual(["freebuff"]);
  });

  it("adds exactly the session.integration capability", () => {
    const before = current.root.capabilities as Value[];
    const after = forward.root.capabilities as Value[];
    expect(after).toEqual([...before, "session.integration"]);
  });

  it("keeps every other root key identical", () => {
    const { api_version: _a, capabilities: _b, ...currentRoot } = current.root;
    const { api_version: _c, capabilities: _d, ...forwardRoot } = forward.root;
    expect(forwardRoot).toEqual(currentRoot);
  });

  it("adds only the integration sections on top of the same manifest", () => {
    const { "agent_integrations": integration, "agent_integrations.provider_versions": versions, ...rest } =
      forward.sections;
    expect(rest).toEqual(current.sections);
    // Its provider-version table belongs to the block, not to the plugin's UI.
    expect(integration).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(Object.keys(rest)).not.toContain("agent_integrations");
  });
});
