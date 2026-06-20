/**
 * AP2 (Agent Payments Protocol) — Cart Mandate verification.
 *
 * AP2 (Google's open Agent Payments Protocol) expresses a human's
 * authorization for an agent-initiated payment as a cryptographically
 * signed "Mandate" (a verifiable credential).
 *
 * Layering with VRP:
 *   VRP proves the OFFER       — this node signs the verified stay offer.
 *   AP2 proves the PAYMENT     — the payer's agent signs a Cart Mandate.
 * They are complementary: VRP = supply-side proof, AP2 = demand-side
 * proof. Verifying an AP2 Cart Mandate at the payment step is what makes
 * "AP2-compatible" literally true — not just a manifest claim.
 *
 * Crypto reuse: an AP2 mandate here is an Ed25519 compact JWS, verified
 * with the SAME primitive VRP already uses (`verifyCompactJws` in ./vrp).
 * The payer side signs the mandate; this node (the merchant) verifies it
 * against the issuer's published Ed25519 JWKS.
 *
 * WIRE-FORMAT: the canonical AP2 PaymentMandate (SD-JWT generated schema,
 * google-agentic-commerce/AP2) is parsed precisely — `vct`, `payee`
 * {id,name,website}, `payment_amount` {amount:int minor units, currency},
 * `exp`, `transaction_id` (see extractPaymentMandateClaims + ADR 0008). A
 * payload carrying the `vct=mandate.payment.*` marker takes that path; any
 * other shape falls back to the legacy candidate-name extractor
 * (MANDATE_FIELD_CANDIDATES). The constraint checks (amount cap, currency,
 * merchant, expiry, cart) are unchanged and spec-independent. Verification
 * fails CLOSED: a present-but-unparseable mandate is rejected, never charged.
 */
import { verifyCompactJws, VRP_FETCH_TIMEOUT_MS } from "./vrp.js";

type JsonRecord = Record<string, unknown>;

export const AP2_PROTOCOL = "agent-payments-protocol";
export const AP2_MANDATE_JWS_ALG = "EdDSA";

/** Logical claims extracted from a verified AP2 Cart Mandate. */
export interface Ap2MandateClaims {
  /** "CartMandate" (specific approved purchase) or "IntentMandate" (scoped intent). */
  mandateType: string | null;
  /** Maximum authorized amount, integer minor units (matches VRP/Stripe). */
  maxAmountMinor: number | null;
  /** ISO 4217 currency code, uppercased. */
  currency: string | null;
  /** Merchant the human authorized to be paid — here, the host domain (normalised). */
  merchant: string | null;
  /** Optional cart/offer identifier tying the mandate to a specific VRP offer. */
  cartId: string | null;
  /** Expiry as epoch milliseconds, or null if none present. */
  expiresAtMs: number | null;
}

export interface Ap2ChargeContext {
  /** Amount about to be charged, integer minor units. */
  amountMinor: number;
  /** ISO 4217 currency code of the charge (any case). */
  currency: string;
  /** Merchant / host domain receiving payment. */
  merchantDomain: string;
  /** Optional VRP offer/cart id the charge corresponds to. */
  cartId?: string;
}

export interface Ap2AuthorizationResult {
  authorized: boolean;
  reason?: string;
  claims?: Ap2MandateClaims;
}

// Candidate wire field names (isolated for easy spec-conformance). The
// extractor checks these in order; first present wins.
const MANDATE_FIELD_CANDIDATES = {
  mandateType: ["type", "mandate_type", "kind"],
  merchant: ["merchant", "payee", "merchant_id", "merchant_domain"],
  currency: ["currency", "currency_code"],
  cartId: ["cart_id", "offer_id", "cart", "id"],
  // amount cap — checked as minor-unit integer; see normaliseMinor()
  amount: ["max_amount", "authorized_amount", "amount", "total", "amount_minor"],
  expires: ["expires_at", "exp", "valid_until", "expiry"],
} as const;

