/**
 * Unit test — the per-booking ownership binding primitive (BOLA closure),
 * lib/booking-binding.ts.
 *
 * The invariant: a valid Bearer token authenticates the CALLER but is
 * client-scoped, not booking-scoped. Acting on a specific booking additionally
 * requires the booking's own `guest_token`. The MCP booking tools that bound
 * on it (cancel / status / reschedule) were removed from the platform
 * connector (ADR 0019); api/acp.ts still binds ACP checkouts with
 * bookingTokenMatches, so the comparison and its refusal text stay pinned here.
 *
 * Run: npx tsx --test src/booking-ownership-binding.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bookingTokenMatches, BOOKING_TOKEN_MISMATCH_MESSAGE } from "../lib/booking-binding.js";

const RIGHT = "11111111-1111-1111-1111-111111111111";
const WRONG = "22222222-2222-2222-2222-222222222222"; // another booking's token

const MISMATCH_RE = /does not match this booking/i;

// ── bookingTokenMatches unit ─────────────────────────────────────────────────
describe("bookingTokenMatches", () => {
  it("true for identical tokens", () => assert.equal(bookingTokenMatches(RIGHT, RIGHT), true));
  it("false for different tokens", () => assert.equal(bookingTokenMatches(RIGHT, WRONG), false));
  it("false for empty presented", () => assert.equal(bookingTokenMatches("", RIGHT), false));
  it("false for missing stored", () => assert.equal(bookingTokenMatches(RIGHT, null), false));
  it("false for non-string", () => assert.equal(bookingTokenMatches(123 as unknown, RIGHT), false));
  it("false on length mismatch", () => assert.equal(bookingTokenMatches("short", RIGHT), false));
  it("trims surrounding whitespace before comparing", () => assert.equal(bookingTokenMatches(` ${RIGHT} `, RIGHT), true));
});

// Keep the exported constant referenced so its wording stays test-locked.
describe("mismatch message is stable", () => {
  it("matches the exported constant", () => assert.match(BOOKING_TOKEN_MISMATCH_MESSAGE, MISMATCH_RE));
});
