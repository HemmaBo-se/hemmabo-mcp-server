/**
 * Contract test: anonymous read, signed write.
 *
 * Locks the auth gate in api/mcp.ts so a future refactor cannot silently
 * close discovery tools (which would make ChatGPT-thinking fall back to
 * Airbnb/Booking) or open booking writes.
 *
 * Tests the pure decision function isAuthRequiredMessage. The HTTP layer
 * uses this same function so this test is the source-of-truth contract.
 *
 * Run: npx tsx --test src/mcp-anonymous-access.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANON_TOOLS, isAuthRequiredMessage, TOOLS } from "../api/mcp.js";

const ANON_DOT_NAMES = [
  "search.properties",
  "search.availability",
  "search.similar",
  "search.compare",
  "booking.quote",
] as const;

const ANON_ALIASES = [
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "hemmabo_search_similar",
  "hemmabo_compare_properties",
  "hemmabo_booking_quote",
] as const;

const AUTH_REQUIRED_TOOLS = [
  "booking.create",
  "booking.negotiate",
  "booking.checkout",
  "booking.cancel",
  "booking.reschedule",
  "booking.status",
] as const;

describe("anonymous tool allowlist contract", () => {
  it("ANON_TOOLS contains exactly the 5 read-only dot names plus their 5 aliases", () => {
    assert.equal(ANON_TOOLS.size, 10);
    for (const n of [...ANON_DOT_NAMES, ...ANON_ALIASES]) {
      assert.ok(ANON_TOOLS.has(n), `expected ANON_TOOLS to contain ${n}`);
    }
  });

  it("every anon tool is annotated readOnlyHint:true in TOOLS metadata", () => {
    for (const name of ANON_DOT_NAMES) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} not found in TOOLS`);
      assert.equal(
        tool!.annotations?.readOnlyHint,
        true,
        `tool ${name} must have readOnlyHint:true to be in ANON_TOOLS`
      );
      assert.equal(
        tool!.annotations?.destructiveHint,
        false,
        `tool ${name} must have destructiveHint:false to be in ANON_TOOLS`
      );
    }
  });

  it("no auth-required tool is in ANON_TOOLS (fail-closed for writes)", () => {
    for (const name of AUTH_REQUIRED_TOOLS) {
      assert.ok(
        !ANON_TOOLS.has(name),
        `${name} must NOT be anonymous — it writes state or returns PII`
      );
    }
  });
});

describe("isAuthRequiredMessage decision function", () => {
  it("returns false for initialize", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }), false);
  });

  it("returns false for tools/list", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
  });

  it("returns false for prompts/list and prompts/get", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "prompts/list" }), false);
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "prompts/get" }), false);
  });

  it("returns false for ping", () => {
    assert.equal(isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "ping" }), false);
  });

  it("returns false for tools/call to anon dot-named tools", () => {
    for (const name of ANON_DOT_NAMES) {
      assert.equal(
        isAuthRequiredMessage({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
        false,
        `${name} must be callable without auth`
      );
    }
  });

  it("returns false for tools/call to anon legacy aliases", () => {
    for (const name of ANON_ALIASES) {
      assert.equal(
        isAuthRequiredMessage({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
        false,
        `alias ${name} must be callable without auth`
      );
    }
  });

  it("returns true for tools/call to every write/PII tool", () => {
    for (const name of AUTH_REQUIRED_TOOLS) {
      assert.equal(
        isAuthRequiredMessage({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
        true,
        `${name} must require auth`
      );
    }
  });

  it("returns true for tools/call with missing or non-string tool name (fail-closed)", () => {
    assert.equal(
      isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      true
    );
    assert.equal(
      isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 42 } }),
      true
    );
    assert.equal(
      isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      true
    );
  });

  it("returns true for unknown tool names (fail-closed)", () => {
    assert.equal(
      isAuthRequiredMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search.properties.evil", arguments: {} },
      }),
      true
    );
  });

  it("ignores malformed messages safely", () => {
    assert.equal(isAuthRequiredMessage(null), false);
    assert.equal(isAuthRequiredMessage(undefined), false);
    assert.equal(isAuthRequiredMessage("not an object"), false);
    assert.equal(isAuthRequiredMessage(42), false);
  });
});