// Canonical AP2 PaymentMandate type marker (vct = "mandate.payment.1"). When
// present, the payload is parsed precisely by extractPaymentMandateClaims (ADR 0008).
const PAYMENT_MANDATE_VCT_PREFIX = "mandate.payment";

function asRecord(v: unknown): JsonRecord | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function firstPresent(payload: JsonRecord, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (payload[k] !== undefined && payload[k] !== null) return payload[k];
  }
  return undefined;
}

/**
 * Normalise an amount value to integer minor units. Integers pass through
 * (already minor units, matching the VRP offer + Stripe convention).
 * Decimals are treated as major units and converted ×100. Amount may also
 * be an object like { value, currency }.
 */
function normaliseMinor(value: unknown): number | null {
  const coerce = (n: unknown): number | null => {
    if (typeof n === "number" && Number.isFinite(n)) {
      return Number.isInteger(n) ? n : Math.round(n * 100);
    }
    if (typeof n === "string" && n.trim() !== "" && !Number.isNaN(Number(n))) {
      const parsed = Number(n);
      return Number.isInteger(parsed) ? parsed : Math.round(parsed * 100);
    }
    return null;
  };
  const direct = coerce(value);
  if (direct !== null) return direct;
  const rec = asRecord(value);
  if (rec) return coerce(rec.value ?? rec.amount ?? rec.minor ?? rec.minor_units);
  return null;
}

function currencyFrom(amountRaw: unknown, payload: JsonRecord): string | null {
  const rec = asRecord(amountRaw);
  const fromAmount = rec ? rec.currency ?? rec.currency_code : undefined;
  const raw = fromAmount ?? firstPresent(payload, MANDATE_FIELD_CANDIDATES.currency);
  return typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : null;
}

function expiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // epoch seconds (~10 digits) vs ms (~13 digits)
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function normaliseDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Canonical AP2 PaymentMandate (SD-JWT generated schema; google-agentic-commerce/AP2
 * code/sdk/python/ap2/sdk/generated/payment_mandate.py — see ADR 0008). The payer/
 * agent's payment authorization carries: `vct`, `payee` {id,name,website},
 * `payment_amount` {amount:int minor units, currency}, `exp` (epoch), and
 * `transaction_id` (binds to the checkout/cart). Merchant identity binds via
 * `payee.website` (the host domain); amount is already integer minor units,
 * matching the VRP/Stripe convention directly.
 */
function extractPaymentMandateClaims(payload: JsonRecord): Ap2MandateClaims {
  const payee = asRecord(payload.payee);
  const merchantRaw =
    (payee && typeof payee.website === "string" && payee.website.trim() ? payee.website : null) ??
    (payee && typeof payee.id === "string" && payee.id.trim() ? payee.id : null);
  const amt = asRecord(payload.payment_amount);
  const minor =
    amt && typeof amt.amount === "number" && Number.isInteger(amt.amount) ? amt.amount : null;
  const currency =
    amt && typeof amt.currency === "string" && amt.currency.trim()
      ? amt.currency.trim().toUpperCase()
      : null;
  return {
    mandateType: typeof payload.vct === "string" ? payload.vct : null,
    maxAmountMinor: minor,
    currency,
    merchant: typeof merchantRaw === "string" ? normaliseDomain(merchantRaw) : null,
    cartId: typeof payload.transaction_id === "string" ? payload.transaction_id : null,
    expiresAtMs: expiryMs(payload.exp),
  };
}

