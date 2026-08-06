/**
 * Vendored fx-core contract.
 *
 * lib/fx-core.ts is a byte-identical vendored mirror of smart-stays
 * `contracts/ts/fx-core.ts` (repo-lockstep, same law as the pricing-core
 * vendoring; ADR 2026-08-06-fx-core-node-currency-base). This contract
 * enforces that the mirror answers identically to the smart-stays fixtures
 * (`src/test/fx-core.test.ts`) — same inputs ⇒ same converted figures and
 * the same fail-closed refusals, every repo.
 *
 * Also pins the display doctrine on this repo's own surface: the stay-offer
 * translation is DISPLAY grade — approximate, ≈-marked, original visible —
 * and the guest-language → currency map matches the node's own pages.
 *
 * Run: npx tsx --test src/fx-core-vendored.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SETTLEMENT_MAX_AGE_MS,
  type FxSnapshot,
  assessSettlementGrade,
  buildFrankfurterUrl,
  convertForDisplay,
  convertForSettlement,
  isSupportedNodeCurrency,
} from "../lib/fx-core.js";
import {
  buildApproxGuestPrice,
  forexNoteForLanguage,
  guestCurrencyForLanguage,
} from "../lib/fx-display.js";

const NOW = Date.parse("2026-08-06T12:00:00Z");

function snap(overrides: Partial<FxSnapshot> = {}): FxSnapshot {
  return {
    base: "SEK",
    quote: "EUR",
    rate: 0.0867,
    source: "ecb-frankfurter",
    fetchedAt: "2026-08-06T10:00:00Z",
    ...overrides,
  };
}

describe("vendored fx-core parity (smart-stays fixtures)", () => {
  it("display conversion matches the smart-stays anchors", () => {
    // Same fixtures as smart-stays src/test/fx-core.test.ts — do not diverge.
    assert.equal(convertForDisplay(4500, snap({ rate: 0.0867 })), 390);
    assert.equal(convertForDisplay(2950, snap({ quote: "USD", rate: 0.1054 })), 311);
  });

  it("settlement conversion matches: margin on top of ECB, 2-decimal rounding", () => {
    const result = convertForSettlement(4500, snap({ rate: 0.0867 }), 2, NOW);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.amount, 397.95);
  });

  it("fail-closed parity: static fallback and stale rates refuse settlement", () => {
    assert.equal(
      assessSettlementGrade(snap({ source: "static-fallback" }), NOW).ok,
      false,
    );
    const stale = snap({
      fetchedAt: new Date(NOW - SETTLEMENT_MAX_AGE_MS - 60_000).toISOString(),
    });
    assert.equal(assessSettlementGrade(stale, NOW).ok, false);
  });

  it("node-currency base parity: every picker currency is a valid base", () => {
    for (const c of ["SEK", "NOK", "DKK", "EUR", "GBP", "USD", "CHF", "PLN", "CZK", "CAD", "AUD", "NZD"]) {
      assert.equal(isSupportedNodeCurrency(c), true, c);
    }
    assert.equal(
      buildFrankfurterUrl("EUR", ["SEK", "USD", "EUR"]),
      "https://api.frankfurter.app/latest?from=EUR&to=SEK,USD",
    );
  });
});

describe("stay-offer display translation (≈ doctrine)", () => {
  it("language → display currency mirrors the node's own pages", () => {
    assert.equal(guestCurrencyForLanguage("sv"), "SEK");
    assert.equal(guestCurrencyForLanguage("en"), "USD");
    assert.equal(guestCurrencyForLanguage("de"), "EUR");
    assert.equal(guestCurrencyForLanguage("da"), "DKK");
    assert.equal(guestCurrencyForLanguage("pl"), "PLN");
    // Unknown languages fall back to EUR, same as smart-stays region.ts.
    assert.equal(guestCurrencyForLanguage("xx"), "EUR");
  });

  it("the block is marked approximate with the original beside it — never exact", () => {
    const block = buildApproxGuestPrice(2950, "SEK", "en", snap({ quote: "USD", rate: 0.1054 }));
    assert.ok(block);
    assert.equal(block?.approximate, true);
    assert.equal(block?.total, 311);
    assert.equal(block?.currency, "USD");
    assert.deepEqual(block?.original, { currency: "SEK", total: 2950 });
    assert.equal(block?.rate_source, "ecb-frankfurter");
    assert.match(String(block?.note), /ECB/);
  });

  it("no block for identity pairs or mismatched snapshots", () => {
    assert.equal(
      buildApproxGuestPrice(2950, "SEK", "sv", snap({ quote: "SEK", rate: 1 })),
      null,
    );
    assert.equal(
      buildApproxGuestPrice(2950, "EUR", "en", snap({ base: "SEK", quote: "USD", rate: 0.1054 })),
      null,
    );
  });

  it("the ≈ note is localized for every supported guest language", () => {
    for (const lang of ["sv", "en", "de", "fr", "es", "nl", "da", "no", "fi", "it", "pl", "ar"]) {
      const strings = forexNoteForLanguage(lang);
      assert.ok(strings.note.length > 0, lang);
      assert.ok(strings.tooltip.length > 0, lang);
    }
    assert.equal(forexNoteForLanguage("xx").note, forexNoteForLanguage("en").note);
  });
});
