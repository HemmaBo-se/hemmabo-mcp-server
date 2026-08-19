/**
 * Vendored availability-core contract (PR 1b).
 *
 * lib/availability-core.ts is a byte-identical vendored mirror of smart-stays
 * `contracts/ts/availability-core.ts` (same law as lib/pricing-core.ts; ADR
 * 2026-05-01-availability-truth-shared-core). This contract enforces:
 *   1. The wrapper (lib/availability.ts) consumes the core and redeclares
 *      none of its pure helpers.
 *   2. The core's buffering rules answer identically to the smart-stays
 *      fixtures (same inputs ⇒ same effective spans, every repo).
 *
 * Run: npx tsx --test src/availability-core-vendored.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addUtcDays,
  blockedEndExclusive,
  effectiveBlockedRangeForAvailability,
  overlapsHalfOpen,
} from "../lib/availability-core.js";

describe("vendored core — cross-repo parity anchors", () => {
  it("channex rows ARE buffer-expanded (the 2026-08-12 CEO decision)", () => {
    const r = effectiveBlockedRangeForAvailability("2031-09-08", "2031-09-10", "channex", 1, 1);
    assert.deepEqual(r, { startDate: "2031-09-07", endDate: "2031-09-11", buffered: true });
  });

  it("manual and legacy ical_import rows stay EXACT (ADR 2026-06-24 mirror-exact)", () => {
    for (const source of ["manual", "ical_import", null, undefined]) {
      const r = effectiveBlockedRangeForAvailability("2031-09-08", "2031-09-10", source, 1, 1);
      assert.deepEqual(r, { startDate: "2031-09-08", endDate: "2031-09-10", buffered: false });
    }
  });

  it("legacy one-day rows (end <= start) normalize to one exclusive night before buffering", () => {
    assert.equal(blockedEndExclusive("2031-09-08", "2031-09-08"), "2031-09-09");
    const r = effectiveBlockedRangeForAvailability("2031-09-08", "2031-09-08", "channex", 0, 1);
    assert.deepEqual(r, { startDate: "2031-09-08", endDate: "2031-09-10", buffered: true });
  });

  it("half-open overlap: adjacent stays never conflict", () => {
    assert.equal(overlapsHalfOpen("2031-09-05", "2031-09-08", "2031-09-08", "2031-09-10"), false);
    assert.equal(overlapsHalfOpen("2031-09-05", "2031-09-08", "2031-09-07", "2031-09-10"), true);
  });

  it("addUtcDays is DST-stable across a year boundary", () => {
    assert.equal(addUtcDays("2031-12-31", 1), "2032-01-01");
    assert.equal(addUtcDays("2031-01-01", -1), "2030-12-31");
  });
});

describe("wrapper source invariants — lib/availability.ts consumes the core, redeclares nothing", () => {
  const src = readFileSync(join(process.cwd(), "lib/availability.ts"), "utf8");

  it("imports the vendored core", () => {
    assert.match(src, /from "\.\/availability-core\.js"/);
  });

  it("no local date/overlap/normalization helpers remain", () => {
    assert.doesNotMatch(src, /function addUtcDays\b/);
    assert.doesNotMatch(src, /function overlapsHalfOpen\b/);
    assert.doesNotMatch(src, /function blockedEndExclusive\b/);
  });

  it("blocked-date buffering goes through the core (no inline channex special-case)", () => {
    assert.match(src, /effectiveBlockedRangeForAvailability\(/);
    assert.doesNotMatch(src, /=== "channex"/);
  });

  it("vendored core header identifies it as the shared availability core", () => {
    const core = readFileSync(join(process.cwd(), "lib/availability-core.ts"), "utf8");
    assert.match(core, /Availability Truth — shared core/);
    assert.match(core, /2026-05-01-availability-truth-shared-core/);
  });
});
