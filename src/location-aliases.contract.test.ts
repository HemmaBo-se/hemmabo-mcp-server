import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { propertyMatchesLocation, expandLocationTerms } from "../lib/tools-base.js";

// Villa Åkerlyckan — the live pilot node (Skåne län, Kävlinge, Sweden).
// International guests must reach it on their own language's place name, so a
// German "Schonen" / Danish "Sydsverige" search resolves to the same node as
// a Swedish "Skåne" search. (Path A: international guests on the host's domain.)
const AKERLYCKAN = { region: "Skåne län", city: "Kävlinge", country: "Sweden" };

describe("multilingual location aliases — international guest discovery", () => {
  it("matches Skåne across Swedish/English/German/Danish/French names", () => {
    for (const q of [
      "Skåne",
      "Scania", // English / Latin
      "Schonen", // German
      "Schönen", // German (folded ö→o)
      "Südschweden", // German
      "Sydsverige", // Danish / Norwegian
      "Scanie", // French
      "Southern Sweden",
    ]) {
      assert.equal(
        propertyMatchesLocation(AKERLYCKAN, q),
        true,
        `region query "${q}" must match Villa Åkerlyckan (Skåne)`,
      );
    }
  });

  it("matches Sweden by country name in major languages", () => {
    for (const q of ["Sweden", "Sverige", "Schweden", "Suède", "Zweden", "Svezia", "Suecia"]) {
      assert.equal(
        propertyMatchesLocation(AKERLYCKAN, undefined, q),
        true,
        `country query "${q}" must match Villa Åkerlyckan (Sweden)`,
      );
    }
  });

  it("does NOT match an unrelated region (no false positives)", () => {
    for (const q of ["Bavaria", "Bayern", "Provence", "Toscana"]) {
      assert.equal(
        propertyMatchesLocation(AKERLYCKAN, q),
        false,
        `region query "${q}" must NOT match a Skåne property`,
      );
    }
  });

  it("expands a foreign alias to the canonical region term", () => {
    assert.ok(
      expandLocationTerms("Schonen").includes("skane"),
      "Schonen must expand to include the canonical 'skane' term",
    );
  });
});
