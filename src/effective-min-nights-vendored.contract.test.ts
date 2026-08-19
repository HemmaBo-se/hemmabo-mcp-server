/**
 * Vendored effective-min-nights contract (PR-A3).
 *
 * lib/effective-min-nights.ts is a byte-identical vendored mirror of smart-stays
 * `contracts/ts/effective-min-nights.ts` (same law as lib/availability-core.ts
 * and lib/pricing-core.ts; ADR 2026-08-19-effective-min-nights-live-everywhere,
 * CEO decision A). This contract enforces cross-repo BEHAVIOURAL parity: the
 * same inputs the smart-stays gate test uses must yield the same effective
 * minimum here — so `hemmabo_search_availability` and the quote path in this
 * repo refuse on exactly the floor the node's /api/availability, the guest-UI
 * and the Deno agent path enforce ("identiskt utfall": UI = node = MCP).
 *
 * Run: npx tsx --test src/effective-min-nights-vendored.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getEffectiveMinNights,
  findGapSize,
  type MinNightsModifiers,
  type BookingWindow,
} from "../lib/effective-min-nights.js";

const TODAY = "2026-08-19";

const OFF: MinNightsModifiers = {
  setup_completed: false,
  gap_fill_enabled: true,
  gap_fill_min_nights: 1,
  last_minute_enabled: true,
  last_minute_days_before: 7,
  last_minute_min_nights: 1,
};

const on = (o: Partial<MinNightsModifiers> = {}): MinNightsModifiers => ({
  setup_completed: true,
  gap_fill_enabled: false,
  gap_fill_min_nights: 1,
  last_minute_enabled: false,
  last_minute_days_before: 0,
  last_minute_min_nights: 1,
  ...o,
});

const GAP: BookingWindow[] = [
  { checkIn: "2026-08-20", checkOut: "2026-08-22" },
  { checkIn: "2026-08-24", checkOut: "2026-08-27" },
];

describe("vendored effective-min-nights — cross-repo parity anchors", () => {
  it("raw base when setup is not completed / no smart-pricing row", () => {
    assert.equal(getEffectiveMinNights(2, OFF, "2026-08-22", [], TODAY), 2);
    assert.equal(getEffectiveMinNights(2, null, "2026-08-22", [], TODAY), 2);
  });

  it("last-minute lowers inside the window, base beyond it", () => {
    const m = on({ last_minute_enabled: true, last_minute_days_before: 7, last_minute_min_nights: 1 });
    assert.equal(getEffectiveMinNights(2, m, "2026-08-22", [], TODAY), 1);
    assert.equal(getEffectiveMinNights(2, m, "2026-09-18", [], TODAY), 2);
  });

  it("last-minute never applies to a past arrival (fail-closed to base)", () => {
    const m = on({ last_minute_enabled: true, last_minute_days_before: 7, last_minute_min_nights: 1 });
    assert.equal(getEffectiveMinNights(2, m, "2026-08-10", [], TODAY), 2);
  });

  it("eftersmoke — gap-fill lowers to fit a gap <= base (UI = node = MCP)", () => {
    const m = on({ gap_fill_enabled: true, gap_fill_min_nights: 1 });
    // Arrival 08-22 sits in the [08-22, 08-24) gap (2 nights) ⇒ min(1, 2) = 1,
    // the identical value the Node truth and the guest-UI compute for this window.
    assert.equal(getEffectiveMinNights(2, m, "2026-08-22", GAP, "2026-08-01"), 1);
  });

  it("gap-fill inert when the gap exceeds the base", () => {
    const m = on({ gap_fill_enabled: true, gap_fill_min_nights: 1 });
    const bookings: BookingWindow[] = [
      { checkIn: "2026-08-20", checkOut: "2026-08-22" },
      { checkIn: "2026-08-29", checkOut: "2026-08-31" },
    ];
    assert.equal(getEffectiveMinNights(2, m, "2026-08-24", bookings, "2026-08-01"), 2);
  });

  it("gap-fill never lowers below the host's gap_fill_min_nights", () => {
    const m = on({ gap_fill_enabled: true, gap_fill_min_nights: 2 });
    const bookings: BookingWindow[] = [
      { checkIn: "2026-08-18", checkOut: "2026-08-20" },
      { checkIn: "2026-08-23", checkOut: "2026-08-25" },
    ];
    assert.equal(getEffectiveMinNights(3, m, "2026-08-20", bookings, "2026-08-01"), 2);
  });

  it("findGapSize is order-independent and UTC-anchored", () => {
    const bookings: BookingWindow[] = [
      { checkIn: "2026-08-24", checkOut: "2026-08-27" },
      { checkIn: "2026-08-20", checkOut: "2026-08-22" },
    ];
    assert.equal(findGapSize("2026-08-22", bookings), 2);
    assert.equal(findGapSize("2026-08-28", bookings), null);
  });
});
