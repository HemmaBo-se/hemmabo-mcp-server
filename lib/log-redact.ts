/**
 * Shared log redaction — single source for the MCP server (api/mcp.ts) (mirror of the
 * #63 single-source discipline for tool defs). GDPR-first: guest PII (name / email /
 * phone / address) and secrets (Stripe keys, JWTs, tokens) must NEVER reach logs in
 * clear text — not in params, not in error messages.
 *
 * Three layers, because key-name matching alone bit us:
 *  1. Key-based, NORMALIZED — lowercase + strip non-alphanumerics so camelCase
 *     (`guestName`) AND snake_case (`guest_name`) both match. The original bug:
 *     `"guestname".includes("guest_name") === false` → guest names logged in clear text.
 *  2. Value-based — redact secret/PII patterns in string values regardless of key name
 *     (a secret in an unexpectedly-named field, or inside an error message).
 *  3. Deep — recurse into nested objects/arrays (the original sanitizer was top-level only).
 */

// Normalized key fragments. A key is redacted if its normalized form contains any.
// NOTE: "guests" (the integer COUNT) deliberately does NOT match — no name/email/etc —
// so useful debug context is kept; guestName / guestEmail / guestPhone all match.
const REDACT_KEY_PARTS = [
  "name", "email", "phone", "address", "dateofbirth", "dob",
  "token", "secret", "password", "passwd", "apikey", "authorization", "bearer",
  "card", "cardnumber", "cvv", "cvc", "ssn", "iban", "stripe", "whsec",
];

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Value patterns redacted regardless of key name (also applied to error messages).
const VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk|spt|whsec)_[A-Za-z0-9_]{6,}/gi,                      // Stripe-style keys/tokens (sk_live_…, whsec_…)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,  // JWT (header.payload.sig)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,              // email address
];

const REDACTED = "[redacted]";

function redactValue(v: unknown): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const re of VALUE_PATTERNS) s = s.replace(re, REDACTED);
    return s;
  }
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") return redactObject(v as Record<string, unknown>);
  return v;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const nk = normalizeKey(k);
    out[k] = REDACT_KEY_PARTS.some((p) => nk.includes(p)) ? REDACTED : redactValue(v);
  }
  return out;
}

/** Redact a params object before logging: key-based + value-based + deep. */
export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return redactObject(params ?? {});
}

/** Redact an error message before logging (value-based patterns: secrets, JWTs, emails). */
export function redactMessage(msg: string | undefined | null): string | undefined {
  if (msg == null) return undefined;
  return redactValue(String(msg)) as string;
}
