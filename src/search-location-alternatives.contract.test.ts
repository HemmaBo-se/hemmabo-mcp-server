/**
 * Contract tests for agent-friendly search.
 *
 * Agents must not hit a wall because a destination lacks diacritics
 * ("Skane" vs "Skåne") or because requested dates are booked while nearby
 * same-month alternatives exist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSameMonthDateWindows,
  expandLocationTerms,
  normalizeLocationTerm,
  propertyMatchesLocation,
} from "../lib/tools.js";

describe("location normalization", () => {
  it("normalizes accents and Swedish country aliases", () => {
    assert.equal(normalizeLocationTerm("Sk\u00e5ne l\u00e4n"), "skane lan");
    assert.equal(normalizeLocationTerm("K\u00e4vlinge"), "kavlinge");
    assert.equal(normalizeLocationTerm("Sk\u00c3\u00a5ne"), "skane");
    assert.deepEqual(expandLocationTerms("SE").sort(), ["se", "sverige", "sweden"].sort());
  });

  it("matches Villa \u00c5kerlyckan for agent-style destination terms", () => {
    const villa = {
      region: "Sk\u00e5ne l\u00e4n",
      city: "K\u00e4vlinge",
      country: "Sweden",
    };

    assert.equal(propertyMatchesLocation(villa, "Skane"), true);
    assert.equal(propertyMatchesLocation(villa, "Sk\u00e5ne"), true);
    assert.equal(propertyMatchesLocation(villa, "Sk\u00c3\u00a5ne"), true);
    assert.equal(propertyMatchesLocation(villa, "Kavlinge"), true);
    assert.equal(propertyMatchesLocation(villa, "southern Sweden"), true);
    assert.equal(propertyMatchesLocation(villa, undefined, "Sverige"), true);
    assert.equal(propertyMatchesLocation(villa, undefined, "SE"), true);
  });
});

describe("same-month alternative date windows", () => {
  it("offers nearby alternatives in the same month with the same trip length", () => {
    const windows = buildSameMonthDateWindows("2026-07-12", "2026-07-19", 4);
    assert.deepEqual(windows, [
      { checkIn: "2026-07-13", checkOut: "2026-07-20" },
      { checkIn: "2026-07-11", checkOut: "2026-07-18" },
      { checkIn: "2026-07-14", checkOut: "2026-07-21" },
      { checkIn: "2026-07-10", checkOut: "2026-07-17" },
    ]);
  });
});
