// The offer-rules module on its own (lib/vrp-offer-rules.ts): the clock guard
// and parity with the vrp-spec offer-rules vectors at the function level. The
// handler-level coverage is src/vrp-offer-rules.contract.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOfferRules, parseDate, parseDateTime, OFFER_RULE_TEXT } from "../lib/vrp-offer-rules.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VECTORS = JSON.parse(readFileSync(join(REPO_ROOT, "spec", "offer-rules", "vectors.v0.1.json"), "utf8")) as {
  now: string;
  vectors: { name: string; offer: Record<string, unknown>; asked: { check_in: string; check_out: string; guests: number } | null; expected: { reasons: string[] } }[];
};
const payload = { generated_at: "2026-09-01T11:55:00Z", valid_until: "2026-09-01T12:05:00Z", request: { check_in: "2026-09-12", check_out: "2026-09-15", guests: 2 } };
const asked = { check_in: "2026-09-12", check_out: "2026-09-15", guests: 2 };

describe("checkOfferRules", () => {
  it("meets the rules at a usable clock", () => {
    assert.deepEqual(checkOfferRules(payload, { now: Date.parse("2026-09-01T12:00:00Z"), asked }), []);
  });

  for (const [name, now] of [["NaN", NaN], ["Infinity", Infinity], ["an Invalid Date's time", new Date("not a date").getTime()], ["a string", "2026-09-01T12:00:00Z" as unknown as number], ["undefined", undefined as unknown as number]] as const) {
    it(`fails closed with clock_unusable when now is ${name}`, () => {
      assert.deepEqual(checkOfferRules(payload, { now, asked }), ["clock_unusable"]);
    });
  }

  it("names every code's Core section", () => {
    for (const code of ["clock_unusable", "lifetime_too_long", "request_mismatch"] as const) {
      assert.match(OFFER_RULE_TEXT[code].section, /§/);
    }
  });

  it("matches every vrp-spec offer-rules vector, reasons and order", () => {
    for (const v of VECTORS.vectors) {
      assert.deepEqual(checkOfferRules(v.offer, { now: Date.parse(VECTORS.now), asked: v.asked }), v.expected.reasons, v.name);
    }
  });

  it("parses only dates and date-times that exist, in the schema's form", () => {
    assert.ok(Number.isFinite(parseDate("2028-02-29")));
    assert.ok(Number.isNaN(parseDate("2027-02-29")));
    assert.ok(Number.isNaN(parseDate("2027-2-9")));
    assert.ok(Number.isFinite(parseDateTime("2026-09-01T12:00:00.5Z")));
    assert.ok(Number.isNaN(parseDateTime("2026-09-01T12:00:00+00:00")));
    assert.ok(Number.isNaN(parseDateTime("2026-09-01T24:00:00Z")));
  });
});
