import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANON_TOOLS, isAuthRequiredMessage, TOOLS } from "../api/mcp.js";

const ANON_CANONICAL_NAMES = [
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "hemmabo_search_similar",
  "hemmabo_compare_properties",
  "hemmabo_booking_quote",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
] as const;

const ANON_ALIASES = [
  "search.properties",
  "search.availability",
  "search.similar",
  "search.compare",
  "booking.quote",
] as const;

const AUTH_REQUIRED_TOOLS = [
  "hemmabo_booking_create",
  "hemmabo_booking_negotiate",
  "hemmabo_booking_checkout",
  "hemmabo_booking_cancel",
  "hemmabo_booking_reschedule",
  "hemmabo_booking_status",
] as const;

describe("anonymous tool allowlist contract", () => {
  it("ANON_TOOLS contains exactly the 7 read-only canonical names plus 5 aliases", () => {
    assert.equal(ANON_TOOLS.size, 12);
    for (const n of [...ANON_CANONICAL_NAMES, ...ANON_ALIASES]) {
      assert.ok(ANON_TOOLS.has(n), `expected ANON_TOOLS to contain ${n}`);
    }
  });

  it("every anon canonical tool is annotated readOnlyHint:true in TOOLS metadata", () => {
    for (const name of ANON_CANONICAL_NAMES) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} not found in TOOLS`);
      assert.equal(tool!.annotations?.readOnlyHint, true, `tool ${name} must have readOnlyHint:true`);
      assert.equal(tool!.annotations?.destructiveHint, false, `tool ${name} must have destructiveHint:false`);
    }
  });

  it("no auth-required tool is in ANON_TOOLS", () => {
    for (const name of AUTH_REQUIRED_TOOLS) {
      assert.ok(!ANON_TOOLS.has(name), `${name} must NOT be anonymous`);
    }
  });
});

describe("isAuthRequiredMessage decision function", () => {
  it("returns false for initialize/tools/list/prompts/ping", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }), false);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "prompts/list" }), false);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "prompts/get" }), false);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "ping" }), false);
  });

  it("returns false for tools/call to anon canonical tools", () => {
    for (const name of ANON_CANONICAL_NAMES) {
      assert.equal(
        isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        false,
        `${name} must be callable without auth`
      );
    }
  });

  it("returns false for tools/call to anon legacy aliases", () => {
    for (const name of ANON_ALIASES) {
      assert.equal(
        isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        false,
        `${name} must be callable without auth`
      );
    }
  });

  it("returns true for every write/PII tool", () => {
    for (const name of AUTH_REQUIRED_TOOLS) {
      assert.equal(
        isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        true,
        `${name} must require auth`
      );
    }
  });

  it("returns true for missing, non-string, or unknown tool names", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }), true);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 42 } }), true);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call" }), true);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search.properties.evil", arguments: {} } }), true);
  });

  it("ignores malformed non-tool messages safely", () => {
    assert.equal(isAuthRequiredMessage(null), false);
    assert.equal(isAuthRequiredMessage(undefined), false);
    assert.equal(isAuthRequiredMessage("not an object"), false);
    assert.equal(isAuthRequiredMessage(42), false);
  });
});
