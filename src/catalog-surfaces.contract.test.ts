/**
 * Catalog surfaces gate (CEO order 2026-10-01, package 5.0.0).
 *
 * npm, Glama, Smithery and the MCP Registry read these files, not the live
 * server. npm 4.0.9 shipped the 13-tool connector under the same version
 * number the live 6-tool server reported, and Glama mirrored a README that
 * still carried the struck class wording below. This gate holds every
 * catalog-read surface to the live contract: the exact count sentence, the
 * six tool names, the category law, and none of the struck phrases.
 *
 * server.json carries the count sentence and "Not an OTA." (exactly 100
 * characters): the MCP Registry caps description at 100, and the count
 * sentence (88) and the category law (71) do not fit together.
 *
 * Historical records (docs/adr/**, docs/operations/**) are out of scope: they
 * may say 13 and checkout in the past tense.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_LAW } from "../lib/server-metadata.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

const COUNT_SENTENCE =
  "6 runtime tools: 2 HemmaBo tools, 2 host onboarding tools, and 2 VRP verification tools.";

const SIX_TOOLS = [
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
];

// The seven booking tools removed by ADR 0019 all carried this prefix.
const REMOVED_TOOL_PREFIX = /hemmabo_booking_/;

// Written as patterns so the struck wording itself never reappears in the repo.
const STRUCK: RegExp[] = [
  /infrastructure\s+and\s+federation/i,
  /federation\s+mcp\s+server/i,
  /booking\s+infrastructure/i,
  /no\s+central\s+gatekeeper/i,
  /trust\s+layer/i,
  /\benforces\b/i,
  /no-gatekeeper\s+trust\s+path/i,
  /\b1[1345][ -](runtime\s+)?tools\b/i,
];

const SURFACES: Record<string, string> = {
  "README.md": read("README.md"),
  "llms.txt": read("llms.txt"),
  "package.json description": String(JSON.parse(read("package.json")).description),
  "glama.json": read("glama.json"),
  "smithery.yaml": read("smithery.yaml"),
  "project.faf": read("project.faf"),
  "server.json": read("server.json"),
};

// Surfaces that list the tools by name.
const TOOL_LISTS = ["README.md", "llms.txt", "glama.json", "project.faf"];

describe("catalog surfaces contract", () => {
  it("every catalog surface carries the exact count sentence", () => {
    for (const [name, text] of Object.entries(SURFACES)) {
      assert.ok(text.includes(COUNT_SENTENCE), `${name} must carry: ${COUNT_SENTENCE}`);
    }
  });

  it("every catalog surface but server.json carries the category law", () => {
    for (const [name, text] of Object.entries(SURFACES)) {
      if (name === "server.json") continue;
      assert.ok(text.includes(CATEGORY_LAW), `${name} must carry the category law`);
    }
  });

  it("server.json description is the count sentence and fits the MCP Registry limit", () => {
    const description = String(JSON.parse(SURFACES["server.json"]).description);
    assert.equal(description, `${COUNT_SENTENCE} Not an OTA.`);
    assert.ok(description.length <= 100, "MCP Registry caps description at 100 characters");
  });

  it("no struck phrase survives on a catalog surface", () => {
    for (const [name, text] of Object.entries(SURFACES)) {
      for (const pattern of STRUCK) {
        assert.doesNotMatch(text, pattern, `${name} must not carry ${pattern}`);
      }
    }
  });

  it("the tool lists name exactly the six tools and no removed booking tool", () => {
    for (const name of TOOL_LISTS) {
      const text = SURFACES[name];
      for (const tool of SIX_TOOLS) {
        assert.ok(text.includes(tool), `${name} must list ${tool}`);
      }
    }
    for (const [name, text] of Object.entries(SURFACES)) {
      assert.doesNotMatch(text, REMOVED_TOOL_PREFIX, `${name} must not name a hemmabo_booking_* tool`);
    }
    const glamaTools = (JSON.parse(SURFACES["glama.json"]).tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual([...glamaTools].sort(), [...SIX_TOOLS].sort());
    const fafTools = [...SURFACES["project.faf"].matchAll(/^\s+- name: "([^"]+)"$/gm)].map((m) => m[1]);
    assert.deepEqual([...fafTools].sort(), [...SIX_TOOLS].sort());
  });

  it("the ACP paragraph in llms.txt is an HTTP surface, not an MCP tool", () => {
    const llms = SURFACES["llms.txt"];
    assert.ok(
      llms.includes("no MCP tool checks out, takes payment or cancels"),
      "llms.txt must say the MCP tools do not check out, take payment or cancel",
    );
  });
});
