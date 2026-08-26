/**
 * A2 — directional search resolver contract (ADR 0017).
 *
 * Three locks:
 *   1. VENDORED-CORE PARITY — lib/geo-directional-core.ts answers identically
 *      to the smart-stays canon's fixtures (tests/contracts/
 *      geo-directional.contract.test.ts): villa → se_south, the Öresund
 *      country guard, global anchors, determinism, and the banned-words scan.
 *      Any drift here means the vendored mirror and the node canon disagree —
 *      fix in lockstep, both repos, same PR-pair.
 *   2. QUERY RESOLUTION — a guest's directional phrase resolves to exactly one
 *      band or to null. Never a guess: direction without a resolvable country
 *      is null; a country without that band is null.
 *   3. SEARCH INTEGRATION — propertyMatchesLocation gains directional matches
 *      ADDITIVELY: every pre-A2 alias/name match still matches, coordinates
 *      are never required for those, and no ranking of any kind appears.
 *
 * Run: npx tsx --test src/geo-directional-a2.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDirectional,
  normalizeCountryToIso,
  DIRECTIONAL_REGIONS,
} from "../lib/geo-directional-core.js";
import {
  foldTerm,
  resolveDirectionalTarget,
  propertyResolvesToRegion,
} from "../lib/geo-directional-query.js";
import { propertyMatchesLocation } from "../lib/tools-base.js";

// Live villa — exact coords + the free-text country string as stored in the DB
// (same fixture as the smart-stays canon test).
const VILLA = { country: "Sweden", lat: 55.7980888, lon: 13.1691188 };

describe("1. vendored core — parity anchors with the smart-stays canon", () => {
  it("resolves the live villa to Southern Sweden (se_south)", () => {
    const d = computeDirectional(VILLA.country, VILLA.lat, VILLA.lon);
    assert.ok(d);
    assert.equal(d.own_location_only, true);
    assert.equal(d.regions.length, 1);
    assert.equal(d.regions[0].id, "se_south");
    assert.equal(d.regions[0].label.en, "Southern Sweden");
    assert.equal(d.regions[0].label.sv, "Södra Sverige");
  });

  it("normalizes free-text country spellings to one ISO", () => {
    assert.equal(normalizeCountryToIso("Sweden"), "SE");
    assert.equal(normalizeCountryToIso("Sverige"), "SE");
    assert.equal(normalizeCountryToIso("  se "), "SE");
    assert.equal(normalizeCountryToIso("Spanien"), "ES");
    assert.equal(normalizeCountryToIso("Kongeriket"), null);
    assert.equal(normalizeCountryToIso(null), null);
  });

  it("disambiguates the Öresund strait via the country guard", () => {
    // Copenhagen is ~15 km from Kävlinge but sits in Denmark, which is not a
    // seeded country → NO false Southern-Sweden match.
    assert.equal(computeDirectional("Denmark", 55.6761, 12.5683), null);
    // A Swedish node across the strait still resolves Swedish-south (Malmö).
    assert.equal(computeDirectional("Sweden", 55.605, 13.0038)?.regions[0]?.id, "se_south");
  });

  it("bands are contiguous & exactly-one within a country (S / central / N)", () => {
    const id = (lat: number) => computeDirectional("SE", lat, 15)?.regions[0]?.id;
    assert.equal(id(55.8), "se_south"); // Skåne
    assert.equal(id(59.33), "se_central"); // Stockholm
    assert.equal(id(63.83), "se_north"); // Umeå
  });

  it("is global / country-agnostic — never Swedish-special", () => {
    assert.equal(computeDirectional("Italy", 40.85, 14.27)?.regions[0]?.label.en, "Southern Italy"); // Naples
    assert.equal(computeDirectional("France", 43.7, 7.27)?.regions[0]?.label.en, "Southern France"); // Nice
    assert.equal(computeDirectional("Norway", 69.65, 18.96)?.regions[0]?.label.en, "Northern Norway"); // Tromsø
    assert.equal(computeDirectional("Spain", 36.72, -4.42)?.regions[0]?.label.en, "Southern Spain"); // Málaga
  });

  it("is deterministic — same input yields byte-identical output", () => {
    const a = computeDirectional(VILLA.country, VILLA.lat, VILLA.lon);
    const b = computeDirectional(VILLA.country, VILLA.lat, VILLA.lon);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("omits cleanly when country or coordinates are unknown/invalid", () => {
    assert.equal(computeDirectional(null, 55.8, 13.1), null);
    assert.equal(computeDirectional("Sweden", NaN, NaN), null);
    assert.equal(computeDirectional("Sweden", undefined, undefined), null);
  });

  it("holds the red line: no ranking / score / commerce vocabulary in the data", () => {
    const blob = JSON.stringify(DIRECTIONAL_REGIONS).toLowerCase();
    for (const banned of ["score", "rank", "confidence", "cheaper", "savings", "best", "compare", "vs_", "closer_than"]) {
      assert.equal(blob.includes(banned), false, `directional data must not contain "${banned}"`);
    }
  });
});

describe("2. query resolution — one band or null, never a guess", () => {
  it("resolves English, Swedish, and native band labels", () => {
    assert.equal(resolveDirectionalTarget("southern Spain", undefined)?.id, "es_south");
    assert.equal(resolveDirectionalTarget("Sur de España", undefined)?.id, "es_south");
    assert.equal(resolveDirectionalTarget("Södra Sverige", undefined)?.id, "se_south");
    assert.equal(resolveDirectionalTarget("Italia meridionale", undefined)?.id, "it_south");
    assert.equal(resolveDirectionalTarget("Northern Norway", undefined)?.id, "no_north");
  });

  it("resolves direction + country as separate tokens, any language pairing", () => {
    assert.equal(resolveDirectionalTarget("södra Spanien", undefined)?.id, "es_south");
    assert.equal(resolveDirectionalTarget("norra Italien", undefined), null); // "Italien" not a canon alias yet — honest null, canon-first
    assert.equal(resolveDirectionalTarget("norra Italia", undefined)?.id, "it_north");
    assert.equal(resolveDirectionalTarget("southern Sverige", undefined)?.id, "se_south");
  });

  it("resolves Scandinavian/German compounds (Sydsverige, Süddeutschland)", () => {
    assert.equal(resolveDirectionalTarget("Sydsverige", undefined)?.id, "se_south");
    assert.equal(resolveDirectionalTarget("Süddeutschland", undefined)?.id, "de_south");
    assert.equal(resolveDirectionalTarget("Nordnorge", undefined)?.id, "no_north");
  });

  it("borrows the country parameter when the region phrase is direction-only", () => {
    assert.equal(resolveDirectionalTarget("södra", "Spanien")?.id, "es_south");
    assert.equal(resolveDirectionalTarget("southern", "Sweden")?.id, "se_south");
  });

  it("direction without a resolvable country is null — never guessed", () => {
    assert.equal(resolveDirectionalTarget("södra", undefined), null);
    assert.equal(resolveDirectionalTarget("southern", "Atlantis"), null);
  });

  it("a country without that band is null — honest no-match, no approximation", () => {
    // Spain has no central band in the canon.
    assert.equal(resolveDirectionalTarget("central Spain", undefined), null);
  });

  it("ordinary place names never false-trigger the compound splitter", () => {
    assert.equal(resolveDirectionalTarget("Surrey", "England"), null);
    assert.equal(resolveDirectionalTarget("Kävlinge", undefined), null);
    assert.equal(resolveDirectionalTarget("Skåne", undefined), null);
  });

  it("folding matches the search layer's rules (ö→o, å→a, ü→u, ß handling aside)", () => {
    assert.equal(foldTerm("Södra Sverige"), "sodra sverige");
    assert.equal(foldTerm("Süddeutschland"), "suddeutschland");
    assert.equal(foldTerm("Sør-Norge"), "sor norge");
  });
});

describe("3. search integration — additive, deterministic, no ranking", () => {
  const AKERLYCKAN = {
    region: "Skåne län",
    city: "Kävlinge",
    country: "Sweden",
    latitude: 55.7980888,
    longitude: 13.1691188,
  };
  const MALAGA_APARTMENT = {
    region: "Andalucía",
    city: "Málaga",
    country: "Spain",
    latitude: 36.7213,
    longitude: -4.4213,
  };

  it("directional phrases match the node whose OWN coordinates sit in the band", () => {
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, "southern Spain"), true);
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, "södra Spanien"), true);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, "Sydsverige"), true);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, "southern Sweden"), true);
  });

  it("the wrong direction never matches — match/no-match, not nearest-first", () => {
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, "northern Spain"), false);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, "Norra Sverige"), false);
  });

  it("contradictory region/country stays a no-match", () => {
    // "southern Spain" as region but Italy as country: the band matches the
    // node, the country filter still refuses — conservative, deterministic.
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, "southern Spain", "Italy"), false);
  });

  it("the country slot accepts a directional phrase and free-text ISO spellings", () => {
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, undefined, "södra Spanien"), true);
    assert.equal(propertyMatchesLocation(MALAGA_APARTMENT, undefined, "Spanien"), true);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, undefined, "Schweden"), true); // via the search layer's own alias table (schweden → sweden)
  });

  it("pre-A2 alias and name matching is untouched (regression)", () => {
    assert.equal(propertyMatchesLocation(AKERLYCKAN, "Skåne"), true);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, "Kävlinge"), true);
    assert.equal(propertyMatchesLocation(AKERLYCKAN, undefined, "Sverige"), true);
    // The legacy fixture shape (no coordinates) still works everywhere.
    const legacyShape = { region: "Skåne län", city: "Kävlinge", country: "Sweden" };
    assert.equal(propertyMatchesLocation(legacyShape, "southern sweden"), true); // via the hand-seeded alias
    assert.equal(propertyMatchesLocation(legacyShape, "Skåne"), true);
  });

  it("missing coordinates ⇒ no directional match, never a guess", () => {
    const noCoords = { region: "Andalucía", city: "Málaga", country: "Spain" };
    // Directional-only phrase cannot match without coordinates…
    assert.equal(propertyMatchesLocation(noCoords, "southern Spain"), false);
    // …but plain name/country matching is unaffected.
    assert.equal(propertyMatchesLocation(noCoords, "Málaga"), true);
    assert.equal(propertyMatchesLocation(noCoords, undefined, "Spain"), true);
  });

  it("propertyResolvesToRegion is the node's own truth, country-guarded", () => {
    assert.equal(propertyResolvesToRegion("Spain", 36.72, -4.42, "es_south"), true);
    assert.equal(propertyResolvesToRegion("Spain", 36.72, -4.42, "es_north"), false);
    assert.equal(propertyResolvesToRegion("Denmark", 55.6761, 12.5683, "se_south"), false); // Öresund guard
  });
});
