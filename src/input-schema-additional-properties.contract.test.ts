/**
 * Contract: every tool's inputSchema MUST set additionalProperties: false (#85).
 *
 * Background: AI agents frequently send fields with the wrong casing or
 * unexpected keys (e.g. `propertyID` instead of `propertyId`). With
 * additionalProperties unset (JSON-Schema default = true), Ajv silently
 * accepts the typo and the request reaches `lib/tools.ts:validateRequiredArgs`,
 * which then reports a generic "missing required propertyId" instead of the
 * specific "unknown property propertyID, did you mean propertyId?" feedback
 * the agent needs to self-correct.
 *
 * outputSchemas intentionally keep additionalProperties: true because
 * Stripe/Supabase passthrough objects (mpp, refund, breakdown,
 * cancellationPolicy) carry vendor-extensible fields.
 *
 * Run: npx tsx --test src/input-schema-additional-properties.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_SPECS } from "../lib/tool-definitions.js";

describe("inputSchema.additionalProperties = false (#85)", () => {
  for (const spec of TOOL_SPECS) {
    it(`${spec.name} inputSchema rejects unknown keys`, () => {
      assert.equal(
        spec.inputSchema.additionalProperties,
        false,
        `Tool '${spec.name}' inputSchema must declare additionalProperties: false so Ajv reports a field-level error on typo'd keys (see #85). Output schemas may stay open.`
      );
    });
  }
});
