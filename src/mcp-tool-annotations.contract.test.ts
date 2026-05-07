/**
 * Drift-skydd: låser annotation-tripletten (readOnlyHint, openWorldHint,
 * destructiveHint) per MCP-tool i api/mcp.ts.
 *
 * Bakgrund: PR #43 fixade fyra felaktiga annotations efter genomgång mot
 * canonical SoT i hemmabo-smart-stays:
 *   - booking.negotiate: readOnlyHint true → false (gör INSERT på
 *     property_quote_snapshots)
 *   - booking.checkout:  openWorldHint false → true (anropar Stripe API)
 *   - booking.cancel:    openWorldHint false → true (anropar Stripe-refund
 *     via Supabase Edge Function cancel-booking)
 *   - booking.reschedule: openWorldHint false → true (anropar Stripe
 *     createPaymentIntent eller createRefund)
 *
 * Detta test failar om någon av de 11 tools i TOOLS-arrayen får sin
 * annotation-triplett ändrad. ChatGPT Apps SDK granskning kräver att
 * dessa hints är sanningsenliga — drift here is a submission blocker.
 *
 * Justifications i submission/chatgpt-app-submission.json är textbaserade
 * och inte automatiserat låsta — de granskas manuellt vid PR-review.
 *
 * Run: npx tsx --test src/mcp-tool-annotations.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../api/mcp.js";

/**
 * Sann annotation-triplett per tool, verifierad mot lib/tools.ts handler-
 * implementationer (PR #43, sammanfattning):
 *
 * search.*       — read-only SELECT-frågor mot federation Supabase
 * booking.quote  — beräknar pris från reads, inga writes, ingen Stripe
 * booking.create — INSERT bookings, ingen Stripe-anrop (sync handler-väg)
 * booking.negotiate — INSERT property_quote_snapshots
 * booking.checkout  — INSERT bookings + Stripe createCheckoutSession
 * booking.cancel    — UPDATE booking + Edge Function som triggar Stripe-refund
 * booking.status    — read-only SELECT
 * booking.reschedule — UPDATE booking + Stripe createPaymentIntent eller createRefund
 */
const EXPECTED: Record<string, { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean }> = {
  "search.properties":   { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "search.availability": { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "search.similar":      { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "search.compare":      { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "booking.quote":       { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "booking.create":      { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  "booking.negotiate":   { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  "booking.checkout":    { readOnlyHint: false, openWorldHint: true,  destructiveHint: false },
  "booking.cancel":      { readOnlyHint: false, openWorldHint: true,  destructiveHint: true  },
  "booking.status":      { readOnlyHint: true,  openWorldHint: false, destructiveHint: false },
  "booking.reschedule":  { readOnlyHint: false, openWorldHint: true,  destructiveHint: true  },
};

describe("mcp tool annotations contract", () => {
  it("exposes exactly the 11 expected tools", () => {
    const actualNames = TOOLS.map((t) => t.name).sort();
    const expectedNames = Object.keys(EXPECTED).sort();
    assert.deepEqual(
      actualNames,
      expectedNames,
      "TOOLS array in api/mcp.ts must contain exactly the 11 tools listed in EXPECTED. Adding/removing a tool requires updating this contract test and chatgpt-app-submission.json."
    );
  });

  for (const [toolName, expected] of Object.entries(EXPECTED)) {
    it(`${toolName} has the locked annotation triplet (${expected.readOnlyHint}/${expected.openWorldHint}/${expected.destructiveHint})`, () => {
      const tool = TOOLS.find((t) => t.name === toolName);
      assert.ok(tool, `tool '${toolName}' must exist in TOOLS`);
      const a = tool.annotations as { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean } | undefined;
      assert.ok(a, `tool '${toolName}' must have an annotations block`);

      assert.equal(
        a.readOnlyHint,
        expected.readOnlyHint,
        `${toolName}.readOnlyHint must be ${expected.readOnlyHint} — flipping this without updating handler behaviour and chatgpt-app-submission.json is a submission blocker.`
      );
      assert.equal(
        a.openWorldHint,
        expected.openWorldHint,
        `${toolName}.openWorldHint must be ${expected.openWorldHint} — true if and only if the synchronous handler path calls an external system (Stripe, e-mail, public webhooks).`
      );
      assert.equal(
        a.destructiveHint,
        expected.destructiveHint,
        `${toolName}.destructiveHint must be ${expected.destructiveHint} — true if and only if the handler can cancel, overwrite or refund existing data in an irreversible way.`
      );
    });
  }
});
