/**
 * Contract test — the SPT preview API version pin.
 *
 * Why this exists: SharedPaymentToken redemption
 * (`payment_method_data[shared_payment_granted_token]`) is only accepted on a
 * preview API version. Without the `Stripe-Version` header the parameter is
 * rejected regardless of how correct the rest of the PaymentIntent is, so the
 * header is part of the agent-checkout contract — not an optimisation.
 *
 * What this locks:
 *   1. The pinned default is the version Stripe confirmed for SPT redemption
 *      (case 00721792, 2026-07-25). A silent edit fails here.
 *   2. STRIPE_SPT_API_VERSION overrides it; blank values fall back to the pin
 *      rather than sending an empty header.
 *   3. api/acp.ts sends the header on the SPT branch ONLY. A preview version
 *      changes behaviour across the whole API surface — an ordinary pm_ charge
 *      must keep running on the account's default version.
 *   4. No superseded preview version string survives anywhere in shipped code.
 *
 * Run: npx tsx --test src/spt-api-version.contract.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { SPT_API_VERSION_DEFAULT, sptApiVersion } from "./stripe.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const acpSource = readFileSync(join(root, "api", "acp.ts"), "utf8");

/** Preview versions this integration has moved off. None may linger in code. */
const SUPERSEDED_PREVIEW_VERSIONS = ["2026-04-22.preview"];

/**
 * Strip comments before scanning. Documenting *why* a version was superseded
 * is exactly what we want in a doc comment; what must never survive is a
 * superseded version reaching Stripe on the wire.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  };
  for (const d of ["api", "lib", "src", "scripts"]) walk(join(root, d));
  return out;
}

describe("SPT preview API version pin", () => {
  const originalOverride = process.env.STRIPE_SPT_API_VERSION;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.STRIPE_SPT_API_VERSION;
    else process.env.STRIPE_SPT_API_VERSION = originalOverride;
  });

  it("pins the version Stripe confirmed for SPT redemption", () => {
    assert.equal(SPT_API_VERSION_DEFAULT, "2026-07-08.preview");
  });

  it("defaults to the pin when no override is set", () => {
    delete process.env.STRIPE_SPT_API_VERSION;
    assert.equal(sptApiVersion(), SPT_API_VERSION_DEFAULT);
  });

  it("honours STRIPE_SPT_API_VERSION so a Stripe-side roll needs no deploy", () => {
    process.env.STRIPE_SPT_API_VERSION = "2026-09-01.preview";
    assert.equal(sptApiVersion(), "2026-09-01.preview");
  });

  it("falls back to the pin for blank or whitespace-only overrides", () => {
    for (const blank of ["", "   ", "\t"]) {
      process.env.STRIPE_SPT_API_VERSION = blank;
      assert.equal(
        sptApiVersion(),
        SPT_API_VERSION_DEFAULT,
        `blank override ${JSON.stringify(blank)} must not produce an empty header`
      );
    }
  });
});

describe("ACP redemption sends the preview version — SPT branch only", () => {
  it("redeems via the canonical payment_method_data parameter", () => {
    assert.match(
      acpSource,
      /payment_method_data\[shared_payment_granted_token\]/,
      "SPT redemption must use payment_method_data[shared_payment_granted_token]"
    );
  });

  it("sets Stripe-Version from the shared helper, guarded by the SPT branch", () => {
    assert.match(
      acpSource,
      /if \(isSpt\)\s*piHeaders\["Stripe-Version"\] = sptApiVersion\(\);/,
      "the Stripe-Version header must be set only when the token is an spt_"
    );
    assert.match(
      acpSource,
      /from "\.\.\/src\/stripe\.js"/,
      "the version must come from src/stripe.ts, never a call-site literal"
    );
  });

  it("never sends a preview version on the plain payment_method path", () => {
    // The piHeaders literal itself must carry only auth + content type; a
    // Stripe-Version key inside it would apply the preview version to pm_
    // charges too.
    const literal = acpSource.match(/const piHeaders: Record<string, string> = \{[\s\S]*?\};/);
    assert.ok(literal, "expected a piHeaders object literal in api/acp.ts");
    assert.doesNotMatch(
      literal[0],
      /Stripe-Version/,
      "Stripe-Version must be added conditionally after the literal, not inside it"
    );
    assert.match(
      acpSource,
      /headers: piHeaders,/,
      "the PaymentIntent fetch must use the conditionally-built header map"
    );
  });

  it("hardcodes no API version string at the call site", () => {
    assert.doesNotMatch(
      acpSource,
      /\d{4}-\d{2}-\d{2}\.preview/,
      "api/acp.ts must not inline a version — SPT_API_VERSION_DEFAULT is the single source"
    );
  });
});

describe("no superseded preview version survives in shipped code", () => {
  it("finds no reference to a version we have moved off", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const stale of SUPERSEDED_PREVIEW_VERSIONS) {
        if (text.includes(stale)) {
          offenders.push(`${relative(root, file).replaceAll("\\", "/")} → ${stale}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `superseded Stripe preview version still referenced:\n  ${offenders.join("\n  ")}`
    );
  });
});
