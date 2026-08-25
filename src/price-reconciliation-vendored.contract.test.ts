/**
 * Vendored price-reconciliation contract.
 *
 * lib/price-reconciliation.ts is a byte-identical vendored mirror of
 * smart-stays `contracts/ts/price-reconciliation.ts` (same law as
 * lib/pricing-core.ts / lib/availability-core.ts). This contract enforces:
 *   1. The quote resolver (lib/pricing.ts) DELEGATES the direct-price fold to
 *      the core and no longer carries its own copy — the local copy silently
 *      dumped a package/stay STRUCTURAL residual into the last night (the
 *      core refuses; only a true ±1-per-night rounding residual moves).
 *   2. The quote self-reconciles with the same neutral rate lines as the
 *      node's /api/pricing and the signed verified-stay-offer
 *      (smart-stays ADR 2026-08-25, uniformity law).
 *
 * Run: npx tsx --test src/price-reconciliation-vendored.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyHostDirectPrice,
  buildReconciledPrice,
} from "../lib/price-reconciliation.js";

describe("vendored core — cross-repo parity anchors", () => {
  it("structural (package/stay) residual is NEVER dumped into the last night", () => {
    // Rack nights Σ=21750 but the substituted total is 14790 (stay rule) with
    // a 0% fold — the core is a no-op at pct<=0; with a 10% fold the residual
    // far exceeds the ±1/night rounding bound and must NOT move a night.
    const rows = [2950, 2950, 2950, 2950, 3500, 3500, 2950].map((nightly_rate) => ({ nightly_rate }));
    const { total, breakdown } = applyHostDirectPrice(rows, 14790, 10);
    assert.equal(total, Math.round(14790 * 0.9));
    assert.ok(breakdown);
    for (const n of breakdown!) {
      assert.ok(Number(n.nightly_rate) > 0, "no night may go non-positive from residual dumping");
    }
    const sum = breakdown!.reduce((s, n) => s + Number(n.nightly_rate), 0);
    assert.notEqual(sum, total, "structural gap stays visible for the adjustment line");
  });

  it("stay-discount quote reconciles with ONE neutral stay_rate line (villa 7-night case)", () => {
    const r = buildReconciledPrice({
      priced: true,
      breakdown: [2950, 2950, 2950, 2950, 3500, 3500, 2950].map((nightly_rate) => ({ nightly_rate })),
      publicTotal: 14790,
      agentTotal: 14790,
      packageApplied: null,
      stayDiscountApplied: { pct: 32, kind: "stay_length", thresholdUnits: 7 },
      language: "en",
    });
    assert.deepEqual(r.adjustments, [
      { code: "stay_rate", label: "Stay rate", amount: -6960, scope: "stay" },
    ]);
    assert.equal(r.exact, true);
    assert.equal(r.total, 14790);
  });

  it("gap-adjusted quote emits the neutral gap_night_rate line and reconciles", () => {
    const r = buildReconciledPrice({
      priced: true,
      breakdown: [2950, 2950].map((nightly_rate) => ({ nightly_rate })),
      publicTotal: 5900,
      agentTotal: 5900,
      language: "en",
      gapAdjustedTotal: 5310,
    });
    assert.deepEqual(r.adjustments, [
      { code: "gap_night_rate", label: "Gap night rate", amount: -590, scope: "stay" },
    ]);
    assert.equal(r.total, 5310);
    assert.equal(r.exact, true);
  });
});

describe("wrapper source invariants — lib/pricing.ts consumes the core, redeclares nothing", () => {
  const src = readFileSync(join(process.cwd(), "lib/pricing.ts"), "utf8");

  it("imports the vendored core", () => {
    assert.match(src, /from "\.\/price-reconciliation\.js"/);
  });

  it("delegates the fold — no local residual loop remains", () => {
    assert.match(src, /applyHostDirectPriceCore\(/);
    assert.doesNotMatch(src, /nightlyRates\[nightlyRates\.length - 1\]\.rate \+= residual/);
  });

  it("the quote result carries adjustments + reconciliation", () => {
    assert.match(src, /adjustments: reconciled\.adjustments/);
    assert.match(src, /reconciliation: reconciled\.reconciliation/);
    assert.match(src, /stayDiscountApplied: rack\.stay_discount_applied/);
  });

  it("vendored core header identifies it as the shared reconciliation core", () => {
    const core = readFileSync(join(process.cwd(), "lib/price-reconciliation.ts"), "utf8");
    assert.match(core, /Price reconciliation — shared core/);
  });
});
