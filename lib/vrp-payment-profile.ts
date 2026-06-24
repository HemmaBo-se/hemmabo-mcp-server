/**
 * VRP composition profile — payment (AP2) — v1 (ADR 0010 D9 / Phase 3).
 *
 * Captures an external, payer-signed AP2 Payment Mandate as a `layer: "payment"`
 * attestation in a VRP receipt. The mandate is itself an Ed25519 compact JWS, so
 * it composes directly with the receipt verifier (`lib/vrp-receipt.ts`) and the
 * existing AP2 logic (`lib/ap2.ts`) — no new crypto.
 *
 * Honesty model (ADR 0010 D9 + ADR 0008). Two DISTINCT levels, never conflated:
 *
 *   1. Authentic   — the receipt `payment` attestation status. Proves the
 *                    mandate JWS is signature-verified against the issuer JWKS
 *                    and fresh. If the issuer key cannot be resolved, the layer
 *                    is captured READ-ONLY as `unverifiable` (key_unresolvable),
 *                    never silently `verified` — exactly the "store and log the
 *                    attestation even before you can verify all links" posture.
 *   2. Authorized  — a SEPARATE policy decision (`assessAp2Payment`) that the
 *                    verified mandate authorizes a specific charge (amount cap,
 *                    currency, merchant, expiry, cart). This is `lib/ap2.ts`'s
 *                    `mandateAuthorizesCharge`, unchanged and fail-closed.
 *
 * A `payment` attestation being `verified` means "we hold an authentic, fresh
 * AP2 mandate" — NOT "the charge is authorized." Authorization is level 2.
 */
import {
  verifyAp2Mandate,
  mandateAuthorizesCharge,
  type Ap2ChargeContext,
  type Ap2MandateClaims,
} from "./ap2.js";
import type { AttestationInput } from "./vrp-receipt.js";

type JsonRecord = Record<string, unknown>;

export const VRP_PAYMENT_PROFILE_VERSION = "1.0";
export const VRP_PAYMENT_LAYER = "payment";

export interface Ap2PaymentAttestationInput {
  /** Payer/agent-signed AP2 mandate as a compact JWS (the signed artifact). */
  mandateJws: string;
  /** Where the mandate ISSUER publishes its Ed25519 JWKS (the attestation source). */
  issuerJwksUri: string;
  valid_from: string;
  valid_until: string;
  /** Correlator to the offer/cart this payment authorizes. */
  ref?: string;
}

/**
 * Wrap an AP2 mandate as a VRP receipt `payment` attestation. The mandate's own
 * JWS is the attestation signature; `source` is the issuer JWKS URI so the
 * receipt verifier resolves the payer's key (not the node's). When the verifier
 * cannot resolve that key, the layer is captured read-only as `unverifiable`.
 */
export function ap2PaymentAttestation(input: Ap2PaymentAttestationInput): AttestationInput {
  const att: AttestationInput = {
    layer: VRP_PAYMENT_LAYER,
    source: input.issuerJwksUri,
    signature: input.mandateJws,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
  };
  if (input.ref !== undefined) att.ref = input.ref;
  return att;
}

export interface PaymentAuthorizationAssessment {
  /** Level 1: mandate signature authentic against the issuer JWKS. */
  signature_verified: boolean;
  /** Level 2: the verified mandate authorizes THIS charge (fail-closed). */
  charge_authorized: boolean;
  /** Failure code from `lib/ap2.ts` (`mandateAuthorizesCharge`) or `sig_invalid`. */
  reason?: string;
  claims?: Ap2MandateClaims;
}

/**
 * Assess an AP2 payment against a charge — the level-2 authorization decision,
 * kept separate from the receipt's level-1 signature/freshness status. Verifies
 * the mandate signature, then applies the unchanged fail-closed charge checks.
 * Never throws: a bad signature returns `{ signature_verified:false }`.
 */
export function assessAp2Payment(
  mandateJws: string,
  issuerJwks: JsonRecord,
  charge: Ap2ChargeContext,
  nowMs: number = Date.now(),
): PaymentAuthorizationAssessment {
  let claims: Ap2MandateClaims;
  try {
    claims = verifyAp2Mandate(mandateJws, issuerJwks).claims;
  } catch {
    return { signature_verified: false, charge_authorized: false, reason: "sig_invalid" };
  }
  const result = mandateAuthorizesCharge(claims, charge, nowMs);
  return {
    signature_verified: true,
    charge_authorized: result.authorized,
    reason: result.reason,
    claims: result.claims,
  };
}
