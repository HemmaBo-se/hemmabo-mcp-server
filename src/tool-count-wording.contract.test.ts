import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS as RUNTIME_TOOL_SPECS } from "../lib/tool-definitions.js";
import { TOOL_SPECS as HEMMABO_TOOL_SPECS } from "../lib/tool-definitions-base.js";
import { VRP_TOOL_NAMES } from "../lib/vrp.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".js", ".json", ".faf", ".txt", ".yaml", ".yml"]);
const SCAN_PATHS = [
  ".github/agents",
  "api",
  "lib",
  "src",
  "project.faf",
  "package.json",
  "server.json",
  "glama.json",
  "README.md",
  "llms.txt",
  "submission/chatgpt-app-submission.json",
];
const EXCLUDED_FILES = new Set(["src/tool-count-wording.contract.test.ts"]);

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectFiles(path: string, out: string[] = []): string[] {
  const absolute = resolve(REPO_ROOT, path);
  if (!existsSync(absolute)) return out;
  const relative = toPosix(path);
  if (EXCLUDED_FILES.has(relative)) return out;
  const entries = readdirSync(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectFiles(child, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(toPosix(child))) continue;
    if (TEXT_EXTENSIONS.has(extname(entry.name)) || entry.name === "project.faf") {
      out.push(toPosix(child));
    }
  }
  return out;
}

function collectScanFiles(): string[] {
  const files = new Set<string>();
  for (const path of SCAN_PATHS) {
    const absolute = resolve(REPO_ROOT, path);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) {
      for (const file of collectFiles(path)) files.add(file);
      continue;
    }
    files.add(toPosix(path));
  }
  return [...files].sort();
}

describe("tool count wording contract", () => {
  it("runtime tool counts are explicit", () => {
    assert.equal(HEMMABO_TOOL_SPECS.length, 11, "HemmaBo federation tool count must stay explicit");
    assert.equal(VRP_TOOL_NAMES.length, 2, "VRP verification tool count must stay explicit");
    assert.equal(
      RUNTIME_TOOL_SPECS.length,
      HEMMABO_TOOL_SPECS.length + VRP_TOOL_NAMES.length,
      "runtime tool count must equal 11 HemmaBo federation tools plus 2 VRP verification tools",
    );
  });

  it("does not describe the full runtime surface as all 11 tools", () => {
    const ambiguousAllEleven = new RegExp("\\ball\\s+11\\s+(?:runtime\\s+)?tool(?:s|\\s+specs)?\\b", "i");
    const offenders: string[] = [];

    for (const file of collectScanFiles()) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (ambiguousAllEleven.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      [
        "Do not write 'all 11 tools/specs' for the runtime MCP surface.",
        "Use '13 runtime tools: 11 HemmaBo federation tools plus 2 VRP verification tools'.",
        "It is still OK to say '11 HemmaBo federation tools' when referring only to the booking/federation subset.",
      ].join(" "),
    );
  });
});
