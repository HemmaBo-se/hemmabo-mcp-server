/**
 * VRP receipt envelope — v1 reference verifier (ADR 0010).
 *
 * A VRP receipt is a versioned "verifiable booking record": a FLAT array of
 * attestations, each a signed artifact from one trust layer (offer, transport,
 * payment, …). This module is the reference verifier that other implementers
 * can check their output against — it is the Phase 1/Phase 4 deliverable of
 * ADR 0010 (the schema shape + the open verifier), composing the existing VRP
 * primitive `verifyCompactJws`.
 *
 * v1 normative rules implemented here:
 *   D1  Flat attestations[]. Reserved `sub_receipt` / `disclosure` extension
 *       points are NOT interpreted (no recursion in v1).
 *   D2  Every attestation MUST carry `valid_from` / `valid_until`; freshness is
 *       checked per attestation.
 *   D3  `tlog` inclusion proof is OPTIONAL. A missing tlog is signature-only,
 *       never a failure; we never claim log-anchored properties for it.
 *   D4  A normative error registry + PARTIAL verification: the result reports a
 *       per-attestation status ("offer + transport verified, payment layer
 *       present-but-unverifiable"), not a single boolean. `unverifiable` is
 *       distinct from `verified`.
 *   D5  The signature is verified over the compact-JWS bytes as received
 *       (`verifyCompactJws`); no JSON re-canonicalization re-derives the input.
 */
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { verifyCompactJws } from "./vrp.js";

type JsonRecord = Record<string, unknown>;

export const VRP_RECEIPT_VERSION = "1.0";

/**
 * Normative v1 receipt schema (ADR 0010 D1–D5). This object is the source of
 * truth consumed by the verifier; `spec/vrp-receipt.v1.schema.json` is the
 * published artifact and is asserted byte-equal by a drift-guard test.
 */
export const VRP_RECEIPT_V1_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://vacationrentalprotocol.com/spec/vrp-receipt.v1.schema.json",
  title: "VRP Receipt Envelope v1",
  description:
    "Vacation Rental Protocol verifiable booking record. A versioned receipt with a FLAT array of attestations (ADR 0010 D1). Recursive sub-receipts and selective disclosure are reserved v2 extension points (present-but-empty in v1); a v1 verifier never recurses into them.",
  type: "object",
  required: ["vrp_receipt_version", "subject", "issuer", "attestations"],
  additionalProperties: true,
  properties: {
    vrp_receipt_version: {
      type: "string",
      const: "1.0",
      description: 'Receipt envelope version. v1 verifiers accept exactly "1.0".',
    },
    subject: {
      type: "object",
      description:
        "What the receipt is about (e.g. property, stay window, offer id). Kept generic so the envelope is not locked to vacation rentals.",
    },
    issuer: {
      type: "object",
      description: "The node identity that assembled the receipt.",
    },
    attestations: {
      type: "array",
      minItems: 1,
      description:
        "FLAT list of attestations (ADR 0010 D1). A new trust layer = a new entry; no central approval.",
      items: { $ref: "#/definitions/attestation" },
    },
  },
  definitions: {
    attestation: {
      type: "object",
      required: ["layer", "valid_from", "valid_until"],
      additionalProperties: true,
      properties: {
        layer: {
          type: "string",
          minLength: 1,
          description: 'Open vocabulary, e.g. "offer", "transport", "payment".',
        },
        source: {
          type: "string",
          description:
            "Where the verifying key is published for this attestation (e.g. a JWKS URL).",
        },
        signature: {
          type: "string",
          description:
            "The signed artifact as a compact JWS. v1 verifies the signature over the JWS bytes as received (ADR 0010 D5).",
        },
        ref: {
          type: "string",
          description:
            "Opaque correlator binding this attestation to an external object (offer id, transaction id, …).",
        },
        valid_from: {
          type: "string",
          format: "date-time",
          description:
            "Start of the attestation validity window (ADR 0010 D2; mandatory per attestation).",
        },
        valid_until: {
          type: "string",
          format: "date-time",
          description:
            "End of the attestation validity window (ADR 0010 D2; mandatory per attestation).",
        },
        tlog: {
          type: "object",
          description:
            "OPTIONAL transparency-log inclusion proof (ADR 0010 D3). A missing tlog is NOT a failure; a v1 verifier must not claim log-anchored properties for an attestation that lacks one.",
        },
        sub_receipt: {
          description:
            "RESERVED v2 extension point (ADR 0010 D1). Recursive/chained receipts. A v1 verifier does not recurse into it.",
          type: ["object", "null"],
        },
        disclosure: {
          description:
            "RESERVED v2 extension point (ADR 0010 D1). Selective-disclosure / ZK pointers. Not interpreted by a v1 verifier.",
          type: ["object", "null"],
        },
      },
    },
  },
} as const;

/** Per-attestation verification outcome (ADR 0010 D4). */
export type AttestationStatus = "verified" | "expired" | "unverifiable" | "invalid";

/**
 * Normative VRP receipt error registry (ADR 0010 D4). Seeded by unifying codes
 * that already exist in the reference implementation rather than inventing new
 * ones: VRP offer-layer codes come from `lib/vrp.ts` (`blocked_reason`) and
 * payment-layer codes from `lib/ap2.ts` (`reason`).
 */
