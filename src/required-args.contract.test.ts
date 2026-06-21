import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool, validateRequiredArgs, type ToolClients } from "../lib/tools.js";

function stubClients(): ToolClients {
  const trap = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`unexpected supabase call (.${String(prop)}) - required-arg validation should reject first`);
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
  { tool: "hemmabo_compare_properties",  required: ["propertyIds", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_quote",       required: ["propertyId", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_create",      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"] },
  { tool: "hemmabo_booking_negotiate",   required: ["propertyId", "checkIn", "checkOut", "guests"] },
  { tool: "hemmabo_booking_checkout",    required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"] },
  { tool: "hemmabo_booking_cancel",      required: ["reservationId"] },
  { tool: "hemmabo_booking_status",      required: ["reservationId"] },
  { tool: "hemmabo_booking_reschedule",  required: ["reservationId", "newCheckIn", "newCheckOut"] },
  { tool: "verify_vacation_rental_node", required: ["domain"] },
  { tool: "get_verified_stay_offer",     required: ["domain", "checkIn", "checkOut", "guests"] },
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

  it("does NOT treat 0, empty string, or false as missing", () => {
    assert.equal(validateRequiredArgs({ guests: 0, checkIn: "", checkOut: "x" }, ["guests", "checkIn", "checkOut"]), null);
  });
});

describe("executeTool rejects empty args before reaching Supabase", () => {
  for (const { tool, required } of REQUIRED_BY_TOOL) {
    it(`${tool} with {} returns a clean tool error`, async () => {
      const result = await executeTool(tool, {}, stubClients());
      assert.equal(result.isError, true, `${tool} must set isError:true on missing args`);
      const text = result.content[0]?.text ?? "";
      assert.match(text, MISSING_RE, `${tool} error must be the validation message, got: ${text}`);
      for (const k of required) assert.match(text, new RegExp(k), `${tool} error must mention missing key '${k}'`);
      assert.doesNotMatch(text, POSTGRES_LEAK_RE, `${tool} must not leak Postgres errors: ${text}`);
    });
  }

  it("search.properties with partial args (only region) is rejected", async () => {
    const result = await executeTool("hemmabo_search_properties", { region: "Skane" }, stubClients());
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, MISSING_RE);
    assert.doesNotMatch(text, POSTGRES_LEAK_RE);
  });
});
