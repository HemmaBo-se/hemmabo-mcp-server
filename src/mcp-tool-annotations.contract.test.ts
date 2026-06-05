import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../api/mcp.js";

const EXPECTED: Record<string, { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean }> = {
  "hemmabo_search_properties":   { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_search_availability": { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_search_similar":      { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_compare_properties":  { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_booking_quote":       { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_booking_create":      { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  "hemmabo_booking_negotiate":   { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  "hemmabo_booking_checkout":    { readOnlyHint: false, openWorldHint: true,  destructiveHint: false },
  "hemmabo_booking_cancel":      { readOnlyHint: false, openWorldHint: true,  destructiveHint: true  },
  "hemmabo_booking_status":      { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_booking_reschedule":  { readOnlyHint: false, openWorldHint: true,  destructiveHint: true  },
  "hemmabo_host_readiness_check": { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "hemmabo_host_onboarding_link": { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "verify_vacation_rental_node": { readOnlyHint: true,  openWorldHint: true,  destructiveHint: false },
  "get_verified_stay_offer":     { readOnlyHint: true,  openWorldHint: true,  destructiveHint: false },
};

describe("mcp tool annotations contract", () => {
  it("exposes exactly the 15 expected tools", () => {
    const actualNames = TOOLS.map((t) => t.name).sort();
    const expectedNames = Object.keys(EXPECTED).sort();
    assert.deepEqual(
      actualNames,
      expectedNames,
      "TOOLS array must contain exactly the 11 HemmaBo federation tools plus 2 host onboarding tools plus 2 VRP tools."
    );
  });

  for (const [toolName, expected] of Object.entries(EXPECTED)) {
    it(`${toolName} has the locked annotation triplet`, () => {
      const tool = TOOLS.find((t) => t.name === toolName);
      assert.ok(tool, `tool '${toolName}' must exist in TOOLS`);
      const a = tool.annotations as { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean } | undefined;
      assert.ok(a, `tool '${toolName}' must have an annotations block`);
      assert.equal(a.readOnlyHint, expected.readOnlyHint, `${toolName}.readOnlyHint drifted`);
      assert.equal(a.openWorldHint, expected.openWorldHint, `${toolName}.openWorldHint drifted`);
      assert.equal(a.destructiveHint, expected.destructiveHint, `${toolName}.destructiveHint drifted`);
    });
  }
});