export type VrpReceiptErrorCode =
  // Envelope / signature level
  | "unsupported_version"
  | "malformed_receipt"
  | "malformed_attestation"
  | "missing_validity_window"
  | "sig_invalid"
  | "sig_expired"
  | "not_yet_valid"
  | "key_unresolvable"
  | "layer_unverifiable"
  | "canonicalization_mismatch"
  // VRP offer-layer (reused from lib/vrp.ts `blocked_reason`)
  | "agent_permission_denied"
  | "not_available"
  | "price_not_exact"
  | "direct_booking_url_missing"
  // AP2 payment-layer (reused from lib/ap2.ts `reason`)
  | "mandate_expired"
  | "mandate_missing_amount"
  | "invalid_charge_amount"
  | "amount_exceeds_mandate"
  | "currency_mismatch"
  | "merchant_mismatch"
  | "cart_mismatch";

export interface AttestationInput {
  layer: string;
  source?: string;
  signature?: string;
  ref?: string;
  valid_from?: string;
  valid_until?: string;
  tlog?: unknown;
  sub_receipt?: unknown;
  disclosure?: unknown;
  [key: string]: unknown;
}

export interface VrpReceiptInput {
  vrp_receipt_version: string;
  subject: JsonRecord;
  issuer: JsonRecord;
  attestations: AttestationInput[];
  [key: string]: unknown;
}

export interface AttestationResult {
  index: number;
  layer: string;
  status: AttestationStatus;
  error: VrpReceiptErrorCode | null;
  kid: string | null;
}

export interface ReceiptVerificationResult {
  /** Structurally a valid v1 receipt (version + schema). */
  receipt_valid: boolean;
  /** Every attestation verified AND fresh. Partial success is NOT full. */
  fully_verified: boolean;
  attestations: AttestationResult[];
  /** Envelope-level errors (empty when the structure is valid). */
  errors: VrpReceiptErrorCode[];
}

/**
 * Resolve the Ed25519 JWKS used to verify one attestation's signature. Kept as
 * an injected dependency so the verifier is pure and offline-testable; a caller
 * may resolve by fetching `attestation.source`, or supply a fixed key set.
 * Returning `null` marks the attestation `unverifiable` (key_unresolvable),
 * never `invalid` — absence of a key is not a forged signature.
 */
export type JwksResolver = (
  source: string | undefined,
  attestation: AttestationInput,
) => JsonRecord | null;

export interface VerifyReceiptOptions {
  resolveJwks: JwksResolver;
  /** Override the clock (epoch ms) for deterministic freshness tests. */
  now?: number;
}

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });
(addFormatsModule as unknown as (a: Ajv) => Ajv)(ajv);
const validateReceiptShape: ValidateFunction = ajv.compile(VRP_RECEIPT_V1_SCHEMA);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Verify one attestation in isolation (no cross-layer binding in v1). */
function verifyAttestation(
  att: AttestationInput,
  index: number,
  opts: VerifyReceiptOptions,
): AttestationResult {
  const layer = typeof att.layer === "string" ? att.layer : "";
  const base = { index, layer, kid: null as string | null };

  const from = parseInstant(att.valid_from);
  const until = parseInstant(att.valid_until);
  if (from === null || until === null) {
    return { ...base, status: "invalid", error: "missing_validity_window" };
  }

  if (typeof att.signature !== "string" || att.signature.trim() === "") {
    return { ...base, status: "unverifiable", error: "layer_unverifiable" };
  }

  const jwks = opts.resolveJwks(att.source, att);
  if (!asRecord(jwks)) {
    return { ...base, status: "unverifiable", error: "key_unresolvable" };
  }

  let kid: string | null = null;
  try {
    kid = verifyCompactJws(att.signature, jwks as JsonRecord).kid;
  } catch {
    return { ...base, status: "invalid", error: "sig_invalid" };
  }

  // Signature is valid; now apply the freshness window (ADR 0010 D2).
  const now = opts.now ?? Date.now();
  if (now < from) return { ...base, kid, status: "expired", error: "not_yet_valid" };
  if (now > until) return { ...base, kid, status: "expired", error: "sig_expired" };
  return { ...base, kid, status: "verified", error: null };
}

/**
 * Verify a VRP receipt envelope. Returns per-attestation status with partial
 * verification (ADR 0010 D4) — `fully_verified` is true only when every
 * attestation is `verified`. Never throws on a well-formed call: malformed
 * input is reported as `receipt_valid: false` with an envelope error.
 */
export function verifyReceipt(
  receipt: unknown,
  opts: VerifyReceiptOptions,
): ReceiptVerificationResult {
  const record = asRecord(receipt);
  if (record && record.vrp_receipt_version !== VRP_RECEIPT_VERSION) {
    return { receipt_valid: false, fully_verified: false, attestations: [], errors: ["unsupported_version"] };
  }

  if (!validateReceiptShape(receipt)) {
    return { receipt_valid: false, fully_verified: false, attestations: [], errors: ["malformed_receipt"] };
  }

  const valid = receipt as VrpReceiptInput;
  const attestations = valid.attestations.map((att, i) => verifyAttestation(att, i, opts));
  const fully_verified = attestations.every((a) => a.status === "verified");
  return { receipt_valid: true, fully_verified, attestations, errors: [] };
}
