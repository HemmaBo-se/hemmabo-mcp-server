/**
 * Contract test for #69 — price→cents conversion.
 *
 * Locks the payments contract from ADR 0002 §2.2 clause 1:
 *   Any conversion from a decimal price to Stripe minor units uses
 *   Math.round(price * 100).
 *
 * Run: npx tsx --test src/stripe-cents.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toStripeMinorUnits } from "./stripe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

describe("toStripeMinorUnits (#69)", () => {
  it("19.99 → 1999 (the canonical float-precision trap)", () => {
    // Reference: 19.99 * 100 === 1998.9999999999998 in JS.
    assert.equal(toStripeMinorUnits(19.99), 1999);
  });

  it("1495.50 → 149550 (typical SEK property price)", () => {
    assert.equal(toStripeMinorUnits(1495.5), 149550);
  });

  it("0.10 → 10", () => {
    assert.equal(toStripeMinorUnits(0.1), 10);
  });

  it("0 → 0", () => {
    assert.equal(toStripeMinorUnits(0), 0);
  });

  it("rounds half-up (0.005 → 1)", () => {
    assert.equal(toStripeMinorUnits(0.005), 1);
  });

  it("integer input is preserved (100 → 10000)", () => {
    assert.equal(toStripeMinorUnits(100), 10000);
  });

  it("throws on negative price", () => {
    assert.throws(() => toStripeMinorUnits(-1), /Invalid price/);
  });

  it("throws on NaN", () => {
    assert.throws(() => toStripeMinorUnits(NaN), /Invalid price/);
  });

  it("throws on Infinity", () => {
    assert.throws(() => toStripeMinorUnits(Infinity), /Invalid price/);
  });

  it("never returns a non-integer", () => {
    for (const p of [1.234, 5.678, 99.999, 12345.6789, 0.001, 0.009]) {
      const cents = toStripeMinorUnits(p);
      assert.equal(Number.isInteger(cents), true, `toStripeMinorUnits(${p}) returned non-integer ${cents}`);
    }
  });
});

describe("Money math drift guard (#69)", () => {
  // The five sites listed in issue #69 must no longer contain `price * 100`
  // or `amount * 100` near a Stripe call. Search the relevant files and
  // assert all multiplications by 100 are inside toStripeMinorUnits().

  const moneyFiles = [
    join(repoRoot, "api/acp.ts"),
    join(repoRoot, "src/stripe.ts"),
  ];

  for (const path of moneyFiles) {
    it(`${path.replace(repoRoot + "/", "")} has no naked '* 100' on money values`, () => {
      const source = readFileSync(path, "utf8");
      // Match identifiers ending in price|amount|total followed by * 100.
      // Allow `Math.round(price * 100)` (inside toStripeMinorUnits, only in stripe.ts).
      const lines = source.split("\n");
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (/^\s*\*|^\s*\/\//.test(line)) continue;
        // Look for *: price|amount|total identifier followed by * 100
        if (/(price|amount|total)\b[^*\n]*\*\s*100\b/i.test(line)) {
          // Allow the one inside toStripeMinorUnits() implementation.
          if (path.endsWith("stripe.ts") && /Math\.round\(\s*price\s*\*\s*100\s*\)/.test(line)) continue;
          offenders.push(`${path}:${i + 1}  ${line.trim()}`);
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `Naked '* 100' on money values still present — must use toStripeMinorUnits() (#69):\n${offenders.join("\n")}`,
      );
    });
  }
});
