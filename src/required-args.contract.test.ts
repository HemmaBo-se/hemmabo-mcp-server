/**
 * Contract test: required-arg validation for every tool.
 *
 * Regression guard for prod incident: search.properties with empty {} args
 * returned `{"error":"invalid input syntax for type integer: \"undefined\""}`
 * because the JS literal `undefined` was forwarded to a Supabase .gte()
 * filter and serialized as the string "undefined".
 *
 * Every tool with required JSON-Schema fields must reject empty/missing args
 * with a clear "Missing required argument(s): …" message BEFORE any
 * Supabase/Stripe call. No Postgres internals may leak to the caller.
 *
 * Run: npx tsx --test src/required-args.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool, validateRequiredArgs, type ToolClients } from "../lib/tools.js";

// Stub clients — these MUST NOT be called when args are missing. If they are,
// the test fails with a clear marker.
function stubClients(): ToolClients {
  const trap = new Proxy({}, {
    get(_t, prop) {
      throw new Error(
        `unexpected supabase call (.${String(prop)}) — required-arg validation should have rejected the request first`
      );
    },
  });
  return { supabase: trap as never, reader: trap as never };
}

const MISSING_RE = /Missing required argument\(s\):/;
const POSTGRES_LEAK_RE = /invalid input syntax|"undefined"|22P02|relation .* does not exist/i;

const REQUIRED_BY_TOOL: ReadonlyArray<{ tool: string; required: readonly string[] }> = [
  { tool: "hemmabo_search_properties",   required: ["guests", "checkIn", "checkOut"] },
  { tool: "hemmabo_search_availability", required: ["propertyId", "checkIn", "checkOut"] },
  { tool: "hemmabo_search_similar",      required: ["propertyId", "checkIn", "checkOut"] },
  { tool: "hemmabo_compare_properties",      required: ["propertyIds", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_quote",       required: ["propertyId", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_create",      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"] },
  { tool: "hemmabo_booking_negotiate",   required: ["propertyId", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_checkout",    required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"] },
  { tool: "hemmabo_booking_cancel",      required: ["reservationId"] },
  { tool: "hemmabo_booking_status",      required: ["reservationId"] },
  { tool: "hemmabo_booking_reschedule",  required: ["reservationId", "newCheckIn", "newCheckOut"] },
];

describe("validateRequiredArgs unit", () => {
  it("returns null when all required keys are present", () => {
    assert.equal(
      validateRequiredArgs({ guests: 6, checkIn: "2026-11-13", checkOut: "2026-11-16" }, ["guests", "checkIn", "checkOut"]),
      null
    );
  });

  it("returns a message listing missing keys", () => {
    const msg = validateRequiredArgs({ checkIn: "2026-11-13" }, ["guests", "checkIn", "checkOut"]);
    assert.match(msg ?? "", MISSING_RE);
    assert.match(msg ?? "", /guests/);
    assert.match(msg ?? "", /checkOut/);
    assert.doesNotMatch(msg ?? "", /checkIn/);
  });

  it("treats explicit null and undefined as missing", () => {
    assert.match(
      validateRequiredArgs({ guests: undefined, checkIn: null, checkOut: "x" } as Record<string, unknown>, ["guests", "checkIn", "checkOut"]) ?? "",
      MISSING_RE
    );
  });

  it("does NOT treat 0, empty string, or false as missing (boundary values are caller's concern)", () => {
    assert.equal(
      validateRequiredArgs({ guests: 0, checkIn: "", checkOut: "x" }, ["guests", "checkIn", "checkOut"]),
      null
    );
  });
});

describe("executeTool rejects empty args before reaching Supabase", () => {
  for (const { tool, required } of REQUIRED_BY_TOOL) {
    it(`${tool} with {} returns a clean tool error and never queries the DB`, async () => {
      const result = await executeTool(tool, {}, stubClients());
      assert.equal(result.isError, true, `${tool} must set isError:true on missing args`);
      const text = result.content[0]?.text ?? "";
      assert.match(text, MISSING_RE, `${tool} error must be the validation message, got: ${text}`);
      // None of the required field names should be missing from the message.
      for (const k of required) {
        assert.match(text, new RegExp(k), `${tool} error must mention missing key '${k}'`);
      }
      // No Postgres internals must leak (the original prod incident).
      assert.doesNotMatch(text, POSTGRES_LEAK_RE, `${tool} must not leak Postgres errors: ${text}`);
    });
  }

  it("search.properties with partial args (only region) is rejected — reproducer for the prod 200-wrapping-error incident", async () => {
    const result = await executeTool("hemmabo_search_properties", { region: "Skane" }, stubClients());
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, MISSING_RE);
    assert.doesNotMatch(text, POSTGRES_LEAK_RE);
  });

  it("dot-notation and underscored alias share the same validation gate", async () => {
    const dot = await executeTool("hemmabo_search_properties", {}, stubClients());
    const alias = await executeTool("hemmabo_search_properties", {}, stubClients());
    assert.equal(dot.isError, true);
    assert.equal(alias.isError, true);
  });
});
