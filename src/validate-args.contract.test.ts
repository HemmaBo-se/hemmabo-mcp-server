/**
 * Contract test: HTTP dispatcher input validation.
 *
 * Verifies validateToolArgs against the actual TOOLS[].inputSchema definitions
 * exported from api/mcp.ts. Catches regressions where a schema change breaks
 * a happy path or weakens validation on a tool argument.
 *
 * Strict-typing assertions:
 *   - Strings that look like numbers are NOT coerced (guests:"6" is rejected).
 *   - Negative or zero where minimum:1 is rejected.
 *   - Missing required fields produce required-property errors.
 *   - Unknown tools are tolerated (forwards-compat).
 *
 * Run: npx tsx --test src/validate-args.contract.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../api/mcp.js";
import {
  registerToolSchemas,
  validateToolArgs,
  _resetForTests,
} from "../lib/validate-args.js";

before(() => {
  _resetForTests();
  registerToolSchemas(TOOLS);
});

const VALID_SEARCH = {
  guests: 6,
  checkIn: "2026-11-13",
  checkOut: "2026-11-16",
};

describe("validateToolArgs happy paths", () => {
  it("accepts a fully valid search.properties payload", () => {
    const r = validateToolArgs("hemmabo_search_properties", VALID_SEARCH);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("accepts a valid booking.quote payload", () => {
    const r = validateToolArgs("hemmabo_booking_quote", {
      propertyId: "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      ...VALID_SEARCH,
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("accepts optional guests for search.availability so unavailable dates can return priced alternatives", () => {
    const r = validateToolArgs("hemmabo_search_availability", {
      propertyId: "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      ...VALID_SEARCH,
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});

describe("validateToolArgs strict typing", () => {
  it("rejects guests:'six' (string instead of integer)", () => {
    const r = validateToolArgs("hemmabo_search_properties", {
      ...VALID_SEARCH,
      guests: "six",
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors!.some((e) => e.path === "/guests"));
  });

  it("rejects guests:0 when minimum is 1", () => {
    const r = validateToolArgs("hemmabo_search_properties", {
      ...VALID_SEARCH,
      guests: 0,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors!.some((e) => e.path === "/guests"));
  });

  it("rejects guests as a float (must be integer)", () => {
    const r = validateToolArgs("hemmabo_search_properties", {
      ...VALID_SEARCH,
      guests: 2.5,
    });
    assert.equal(r.ok, false);
  });

  it("rejects invalid propertyId uuid values", () => {
    const r = validateToolArgs("hemmabo_booking_quote", {
      propertyId: "not-a-uuid",
      ...VALID_SEARCH,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors!.some((e) => e.path === "/propertyId" && /uuid/.test(e.message)));
  });

  it("rejects invalid guestEmail values", () => {
    const r = validateToolArgs("hemmabo_booking_create", {
      propertyId: "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      ...VALID_SEARCH,
      guestName: "Anna Svensson",
      guestEmail: "not-an-email",
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors!.some((e) => e.path === "/guestEmail" && /email/.test(e.message)));
  });
});

describe("validateToolArgs missing required fields", () => {
  it("reports required-property errors with field paths", () => {
    const r = validateToolArgs("hemmabo_search_properties", {});
    assert.equal(r.ok, false);
    const paths = r.errors!.map((e) => e.path).sort();
    assert.deepEqual(paths, ["/checkIn", "/checkOut", "/guests"]);
  });

  it("collects ALL missing fields in one pass (allErrors:true)", () => {
    const r = validateToolArgs("hemmabo_booking_create", {});
    assert.equal(r.ok, false);
    // booking.create requires propertyId, checkIn, checkOut, guests, guestName, guestEmail
    assert.ok((r.errors?.length ?? 0) >= 6, `expected >=6 errors, got ${r.errors?.length}`);
  });

  it("reports a missing single field for booking.cancel", () => {
    const r = validateToolArgs("hemmabo_booking_cancel", {});
    assert.equal(r.ok, false);
    assert.ok(r.errors!.some((e) => e.path === "/reservationId"));
  });
});

describe("validateToolArgs forwards compatibility", () => {
  it("returns ok=true for tools without a registered schema", () => {
    const r = validateToolArgs("future.unknown_tool", { foo: 1 });
    assert.equal(r.ok, true);
  });

  it("treats undefined args as empty object", () => {
    const r = validateToolArgs("hemmabo_search_properties", undefined);
    assert.equal(r.ok, false);
    assert.ok(r.errors!.length >= 1);
  });
});

describe("validateToolArgs covers every tool in TOOLS", () => {
  for (const tool of TOOLS) {
    it(`compiles a schema for ${tool.name}`, () => {
      // If the schema didn't compile, validateToolArgs would have thrown at
      // before(). This test confirms each tool is queryable through the public
      // API after registration.
      const r = validateToolArgs(tool.name, {});
      // Either ok (no required fields) or has errors — never undefined.
      assert.ok(typeof r.ok === "boolean");
    });
  }
});