/** Extract logical claims from a (signature-verified) mandate payload. */
export function extractMandateClaims(payload: JsonRecord): Ap2MandateClaims {
  // Canonical AP2 PaymentMandate is detected by its `vct` marker and parsed
  // precisely (ADR 0008). Any other shape falls back to the legacy candidates.
  if (
    typeof payload.vct === "string" &&
    payload.vct.startsWith(PAYMENT_MANDATE_VCT_PREFIX)
  ) {
    return extractPaymentMandateClaims(payload);
  }
  const amountRaw = firstPresent(payload, MANDATE_FIELD_CANDIDATES.amount);
  const merchant = firstPresent(payload, MANDATE_FIELD_CANDIDATES.merchant);
  const cartId = firstPresent(payload, MANDATE_FIELD_CANDIDATES.cartId);
  const mandateType = firstPresent(payload, MANDATE_FIELD_CANDIDATES.mandateType);
  const expires = firstPresent(payload, MANDATE_FIELD_CANDIDATES.expires);
  return {
    mandateType: typeof mandateType === "string" ? mandateType : null,
    maxAmountMinor: normaliseMinor(amountRaw),
    currency: currencyFrom(amountRaw, payload),
    merchant: typeof merchant === "string" ? normaliseDomain(merchant) : null,
    cartId: typeof cartId === "string" ? cartId : null,
    expiresAtMs: expiryMs(expires),
  };
}

/**
 * Verify an AP2 mandate JWS and decode its claims. Throws on signature
 * failure or malformed token (fail-closed).
 */
export function verifyAp2Mandate(
  mandateJws: string,
  issuerJwks: JsonRecord,
): { header: JsonRecord; payload: JsonRecord; claims: Ap2MandateClaims } {
  const { header, payload } = verifyCompactJws(mandateJws, issuerJwks);
  return { header, payload, claims: extractMandateClaims(payload) };
}

/**
 * Check that a (signature-verified) mandate authorizes a specific charge.
 * Fails closed: any missing constraint or mismatch → not authorized.
 */
export function mandateAuthorizesCharge(
  claims: Ap2MandateClaims,
  charge: Ap2ChargeContext,
  nowMs: number = Date.now(),
): Ap2AuthorizationResult {
  if (claims.expiresAtMs !== null && nowMs > claims.expiresAtMs) {
    return { authorized: false, reason: "mandate_expired", claims };
  }
  if (claims.maxAmountMinor === null) {
    return { authorized: false, reason: "mandate_missing_amount", claims };
  }
  if (!Number.isFinite(charge.amountMinor) || charge.amountMinor <= 0) {
    return { authorized: false, reason: "invalid_charge_amount", claims };
  }
  if (charge.amountMinor > claims.maxAmountMinor) {
    return { authorized: false, reason: "amount_exceeds_mandate", claims };
  }
  if (!claims.currency || claims.currency !== charge.currency.trim().toUpperCase()) {
    return { authorized: false, reason: "currency_mismatch", claims };
  }
  if (!claims.merchant || claims.merchant !== normaliseDomain(charge.merchantDomain)) {
    return { authorized: false, reason: "merchant_mismatch", claims };
  }
  if (charge.cartId && claims.cartId && claims.cartId !== charge.cartId) {
    return { authorized: false, reason: "cart_mismatch", claims };
  }
  return { authorized: true, claims };
}

/**
 * Full verify-and-authorize for the payment step: verify the mandate
 * signature against the issuer JWKS, then check it authorizes the charge.
 * Throws only on signature/parse failure; returns { authorized:false,
 * reason } for policy failures.
 */
export function verifyAp2CartMandate(
  mandateJws: string,
  issuerJwks: JsonRecord,
  charge: Ap2ChargeContext,
  nowMs: number = Date.now(),
): Ap2AuthorizationResult {
  const { claims } = verifyAp2Mandate(mandateJws, issuerJwks);
  return mandateAuthorizesCharge(claims, charge, nowMs);
}

/**
 * Resolve the issuer's Ed25519 JWKS from a mandate's jwks_uri (https only).
 * The payer's credentials provider publishes its keys; the merchant fetches
 * them to verify the mandate signature. Returns null if unavailable.
 */
export async function resolveAp2IssuerJwks(jwksUri: string): Promise<JsonRecord | null> {
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null; // no http / reduce SSRF surface
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VRP_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return null;
    return asRecord(await resp.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
