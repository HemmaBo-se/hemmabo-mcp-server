import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS } from "../lib/tool-definitions.js";
import { VRP_PROTOCOL } from "../lib/vrp.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * VRP v0.1 §2 pins the discovery document's `protocol` field to the const
 * `vacation-rental-protocol` (vrp-spec schemas/discovery-v0.1.schema.json), and
 * lib/vrp.ts never emits anything else. The tool-surface copy used to say
 * "typically 'vrp'" — a value no host ever publishes and agents would have
 * matched against. This guard keeps the description aligned with the spec on
 * every surface that carries the outputSchema (runtime + glama.json).
 */
describe("verify_vacation_rental_node protocol wording matches VRP v0.1", () => {
  const STALE = "typically 'vrp'";

  it("no tool definition mentions the stale 'vrp' protocol identifier", () => {
    const serialized = JSON.stringify(TOOL_SPECS);
    assert.ok(!serialized.includes(STALE), `tool definitions still contain ${JSON.stringify(STALE)}`);
  });

  it("runtime outputSchema.protocol description names the VRP const", () => {
    const tool = TOOL_SPECS.find((t) => t.name === "verify_vacation_rental_node");
    assert.ok(tool, "verify_vacation_rental_node tool spec missing");
    const props = (tool.outputSchema as { properties?: Record<string, { description?: string }> }).properties;
    const description = props?.protocol?.description ?? "";
    assert.ok(
      description.includes(`'${VRP_PROTOCOL}'`),
      `protocol description must quote '${VRP_PROTOCOL}', got: ${JSON.stringify(description)}`,
    );
  });

  it("glama.json (hand-maintained registry copy) carries the same wording", () => {
    const glama = readFileSync(resolve(REPO_ROOT, "glama.json"), "utf8");
    assert.ok(!glama.includes(STALE), `glama.json still contains ${JSON.stringify(STALE)}`);
    assert.ok(glama.includes(`('${VRP_PROTOCOL}' per VRP v0.1 §2)`), "glama.json protocol description drifted from lib/tool-definitions.ts");
  });
});
