/**
 * Contract tests for agent-friendly search.
 *
 * Agents must not hit a wall because a destination lacks diacritics
 * ("Skane" vs "Skåne") or because requested dates are booked while nearby
 * same-month alternatives exist — including gaps SHORTER than the requested
 * stay, which the old fixed-length window scan could never surface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandLocationTerms,
  normalizeLocationTerm,
  propertyMatchesLocation,
} from "../lib/tools.js";
import { findFreeWindowsInMonth } from "../lib/availability.js";

// Minimal Supabase stub: property_blocked_dates returns the supplied rows,
// bookings + booking_locks return empty. All queries are awaited via `then`.
function calendarStub(blockedRows: Array<{ start_date: string; end_date: string }>) {
  return {
    from(table: string) {
      const rows = table === "property_blocked_dates" ? blockedRows : [];
      const query: Record<string, unknown> = {};
      const chain = () => query as never;
      Object.assign(query, {
        select: chain,
        eq: chain,
        lt: chain,
        gt: chain,
        gte: chain,
        or: chain,
        neq: chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      });
      return query;
    },
  } as never;
}

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";

describe("location normalization", () => {
  it("normalizes accents and Swedish country aliases", () => {
    assert.equal(normalizeLocationTerm("Skåne län"), "skane lan");
    assert.equal(normalizeLocationTerm("Kävlinge"), "kavlinge");
    assert.equal(normalizeLocationTerm("SkÃ¥ne"), "skane");
    assert.deepEqual(expandLocationTerms("SE").sort(), ["se", "sverige", "sweden"].sort());
  });

  it("matches Villa Åkerlyckan for agent-style destination terms", () => {
    const villa = {
      region: "Skåne län",
      city: "Kävlinge",
      country: "Sweden",
    };

    assert.equal(propertyMatchesLocation(villa, "Skane"), true);
    assert.equal(propertyMatchesLocation(villa, "Skåne"), true);
    assert.equal(propertyMatchesLocation(villa, "SkÃ¥ne"), true);
    assert.equal(propertyMatchesLocation(villa, "Kavlinge"), true);
    assert.equal(propertyMatchesLocation(villa, "southern Sweden"), true);
    assert.equal(propertyMatchesLocation(villa, undefined, "Sverige"), true);
    assert.equal(propertyMatchesLocation(villa, undefined, "SE"), true);
  });
});

describe("findFreeWindowsInMonth — shorter free gaps surface", () => {
  it("regression: Villa Åkerlyckan Aug 2026 — 4-night request returns the 2-night 14–16 Aug gap", async () => {
    // Exactly the reported bug. August is booked solid except nights 14 & 15
    // (iCal blocks Jul 16→Aug 14 and Aug 16→Sep 1). A request for
    // 2026-08-10→2026-08-14 (4 nights) previously returned []; it must now
    // return the maximal 2-night gap, flagged shorter-than-requested.
    const supabase = calendarStub([
      { start_date: "2026-07-16", end_date: "2026-08-14" },
      { start_date: "2026-08-16", end_date: "2026-09-01" },
    ]);

    const windows = await findFreeWindowsInMonth(supabase, PROP, "2026-08-10", "2026-08-14");

    assert.deepEqual(windows, [
      {
        checkIn: "2026-08-14",
        checkOut: "2026-08-16",
        nights: 2,
        shorterThanRequested: true,
      },
    ]);
  });

  it("sorts nearest-to-requested-length first, then flags shorter gaps", async () => {
    // June: a 3-night gap (5–8) and a 1-night gap (20–21). A 3-night
    // request must rank the exact-length gap first; the single night is kept
    // (floor 1) and flagged shorter-than-requested.
    const supabase = calendarStub([
      { start_date: "2026-06-01", end_date: "2026-06-05" }, // nights 1–4
      { start_date: "2026-06-08", end_date: "2026-06-20" }, // nights 8–19
      { start_date: "2026-06-21", end_date: "2026-07-15" }, // nights 21→Jul 14
    ]);

    const windows = await findFreeWindowsInMonth(supabase, PROP, "2026-06-10", "2026-06-13");

    assert.deepEqual(windows, [
      { checkIn: "2026-06-05", checkOut: "2026-06-08", nights: 3, shorterThanRequested: false },
      { checkIn: "2026-06-20", checkOut: "2026-06-21", nights: 1, shorterThanRequested: true },
    ]);
  });

  it("eases the same-month clamp: a gap starting in-month may cross the month boundary", async () => {
    // Free run 28 Jun → 3 Jul. Its start is in June, so it is kept even
    // though checkout lands in July (the old scan dropped boundary-crossing
    // windows entirely).
    const supabase = calendarStub([
      { start_date: "2026-06-01", end_date: "2026-06-28" }, // nights 1–27
      { start_date: "2026-07-03", end_date: "2026-07-15" }, // nights Jul 3→Jul 14
    ]);

    const windows = await findFreeWindowsInMonth(supabase, PROP, "2026-06-10", "2026-06-15");

    assert.deepEqual(windows, [
      { checkIn: "2026-06-28", checkOut: "2026-07-03", nights: 5, shorterThanRequested: false },
    ]);
  });

  it("returns no windows when the whole scan range is blocked", async () => {
    const supabase = calendarStub([
      { start_date: "2026-06-01", end_date: "2026-07-15" },
    ]);

    const windows = await findFreeWindowsInMonth(supabase, PROP, "2026-06-10", "2026-06-14");

    assert.deepEqual(windows, []);
  });
});
