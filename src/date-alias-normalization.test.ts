import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDateAliases } from "../lib/tools.js";

// Canonical date params are camelCase across every tool. normalizeDateAliases
// maps the legacy snake_case names to camelCase before validation/dispatch so
// the live endpoint accepts both forms during the migration, without relaxing
// #85's "reject unknown keys" guarantee for any other key.
describe("normalizeDateAliases (snake_case date param migration)", () => {
  it("maps check_in/check_out to camelCase and drops the legacy keys", () => {
    const out = normalizeDateAliases({ domain: "x.se", check_in: "2026-07-01", check_out: "2026-07-08", guests: 4 });
    assert.equal(out.checkIn, "2026-07-01");
    assert.equal(out.checkOut, "2026-07-08");
    assert.equal("check_in" in out, false);
    assert.equal("check_out" in out, false);
    assert.equal(out.guests, 4);
  });

  it("maps reschedule new_check_in/new_check_out aliases", () => {
    const out = normalizeDateAliases({ reservationId: "r1", new_check_in: "2026-08-01", new_check_out: "2026-08-08" });
    assert.equal(out.newCheckIn, "2026-08-01");
    assert.equal(out.newCheckOut, "2026-08-08");
    assert.equal("new_check_in" in out, false);
    assert.equal("new_check_out" in out, false);
  });

  it("returns the same object untouched for canonical camelCase input", () => {
    const input = { checkIn: "2026-07-01", checkOut: "2026-07-08" };
    const out = normalizeDateAliases(input);
    assert.equal(out, input); // same reference: no alias work needed
  });

  it("keeps the camelCase value when both forms are present, dropping the legacy key", () => {
    const out = normalizeDateAliases({ checkIn: "camel", check_in: "snake" });
    assert.equal(out.checkIn, "camel");
    assert.equal("check_in" in out, false);
  });

  it("does not touch unrelated or typo'd keys (still rejected downstream by #85)", () => {
    const out = normalizeDateAliases({ chekc_in: "typo", region: "Skåne" });
    assert.equal(out.chekc_in, "typo");
    assert.equal(out.region, "Skåne");
    assert.equal("checkIn" in out, false);
  });
});
