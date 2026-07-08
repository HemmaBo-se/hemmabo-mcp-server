/**
 * Agent-visible amenity vocabulary — regression suite for the Claude-web
 * incident 2026-07-08 (smart-stays BUG_LEDGER P1-8).
 *
 * What guests saw: the stay-offer widget listed only underscore-free
 * amenities ("wifi · fireplace · garden · workspace" — hot tub GONE), the
 * agent quoted raw machine keys in prose ("spabad (has_hot_tub)",
 * "(crib_available)") and narrated an internal "lossy" layer discrepancy.
 *
 * Three product defects, pinned here:
 *  1. amenitiesFromDiscovery / the widget dropped every token containing
 *     "_" — correct when the node file led with readable labels, silently
 *     wrong after smart-stays #2073 made the node file tokens-only.
 *  2. buildPropertySignals emitted internal DB column names
 *     (has_hot_tub, wifi_included) instead of the canonical claim tokens
 *     (hot_tub, wifi) its own guidance promises.
 *  3. policies emitted smoking_allowed AND outdoor_smoking_only together,
 *     which agents read (and relayed) as a contradiction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPropertySignals, formatAmenityLabel } from "../lib/tools-base.js";
import { amenitiesFromDiscovery } from "../lib/vrp.js";

describe("formatAmenityLabel — no raw snake_case token reaches a guest surface", () => {
  it("formats canonical tokens as human labels", () => {
    assert.equal(formatAmenityLabel("hot_tub"), "Hot tub");
    assert.equal(formatAmenityLabel("crib_available"), "Crib available");
    assert.equal(formatAmenityLabel("fireplace"), "Fireplace");
  });

  it("keeps the initialism special-cases", () => {
    assert.equal(formatAmenityLabel("wifi"), "WiFi");
    assert.equal(formatAmenityLabel("ev_charging"), "EV charging");
    assert.equal(formatAmenityLabel("bbq"), "BBQ");
    assert.equal(formatAmenityLabel("tv"), "TV");
  });

  it("never emits an underscore", () => {
    for (const token of ["hot_tub", "self_checkin", "coffee_tea_included", "x_y_z"]) {
      assert.ok(!formatAmenityLabel(token).includes("_"), token);
    }
  });

  it("is safe on junk input", () => {
    assert.equal(formatAmenityLabel(""), "");
    assert.equal(formatAmenityLabel("   "), "");
  });
});

describe("amenitiesFromDiscovery — the widget/offer amenity list", () => {
  it("REGRESSION: hot_tub survives a tokens-only node file (the incident)", () => {
    // Post smart-stays #2073 the node discovery file emits canonical tokens
    // only. The old `includes("_") → skip` filter dropped hot_tub here.
    const labels = amenitiesFromDiscovery({
      amenities: ["wifi", "hot_tub", "fireplace", "garden", "workspace"],
    });
    assert.deepEqual(labels, ["WiFi", "Hot tub", "Fireplace", "Garden"]);
  });

  it("dedupes token/label collisions and caps at 4", () => {
    const labels = amenitiesFromDiscovery({
      amenities: ["hot_tub", "Hot tub", "sauna", "garden", "parking", "gym_access"],
    });
    assert.equal(labels.length, 4);
    assert.deepEqual(labels, ["Hot tub", "Sauna", "Garden", "Parking"]);
  });

  it("emits no raw machine keys", () => {
    const labels = amenitiesFromDiscovery({
      amenities: ["has_hot_tub", "crib_available", "ev_charging"],
    });
    for (const label of labels) assert.ok(!label.includes("_"), label);
  });
});

describe("buildPropertySignals — canonical tokens, not DB column names", () => {
  const noClaims = { affirmed: new Set<string>(), negated: new Set<string>(), known: new Set<string>() };

  it("REGRESSION: amenity signals emit claim tokens (hot_tub), never column names (has_hot_tub)", () => {
    const signals = buildPropertySignals(
      { wifi_included: true, has_hot_tub: true, crib_available: true, has_fireplace: true },
      noClaims,
    );
    assert.ok(signals);
    assert.deepEqual(signals.amenities.sort(), ["crib_available", "fireplace", "hot_tub", "wifi"]);
    assert.ok(!signals.amenities.includes("has_hot_tub"));
    assert.ok(!signals.amenities.includes("wifi_included"));
  });

  it("claims-ledger still wins over the stale boolean column (unchanged behaviour)", () => {
    const signals = buildPropertySignals(
      { has_hot_tub: false },
      { affirmed: new Set(["hot_tub"]), negated: new Set<string>(), known: new Set(["hot_tub"]) },
    );
    assert.ok(signals);
    assert.deepEqual(signals.amenities, ["hot_tub"]);
  });

  it("outdoor_smoking_only suppresses the contradictory smoking_allowed", () => {
    const signals = buildPropertySignals(
      { smoking_allowed: true, outdoor_smoking_only: true },
      noClaims,
    );
    assert.ok(signals);
    assert.deepEqual(signals.policies, ["outdoor_smoking_only"]);
  });

  it("smoking_allowed alone still emits (nothing to contradict)", () => {
    const signals = buildPropertySignals({ smoking_allowed: true }, noClaims);
    assert.ok(signals);
    assert.deepEqual(signals.policies, ["smoking_allowed"]);
  });
});

describe("buildPropertySignals — explicit host NOs (LS-1)", () => {
  it("REGRESSION: cat owner asks, host said no — pets_cats negated must reach the agent", () => {
    // The villa incident 2026-07-08: allows_pets=true + allows_dogs=true made
    // the agent tell a cat owner 'probably fine' while the ledger said no.
    const signals = buildPropertySignals(
      { allows_pets: true, allows_dogs: true },
      {
        affirmed: new Set(["pets_dogs"]),
        negated: new Set(["pets_cats"]),
        known: new Set(["pets_dogs", "pets_cats"]),
      },
    );
    assert.ok(signals);
    assert.deepEqual(signals.policies_negated, ["pets_cats"]);
    assert.deepEqual(signals.policies.sort(), ["allows_dogs", "allows_pets"]);
  });

  it("non-policy negations (piano) do NOT leak into policies_negated", () => {
    const signals = buildPropertySignals(
      { allows_pets: true },
      {
        affirmed: new Set<string>(),
        negated: new Set(["piano", "arcade", "smoking_indoor"]),
        known: new Set(["piano", "arcade", "smoking_indoor"]),
      },
    );
    assert.ok(signals);
    assert.deepEqual(signals.policies_negated, ["smoking_indoor"]);
  });

  it("no negated policy claims → no policies_negated key (compact signals)", () => {
    const signals = buildPropertySignals(
      { allows_pets: true },
      { affirmed: new Set<string>(), negated: new Set<string>(), known: new Set<string>() },
    );
    assert.ok(signals);
    assert.equal("policies_negated" in signals, false);
  });

  it("no claims at all (un-migrated node) → signals unchanged, no crash", () => {
    const signals = buildPropertySignals({ allows_pets: true }, undefined);
    assert.ok(signals);
    assert.equal("policies_negated" in signals, false);
  });
});

describe("guidance — agents are told to hide the machine layer", () => {
  const source = readFileSync(new URL("../lib/tools-base.ts", import.meta.url), "utf-8");

  it("forbids showing raw keys / internal identifiers to the user", () => {
    assert.match(source, /NEVER show the raw keys/);
  });

  it("forbids narrating internal data-layer differences to the guest", () => {
    assert.match(source, /Never describe internal data-layer differences/);
  });
});
