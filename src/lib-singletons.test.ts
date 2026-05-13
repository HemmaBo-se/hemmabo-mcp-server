/**
 * Drift-skydd: säkerställer att `lib/pricing.ts` och `lib/availability.ts`
 * är de enda källfilerna som äger pricing- respektive availability-logiken.
 *
 * Bakgrund (#60 / #61):
 *   src/pricing.ts var en stale kopia av lib/pricing.ts med `export` strippade
 *   från 3 hjälpfunktioner. src/availability.ts var en divergent fork som
 *   tyst svalde Supabase-fel istället för att fail-closea (potentiell
 *   double-booking-bug om någon hade refererat den). Ingen produktionskod
 *   importerade någondera. Båda raderades.
 *
 *   Detta test misslyckas om en framtida PR återinför filerna eller skapar
 *   nya parallella implementationer.
 *
 * Run: npx tsx --test src/lib-singletons.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("lib/* singletons (#60, #61)", () => {
  it("(a) src/pricing.ts must not exist — lib/pricing.ts is the SoT", () => {
    assert.equal(
      existsSync(resolve(REPO_ROOT, "src/pricing.ts")),
      false,
      "src/pricing.ts is a stale fork that lost the `export` keyword on 3 helpers (#60). lib/pricing.ts is the single source of truth — import from there."
    );
  });

  it("(b) src/availability.ts must not exist — lib/availability.ts is the SoT", () => {
    assert.equal(
      existsSync(resolve(REPO_ROOT, "src/availability.ts")),
      false,
      "src/availability.ts was a divergent fork that silently swallowed Supabase errors (potential double-booking risk, #61). lib/availability.ts fail-closes on DB error — import from there."
    );
  });

  it("(c) lib/pricing.ts exists and exports resolveQuote", async () => {
    assert.equal(existsSync(resolve(REPO_ROOT, "lib/pricing.ts")), true);
    const mod = await import("../lib/pricing.js");
    assert.equal(typeof mod.resolveQuote, "function", "lib/pricing.ts must export resolveQuote");
  });

  it("(d) lib/availability.ts exists and exports checkAvailability", async () => {
    assert.equal(existsSync(resolve(REPO_ROOT, "lib/availability.ts")), true);
    const mod = await import("../lib/availability.js");
    assert.equal(typeof mod.checkAvailability, "function", "lib/availability.ts must export checkAvailability");
  });
});
