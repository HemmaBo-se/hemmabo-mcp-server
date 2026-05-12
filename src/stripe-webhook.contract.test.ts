/**
 * Contract test for #70 — Stripe webhook signature verification.
 *
 * Locks the payments contract from ADR 0002 §2.2 clause 3 (webhook
 * authoritative) and clause 4 (no silent payment failures).
 *
 * This test does NOT hit the real Stripe API. It generates HMAC
 * signatures with a test secret using the exact same algorithm Stripe
 * uses, so the verifier code runs end-to-end against realistic input.
 *
 * Run: npx tsx --test src/stripe-webhook.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../api/stripe-webhook.js";

const SECRET = "whsec_test_dummy_secret_for_contract_test_only";

function sign(rawBody: string, timestamp: number, secret: string = SECRET): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

const NOW = 1_715_500_000;

describe("verifyStripeSignature (#70)", () => {
  it("accepts a valid signature with current timestamp", () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
    const header = sign(body, NOW);
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, true);
  });

  it("rejects when Stripe-Signature header is missing", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const result = verifyStripeSignature(body, undefined, SECRET, NOW);
    assert.deepEqual(result, { valid: false, reason: "Missing Stripe-Signature header" });
  });

  it("rejects when header is malformed", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const result = verifyStripeSignature(body, "this is not a stripe sig", SECRET, NOW);
    assert.equal(result.valid, false);
  });

  it("rejects when signed body differs from received body (replay/tamper)", () => {
    const body = JSON.stringify({ id: "evt_1", amount: 1000 });
    const tamperedBody = JSON.stringify({ id: "evt_1", amount: 999999 });
    const header = sign(body, NOW);
    const result = verifyStripeSignature(tamperedBody, header, SECRET, NOW);
    assert.equal(result.valid, false);
  });

  it("rejects timestamps older than 5 minutes (replay protection)", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const oldTimestamp = NOW - 6 * 60;
    const header = sign(body, oldTimestamp);
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.reason, /tolerance/);
    }
  });

  it("rejects future-dated timestamps beyond tolerance", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const futureTimestamp = NOW + 6 * 60;
    const header = sign(body, futureTimestamp);
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, false);
  });

  it("rejects a signature created with the wrong secret", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const header = sign(body, NOW, "whsec_wrong_secret");
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, false);
  });

  it("accepts a header with multiple v1 signatures if any matches", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const goodSig = createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex");
    const header = `t=${NOW},v1=deadbeef,v1=${goodSig},v0=ignored`;
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, true);
  });

  it("constant-time-compares — does not short-circuit on first-byte mismatch", () => {
    // We can't truly time this in a unit test, but we can at least verify
    // that signatures of different lengths are rejected without throwing.
    const body = JSON.stringify({ id: "evt_1" });
    const header = `t=${NOW},v1=tooshort`;
    const result = verifyStripeSignature(body, header, SECRET, NOW);
    assert.equal(result.valid, false);
  });
});

describe("Webhook handler refund contract drift guard (#70)", () => {
  // Drift guard: assert api/acp.ts:cancelCheckout no longer has the
  // silent `catch { /* refund is best-effort */ }` pattern.
  it("api/acp.ts has no empty/comment-only refund catch", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "api/acp.ts"), "utf8");
    // Empty catch or catch-with-only-comment.
    const emptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[^*]*\*\/|\/\/[^\n]*)?\s*\}/g;
    const matches = source.match(emptyCatch) ?? [];
    assert.deepEqual(
      matches,
      [],
      `api/acp.ts must not contain empty / comment-only catch blocks (#70 silent-failure regression):\n${matches.join("\n")}`,
    );
  });
});
