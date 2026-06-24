import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyReceipt,
  VRP_RECEIPT_VERSION,
  VRP_RECEIPT_V1_SCHEMA,
  type AttestationInput,
  type JwksResolver,
} from "../lib/vrp-receipt.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KID = "vrp-receipt-test-2026-06-24-01";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "EdDSA", use: "sig" };
const JWKS = { keys: [jwk] };

function compactJws(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = { alg: "EdDSA", kid: KID, typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = edSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

const HOUR = 3_600_000;
const freshFrom = new Date(Date.now() - HOUR).toISOString();
const freshUntil = new Date(Date.now() + HOUR).toISOString();

function signedAttestation(layer: string, extra: Partial<AttestationInput> = {}): AttestationInput {
  return {
    layer,
    source: "https://host.example/.well-known/jwks.json",
    signature: compactJws({ layer, ref: `${layer}:test` }),
    valid_from: freshFrom,
    valid_until: freshUntil,
    ...extra,
  };
}

function receipt(attestations: AttestationInput[], version = VRP_RECEIPT_VERSION): unknown {
  return {
    vrp_receipt_version: version,
    subject: { property: "villaakerlyckan.se", stay: "2026-09-02/2026-09-05" },
    issuer: { node: "villaakerlyckan.se" },
    attestations,
  };
}

const resolveOk: JwksResolver = () => JWKS;
const resolveNone: JwksResolver = () => null;

test("VRP receipt: a fully-signed, fresh receipt verifies (offer + transport)", () => {
  const r = verifyReceipt(receipt([signedAttestation("offer"), signedAttestation("transport")]), {
    resolveJwks: resolveOk,
  });
  assert.equal(r.receipt_valid, true);
  assert.equal(r.fully_verified, true);
  assert.deepEqual(
    r.attestations.map((a) => a.status),
    ["verified", "verified"],
  );
  assert.equal(r.attestations[0].kid, KID);
});

test("VRP receipt: PARTIAL verification — offer verified, payment present-but-unverifiable (D4)", () => {
  const payment: AttestationInput = {
    layer: "payment",
    valid_from: freshFrom,
    valid_until: freshUntil,
    // no signature: an AP2/TAP attestation captured read-only (ADR 0010 D3/D9)
  };
  const r = verifyReceipt(receipt([signedAttestation("offer"), payment]), { resolveJwks: resolveOk });
  assert.equal(r.receipt_valid, true);
  assert.equal(r.fully_verified, false, "a present-but-unverifiable layer must NOT count as fully verified");
  assert.equal(r.attestations[0].status, "verified");
  assert.equal(r.attestations[1].status, "unverifiable");
  assert.equal(r.attestations[1].error, "layer_unverifiable");
});

test("VRP receipt: signature present but key unresolvable → unverifiable (not invalid)", () => {
  const r = verifyReceipt(receipt([signedAttestation("offer")]), { resolveJwks: resolveNone });
  assert.equal(r.attestations[0].status, "unverifiable");
  assert.equal(r.attestations[0].error, "key_unresolvable");
});

test("VRP receipt: tampered signature → invalid / sig_invalid", () => {
  const att = signedAttestation("offer");
  att.signature = `${att.signature!.slice(0, -4)}AAAA`;
  const r = verifyReceipt(receipt([att]), { resolveJwks: resolveOk });
  assert.equal(r.attestations[0].status, "invalid");
  assert.equal(r.attestations[0].error, "sig_invalid");
  assert.equal(r.fully_verified, false);
});

test("VRP receipt: expired window → expired / sig_expired (signature still checked first)", () => {
  const att = signedAttestation("offer", {
    valid_from: new Date(Date.now() - 2 * HOUR).toISOString(),
    valid_until: new Date(Date.now() - HOUR).toISOString(),
  });
  const r = verifyReceipt(receipt([att]), { resolveJwks: resolveOk });
  assert.equal(r.attestations[0].status, "expired");
  assert.equal(r.attestations[0].error, "sig_expired");
});

test("VRP receipt: not-yet-valid window → expired / not_yet_valid", () => {
  const att = signedAttestation("offer", {
    valid_from: new Date(Date.now() + HOUR).toISOString(),
    valid_until: new Date(Date.now() + 2 * HOUR).toISOString(),
  });
  const r = verifyReceipt(receipt([att]), { resolveJwks: resolveOk });
  assert.equal(r.attestations[0].status, "expired");
  assert.equal(r.attestations[0].error, "not_yet_valid");
});

test("VRP receipt: unsupported version is rejected at the envelope level", () => {
  const r = verifyReceipt(receipt([signedAttestation("offer")], "0.9"), { resolveJwks: resolveOk });
  assert.equal(r.receipt_valid, false);
  assert.deepEqual(r.errors, ["unsupported_version"]);
});

test("VRP receipt: empty attestations[] is malformed", () => {
  const r = verifyReceipt(receipt([]), { resolveJwks: resolveOk });
  assert.equal(r.receipt_valid, false);
  assert.deepEqual(r.errors, ["malformed_receipt"]);
});

test("VRP receipt: D3 optional tlog does not fail; D1 reserved sub_receipt is ignored", () => {
  const att = signedAttestation("offer", {
    tlog: { tree_size: 2, log_index: 1 },
    sub_receipt: { vrp_receipt_version: "1.0" }, // present, but v1 must not recurse
  });
  const r = verifyReceipt(receipt([att]), { resolveJwks: resolveOk });
  assert.equal(r.fully_verified, true);
  assert.equal(r.attestations[0].status, "verified");
});

test("VRP receipt: published schema artifact matches the embedded source of truth", () => {
  const onDisk = JSON.parse(readFileSync(resolve(REPO_ROOT, "spec/vrp-receipt.v1.schema.json"), "utf8"));
  assert.deepEqual(
    onDisk,
    VRP_RECEIPT_V1_SCHEMA,
    "spec/vrp-receipt.v1.schema.json drifted from VRP_RECEIPT_V1_SCHEMA in lib/vrp-receipt.ts — keep them byte-equal",
  );
});
