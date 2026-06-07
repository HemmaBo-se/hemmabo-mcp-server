import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  verifyAp2CartMandate,
  mandateAuthorizesCharge,
  extractMandateClaims,
  type Ap2ChargeContext,
} from "../lib/ap2.js";

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KID = "test-issuer-2026-06-07-01";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID };
const JWKS = { keys: [jwk] };

/** Sign an AP2 mandate as an Ed25519 compact JWS (same wire shape as VRP). */
function makeMandate(claims: Record<string, unknown>, key = privateKey): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = edSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

const future = new Date(Date.now() + 3_600_000).toISOString();
const past = new Date(Date.now() - 3_600_000).toISOString();

const validClaims = {
  type: "CartMandate",
  max_amount: 12000, // minor units — SEK 120.00 cap
  currency: "SEK",
  merchant: "villaakerlyckan.se",
  cart_id: "vrp_villa_123",
  expires_at: future,
};

const charge: Ap2ChargeContext = {
  amountMinor: 10200, // within cap
  currency: "sek", // case-insensitive
  merchantDomain: "www.villaakerlyckan.se", // www stripped on compare
  cartId: "vrp_villa_123",
};

test("AP2: valid Cart Mandate authorizes a matching charge", () => {
  const r = verifyAp2CartMandate(makeMandate(validClaims), JWKS, charge);
  assert.equal(r.authorized, true);
  assert.equal(r.claims?.merchant, "villaakerlyckan.se");
  assert.equal(r.claims?.maxAmountMinor, 12000);
});

test("AP2: charge over the mandate cap is rejected", () => {
  const r = verifyAp2CartMandate(makeMandate(validClaims), JWKS, { ...charge, amountMinor: 99999 });
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "amount_exceeds_mandate");
});

test("AP2: currency mismatch is rejected", () => {
  const r = verifyAp2CartMandate(makeMandate(validClaims), JWKS, { ...charge, currency: "EUR" });
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "currency_mismatch");
});

test("AP2: merchant mismatch is rejected", () => {
  const r = verifyAp2CartMandate(makeMandate(validClaims), JWKS, {
    ...charge,
    merchantDomain: "evil.example.com",
  });
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "merchant_mismatch");
});

test("AP2: expired mandate is rejected", () => {
  const r = verifyAp2CartMandate(makeMandate({ ...validClaims, expires_at: past }), JWKS, charge);
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "mandate_expired");
});

test("AP2: cart mismatch is rejected", () => {
  const r = verifyAp2CartMandate(makeMandate(validClaims), JWKS, { ...charge, cartId: "different_cart" });
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "cart_mismatch");
});

test("AP2: tampered payload fails signature verification (throws)", () => {
  const [h, , s] = makeMandate(validClaims).split(".");
  const forged = b64url(JSON.stringify({ ...validClaims, max_amount: 9_999_999 }));
  assert.throws(() => verifyAp2CartMandate(`${h}.${forged}.${s}`, JWKS, charge));
});

test("AP2: signature from an unknown key is rejected (throws)", () => {
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => verifyAp2CartMandate(makeMandate(validClaims, other.privateKey), JWKS, charge));
});

test("AP2: mandate missing an amount cap is rejected (fail closed)", () => {
  const claims = extractMandateClaims({
    type: "CartMandate",
    currency: "SEK",
    merchant: "villaakerlyckan.se",
    expires_at: future,
  });
  const r = mandateAuthorizesCharge(claims, charge);
  assert.equal(r.authorized, false);
  assert.equal(r.reason, "mandate_missing_amount");
});

test("AP2: decimal major-unit amount is normalised to minor units", () => {
  const claims = extractMandateClaims({ ...validClaims, max_amount: 120.5 });
  assert.equal(claims.maxAmountMinor, 12050);
});
