/**
 * Vendored pricing-core contract (PR-1b).
 *
 * lib/pricing-core.ts is a byte-identical vendored mirror of smart-stays
 * `contracts/ts/pricing-core.ts` (repo-lockstep per ADR 0004; smart-stays ADR
 * 2026-07-29-pricing-shared-core.md). This contract enforces:
 *   1. The wrapper (lib/pricing.ts) consumes the core and redeclares nothing.
 *   2. The core's canonical rules answer identically to the smart-stays
 *      contract fixtures (same inputs ⇒ same rack totals, every repo).
 *
 * Run: npx tsx --test src/pricing-core-vendored.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeRackQuote,
  decideGapNight,
  applyGapDiscount,
  findPriceBlock,
  isWeekendDay,
} from "../lib/pricing-core.js";

// Same fixtures as smart-stays tests/contracts/pricing-shared-core.contract.test.ts —
// the cross-repo parity anchor. Do not diverge them.
const SEASONS = [
  { name: "Låg vår", date_from: "2026-03-01", date_to: "2026-04-30", type: "low" as const },
  { name: "Hög sommar", date_from: "2026-06-01", date_to: "2026-08-31", type: "high" as const },
];

const BLOCKS = [
  {
    guests: 2,
    low_weekday: 1000, low_weekend: 1500, high_weekday: 2000, high_weekend: 2500,
    low_week: 6000, high_week: 12000, low_two_weeks: 11000, high_two_weeks: 22000,
  },
  {
    guests: 4,
    low_weekday: 1300, low_weekend: 1800, high_weekday: 2300, high_weekend: 2800,
    low_week: null, high_week: null, low_two_weeks: null, high_two_weeks: null,
  },
];

describe("vendored core — cross-repo parity anchors", () => {
  it("staircase: 3 guests → 4-tier, same total as the smart-stays contract (3×1300)", () => {
    assert.equal(findPriceBlock(3, BLOCKS)?.guests, 4);
    const q = computeRackQuote(SEASONS, BLOCKS, 3, "2026-03-02", "2026-03-05");
    assert.equal(q.success, true);
    if (q.success) assert.equal(q.rackTotal, 3 * 1300);
  });

  it("weekend = Fri+Sat nights; Sunday never (4000 for Fri→Mon, 2 guests)", () => {
    assert.equal(isWeekendDay("2026-03-08"), false); // Sunday
    const q = computeRackQuote(SEASONS, BLOCKS, 2, "2026-03-06", "2026-03-09");
    if (q.success) assert.equal(q.rackTotal, 1500 + 1500 + 1000);
  });

  it("week package at exactly 7 same-season nights (6000)", () => {
    const q = computeRackQuote(SEASONS, BLOCKS, 2, "2026-03-02", "2026-03-09");
    assert.equal(q.success && q.rackTotal, 6000);
    assert.equal(q.success && q.package_applied, "week");
  });

  it("season-gap-fill: uncovered date quotes via nearest season when enabled (MCP parity fix)", () => {
    const on = computeRackQuote(SEASONS, BLOCKS, 2, "2026-05-11", "2026-05-13", true);
    assert.equal(on.success, true);
    if (on.success) assert.match(on.breakdown[0].season_name, /\(gap-fill\)/);
    const off = computeRackQuote(SEASONS, BLOCKS, 2, "2026-05-11", "2026-05-13", false);
    assert.equal(off.success, false);
  });

  it("gap-night decision + discount on the folded total (canonical order)", () => {
    const decision = decideGapNight({
      enabled: true, gapFillMinNights: 2, nights: 1,
      hasNeighborBefore: true, hasNeighborAfter: true, discountPct: 15,
    });
    assert.deepEqual(decision, { isGap: true, discountPct: 15 });
    assert.equal(applyGapDiscount(1000, decision), 850);
    assert.equal(applyGapDiscount(1000, { isGap: false, discountPct: null }), null);
  });
});

describe("wrapper source invariants — lib/pricing.ts consumes the core, redeclares nothing", () => {
  const src = readFileSync(join(process.cwd(), "lib/pricing.ts"), "utf8");

  it("imports the vendored core", () => {
    assert.match(src, /from "\.\/pricing-core\.js"/);
  });

  it("no local block-matching, season lookup, or package math remains", () => {
    assert.doesNotMatch(src, /function findPriceBlock\b/);
    assert.doesNotMatch(src, /function getSeasonForDate\b/);
    assert.doesNotMatch(src, /function nightlyRate\b/);
    assert.doesNotMatch(src, /low_two_weeks\s*:/); // package math lives in the core
  });

  it("gap decision goes through the core (no inline gap threshold math)", () => {
    assert.match(src, /decideGapNight\(/);
    assert.match(src, /applyGapDiscount\(/);
    assert.doesNotMatch(src, /nights > gapFillMinNights \+ 1/);
  });

  it("vendored core header identifies it as the shared core", () => {
    const core = readFileSync(join(process.cwd(), "lib/pricing-core.ts"), "utf8");
    assert.match(core, /Pricing — shared core/);
    assert.match(core, /2026-07-29-pricing-shared-core/);
  });
});
