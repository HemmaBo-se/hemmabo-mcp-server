/**
 * Drift-skydd: TOOL_SPECS i lib/tool-definitions.ts är single source of truth
 * för de 11 federation-tools. Detta test failar om:
 *
 *   (a) TOOL_SPECS innehåller fler eller färre än de 11 förväntade tool-namnen
 *   (b) Något annan källfil (utöver lib/tool-definitions.ts) deklarerar ett tool
 *       genom statisk literal — t.ex. `name: "hemmabo_search_properties"` i en
 *       TOOLS-array eller `server.tool("hemmabo_search_properties", ...)` direktanrop.
 *   (c) api/mcp.ts TOOLS exports inte exakt motsvarar TOOL_SPECS i ordning.
 *
 * Bakgrund (#63 / ADR-0001 §3): tidigare definierades samma 11 tools i tre
 * separata filer (api/mcp.ts, src/index.ts, src/stdio.ts), vilket ledde till
 * att endast api/mcp.ts var kontrakt-testad och stdio/index kunde driva fritt.
 * Drift-skyddet här stänger ner möjligheten att återinföra dual-/tri-SoT.
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
] as const;

/**
 * Filer som FÅR nämna tool-namnen som strängliterals — varje annan källfil
 * måste hämta tools via TOOL_SPECS / TOOL_NAMES eller via api/mcp.ts TOOLS.
 *
 * Notera: tool-namnen får förekomma i descriptions, errors, kommentarer och
 * tester. Drift-checken nedan filtrerar enbart de mönster som indikerar att
 * ett tool RE-DEKLARERAS (TOOLS-literal, server.tool-anrop, executeTool när
 * det är hardkodat utanför lib/tools.ts dispatcher).
 */
const ALLOWED_DECLARATION_FILES = new Set<string>([
  "lib/tool-definitions.ts",
]);

describe("TOOL_SPECS singleton (#63)", () => {
  it("(a) exposes exactly the 11 expected canonical tool names in declaration order", () => {
    assert.deepEqual(
      TOOL_NAMES,
      EXPECTED_TOOL_NAMES,
      "TOOL_SPECS must declare exactly the 11 federation tools, in canonical order. Adding/removing a tool requires updating this test and chatgpt-app-submission.json."
    );
  });

  it("(b) api/mcp.ts TOOLS export is in lock-step with TOOL_SPECS", () => {
    const wireNames = TOOLS.map((t) => t.name);
    assert.deepEqual(
      wireNames,
      EXPECTED_TOOL_NAMES,
      "api/mcp.ts TOOLS must derive from TOOL_SPECS in the same order — see comment block in api/mcp.ts Tools section."
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
    // Forbidden patterns indicating a tool is being re-declared elsewhere:
    //   - `server.tool("hemmabo_search_properties"` (SDK registration of a dotted tool name)
    //   - `name: "hemmabo_search_properties"` inside an object literal at the start
    //     of a `TOOLS = [` array. We look for the simpler exact substring
    //     `name: "hemmabo_search_properties"` and require it to live only in
    //     lib/tool-definitions.ts.
    const forbiddenPatterns: { pattern: RegExp; reason: string }[] = [];
    for (const name of EXPECTED_TOOL_NAMES) {
      // Full regex-metachar escape (CodeQL js/incomplete-sanitization).
      // Our tool names today only contain letters and dots, but escaping
      // every metacharacter keeps the guard correct if a future name uses
      // characters like `_`, `-`, `+` or `?`.
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // server.tool("foo.bar", — direct SDK registration
      forbiddenPatterns.push({
        pattern: new RegExp(`server\\.tool\\(\\s*"${escapedName}"`),
        reason: `direct server.tool("${name}", ...) registration — must go through TOOL_SPECS loop`,
      });
      // name: "foo.bar" — tool-spec literal in a sibling TOOLS array
      forbiddenPatterns.push({
        pattern: new RegExp(`name:\\s*"${escapedName}"`),
        reason: `static tool-spec literal { name: "${name}", ... } — must live only in TOOL_SPECS`,
      });
    }

    // Sweep src/ and api/ excluding the allow-list and test files (tests may
    // reference tool names freely).
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

// ── Helpers ─────────────────────────────────────────────────────

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
      if (entry.name.endsWith(".test.ts")) continue; // tests may mention any name
      out.push(childRel);
    }
  }
  return out;
}
