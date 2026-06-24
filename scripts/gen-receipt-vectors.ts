/**
 * Deterministic generator for the public VRP receipt test vectors
 * (ADR 0010 Phase 4). Run it to (re)write `spec/vectors/*.json`:
 *
 *   npx tsx scripts/gen-receipt-vectors.ts
 *
 * Each vector is self-contained — `jwks` + `receipt` + `now` + the `expected`
 * verification result — so an external implementer can check their verifier
 * against the SAME bytes without reading any TypeScript. Signatures are
 * deterministic (fixed seed below), so committed vectors are reproducible.
 *
 * The signing key here is a NON-SECRET, hard-coded test-vector key (seed =
 * 32 × 0x07). It only ever signs these public fixtures. The private seed never
 * needs to leave this file; verifiers only consume the published public JWKS.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "spec", "vectors");

const SEED = Buffer.alloc(32, 0x07);
const PKCS8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]);
const privateKey = createPrivateKey({ key: PKCS8, format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);

export const VECTOR_KID = "vrp-vectors-2026-01-01-01";
export const VECTOR_JWKS = {
  keys: [
    {
      ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: VECTOR_KID,
      alg: "EdDSA",
      use: "sig",
    },
  ],
};

const b64url = (i: Buffer | string) => Buffer.from(i).toString("base64url");
function signJws(payload: Record<string, unknown>): string {
  const header = { alg: "EdDSA", kid: VECTOR_KID, typ: "JWT" };
  const si = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${si}.${b64url(edSign(null, Buffer.from(si), privateKey))}`;
}

export const VECTOR_NOW = "2026-06-24T12:00:00Z";
const NOW = Date.parse(VECTOR_NOW);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const freshFrom = iso(NOW - HOUR);
const freshUntil = iso(NOW + HOUR);
const JWKS_URI = "https://villaakerlyckan.se/.well-known/jwks.json";
const CART = "offer:villaakerlyckan.se:2026-09-02/05";

interface Vector {
  name: string;
  description: string;
  now: string;
  jwks: typeof VECTOR_JWKS;
  receipt: unknown;
  expected: unknown;
}

const offerSigned = {
  layer: "offer",
  source: JWKS_URI,
  signature: signJws({ offer_id: CART }),
  ref: CART,
  valid_from: freshFrom,
  valid_until: freshUntil,
};
const transportSigned = {
  layer: "transport",
  source: JWKS_URI,
  signature: signJws({ type: "vrp.mcp.transport.1", tool: "get_verified_stay_offer", served_at: VECTOR_NOW }),
  ref: CART,
  valid_from: freshFrom,
  valid_until: freshUntil,
};

function receipt(attestations: unknown[], version = "1.0"): unknown {
  return {
    vrp_receipt_version: version,
    subject: { property: "villaakerlyckan.se", stay: "2026-09-02/2026-09-05" },
    issuer: { node: "villaakerlyckan.se" },
    attestations,
  };
}

export function buildVectors(): Vector[] {
  const tamperedOffer = { ...offerSigned, signature: `${offerSigned.signature.slice(0, -4)}AAAA` };
  const expiredOffer = {
    ...offerSigned,
    valid_from: iso(NOW - 2 * HOUR),
    valid_until: iso(NOW - HOUR),
  };
  const unsignedPayment = { layer: "payment", ref: CART, valid_from: freshFrom, valid_until: freshUntil };

  return [
    {
      name: "01-offer-transport-verified",
      description: "Offer + transport attestations, both signed and fresh → fully verified.",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([offerSigned, transportSigned]),
      expected: {
        receipt_valid: true,
        fully_verified: true,
        errors: [],
        attestations: [
          { index: 0, layer: "offer", status: "verified", error: null, kid: VECTOR_KID },
          { index: 1, layer: "transport", status: "verified", error: null, kid: VECTOR_KID },
        ],
      },
    },
    {
      name: "02-partial-payment-unverifiable",
      description: "Offer verified; payment present but unsigned → read-only unverifiable, NOT fully verified (D4).",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([offerSigned, unsignedPayment]),
      expected: {
        receipt_valid: true,
        fully_verified: false,
        errors: [],
        attestations: [
          { index: 0, layer: "offer", status: "verified", error: null, kid: VECTOR_KID },
          { index: 1, layer: "payment", status: "unverifiable", error: "layer_unverifiable", kid: null },
        ],
      },
    },
    {
      name: "03-tampered-signature",
      description: "Offer signature corrupted → invalid / sig_invalid.",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([tamperedOffer]),
      expected: {
        receipt_valid: true,
        fully_verified: false,
        errors: [],
        attestations: [{ index: 0, layer: "offer", status: "invalid", error: "sig_invalid", kid: null }],
      },
    },
    {
      name: "04-expired-window",
      description: "Offer signature valid but validity window is in the past relative to `now` → expired / sig_expired.",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([expiredOffer]),
      expected: {
        receipt_valid: true,
        fully_verified: false,
        errors: [],
        attestations: [{ index: 0, layer: "offer", status: "expired", error: "sig_expired", kid: VECTOR_KID }],
      },
    },
    {
      name: "05-unsupported-version",
      description: "Envelope version is not 1.0 → rejected at the envelope level.",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([offerSigned], "0.9"),
      expected: { receipt_valid: false, fully_verified: false, errors: ["unsupported_version"], attestations: [] },
    },
    {
      name: "06-malformed-empty-attestations",
      description: "Empty attestations[] → malformed receipt.",
      now: VECTOR_NOW,
      jwks: VECTOR_JWKS,
      receipt: receipt([]),
      expected: { receipt_valid: false, fully_verified: false, errors: ["malformed_receipt"], attestations: [] },
    },
  ];
}

function writeAll(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const v of buildVectors()) {
    writeFileSync(join(OUT_DIR, `${v.name}.json`), `${JSON.stringify(v, null, 2)}\n`, "utf8");
  }
  console.log(`Wrote ${buildVectors().length} vector(s) to ${OUT_DIR}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) writeAll();
