import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { ap2PaymentAttestation, assessAp2Payment, VRP_PAYMENT_LAYER } from "../lib/vrp-payment-profile.js";
import { verifyReceipt, VRP_RECEIPT_VERSION, type JwksResolver } from "../lib/vrp-receipt.js";
import type { Ap2ChargeContext } from "../lib/ap2.js";

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KID = "vrp-pay-test-2026-06-24-01";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "EdDSA", use: "sig" };
const JWKS = { keys: [jwk] };

function signJws(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = { alg: "EdDSA", kid: KID, typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(edSign(null, Buffer.from(signingInput), key))}`;
}

const HOUR = 3_600_000;
const fresh = { valid_from: new Date(Date.now() - HOUR).toISOString(), valid_until: new Date(Date.now() + HOUR).toISOString() };
const CART = "vrp_cart_villaakerlyckan_2026-09-02";
const ISSUER_JWKS_URI = "https://issuer.example/.well-known/jwks.json";
const NODE_JWKS_URI = "https://villaakerlyckan.se/.well-known/jwks.json";

// Canonical AP2 PaymentMandate (vct = mandate.payment.1) — see lib/ap2.ts / ADR 0008.
const mandatePayload = {
  vct: "mandate.payment.1",
  payee: { website: "villaakerlyckan.se" },
  payment_amount: { amount: 6800, currency: "SEK" },
  exp: Math.floor((Date.now() + HOUR) / 1000),
  transaction_id: CART,
};
const mandateJws = signJws(mandatePayload);

const charge: Ap2ChargeContext = {
  amountMinor: 6800,
  currency: "SEK",
  merchantDomain: "villaakerlyckan.se",
  cartId: CART,
};

function offerAttestation() {
  return {
    layer: "offer",
    source: NODE_JWKS_URI,
    signature: signJws({ offer_id: CART }),
    ref: CART,
    ...fresh,
  };
}

test("AP2 payment: a resolvable mandate verifies as a payment attestation in a receipt", () => {
  const payment = ap2PaymentAttestation({ mandateJws, issuerJwksUri: ISSUER_JWKS_URI, ref: CART, ...fresh });
  const resolveAll: JwksResolver = () => JWKS;
  const r = verifyReceipt(
    { vrp_receipt_version: VRP_RECEIPT_VERSION, subject: {}, issuer: {}, attestations: [offerAttestation(), payment] },
    { resolveJwks: resolveAll },
  );
  assert.equal(r.receipt_valid, true);
  assert.equal(r.fully_verified, true);
  assert.equal(r.attestations[1].layer, VRP_PAYMENT_LAYER);
  assert.deepEqual(r.attestations.map((a) => a.status), ["verified", "verified"]);
});

test("AP2 payment: read-only capture — unresolvable issuer key → unverifiable, offer still verified (D9)", () => {
  const payment = ap2PaymentAttestation({ mandateJws, issuerJwksUri: ISSUER_JWKS_URI, ref: CART, ...fresh });
  // Node key resolvable; payer/issuer key not yet → payment captured read-only.
  const resolvePartial: JwksResolver = (source) => (source === NODE_JWKS_URI ? JWKS : null);
  const r = verifyReceipt(
    { vrp_receipt_version: VRP_RECEIPT_VERSION, subject: {}, issuer: {}, attestations: [offerAttestation(), payment] },
    { resolveJwks: resolvePartial },
  );
  assert.equal(r.receipt_valid, true);
  assert.equal(r.fully_verified, false);
  assert.equal(r.attestations[0].status, "verified");
  assert.equal(r.attestations[1].status, "unverifiable");
  assert.equal(r.attestations[1].error, "key_unresolvable");
});

test("AP2 payment: level-2 authorization — authentic mandate authorizes a matching charge", () => {
  const a = assessAp2Payment(mandateJws, JWKS, charge);
  assert.equal(a.signature_verified, true);
  assert.equal(a.charge_authorized, true);
  assert.equal(a.claims?.merchant, "villaakerlyckan.se");
});

test("AP2 payment: authentic ≠ authorized — over-cap charge is rejected fail-closed", () => {
  const a = assessAp2Payment(mandateJws, JWKS, { ...charge, amountMinor: 999999 });
  assert.equal(a.signature_verified, true, "still an authentic mandate");
  assert.equal(a.charge_authorized, false, "but NOT authorized for this charge");
  assert.equal(a.reason, "amount_exceeds_mandate");
});

test("AP2 payment: a tampered mandate is not signature_verified (and not authorized)", () => {
  const a = assessAp2Payment(`${mandateJws.slice(0, -4)}AAAA`, JWKS, charge);
  assert.equal(a.signature_verified, false);
  assert.equal(a.charge_authorized, false);
  assert.equal(a.reason, "sig_invalid");
});
