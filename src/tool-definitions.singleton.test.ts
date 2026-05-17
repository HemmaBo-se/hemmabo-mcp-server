/**
 * Drift-skydd: TOOL_SPECS i lib/tool-definitions.ts ar single source of truth
 * for HemmaBo federation tools plus the neutral VRP v0.1 tools.
 *
 * Run: npx tsx --test src/tool-definitions.singleton.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS, TOOL_NAMES } from "../lib/tool-definitions.js";
import { TOOLS } from "../api/mcp.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_TOOL_NAMES = [
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "hemmabo_search_similar",
  "hemmabo_compare_properties",
  "hemmabo_booking_quote",
  "hemmabo_booking_create",
  "hemmabo_booking_negotiate",
  "hemmabo_booking_checkout",
  "hemmabo_booking_cancel",
  "hemmabo_booking_status",
  "hemmabo_booking_reschedule",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
] as const;

const ALLOWED_DECLARATION_FILES = new Set<string>([
  "lib/tool-definitions.ts",
  "lib/tool-definitions-base.ts",
]);

describe("TOOL_SPECS singleton (#63 + VRP v0.1)", () => {
  it("(a) exposes exactly the 13 expected canonical tool names in declaration order", () => {
    assert.deepEqual(
      TOOL_NAMES,
      EXPECTED_TOOL_NAMES,
      "TOOL_SPECS must declare exactly the 11 HemmaBo tools plus 2 VRP tools, in canonical order."
    );
  });

  it("(b) api/mcp.ts TOOLS export is in lock-step with TOOL_SPECS", () => {
    const wireNames = TOOLS.map((t) => t.name);
    assert.deepEqual(
      wireNames,
      EXPECTED_TOOL_NAMES,
      "api/mcp.ts TOOLS must derive from TOOL_SPECS in the same order."
    );

    for (let i = 0; i < TOOL_SPECS.length; i++) {
      const spec = TOOL_SPECS[i];
      const wire = TOOLS[i];
      assert.equal(wire.description, spec.description, `${spec.name}: description must match`);
      assert.equal(wire.inputSchema, spec.inputSchema, `${spec.name}: inputSchema must be same object`);
      assert.equal(wire.outputSchema, spec.outputSchema, `${spec.name}: outputSchema must be same object`);
      assert.equal(wire.annotations, spec.annotations, `${spec.name}: annotations must be same object`);
    }
  });

  it("(c) no other source file declares a tool by static literal", () => {
    const forbiddenPatterns: { pattern: RegExp; reason: string }[] = [];
    for (const name of EXPECTED_TOOL_NAMES) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      forbiddenPatterns.push({
        pattern: new RegExp(`server\\.tool\\(\\s*"${escapedName}"`),
        reason: `direct server.tool("${name}", ...) registration must go through TOOL_SPECS loop`,
      });
      forbiddenPatterns.push({
        pattern: new RegExp(`name:\\s*"${escapedName}"`),
        reason: `static tool-spec literal { name: "${name}", ... } must live only in TOOL_SPECS`,
      });
    }

    const sourceFiles = collectSourceFiles(REPO_ROOT);
    for (const relPath of sourceFiles) {
      if (ALLOWED_DECLARATION_FILES.has(relPath)) continue;
      const text = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
      for (const { pattern, reason } of forbiddenPatterns) {
        const m = text.match(pattern);
        if (m) {
          assert.fail(
            `Drift detected in ${relPath}: ${reason}. Match: ${JSON.stringify(m[0])}. ` +
              `Add or modify the tool in lib/tool-definitions.ts only.`
          );
        }
      }
    }
  });
});

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const queue: string[] = ["src", "api", "lib"];
  while (queue.length) {
    const rel = queue.shift()!;
    const abs = resolve(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(childRel);
    }
  }
  return out;
}
