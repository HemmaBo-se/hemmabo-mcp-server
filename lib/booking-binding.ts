/**
 * Per-booking ownership binding (BOLA closure).
 *
 * A valid Bearer token AUTHENTICATES the caller but carries no per-booking
 * AUTHORITY: MCP_API_KEY is a shared master key and OAuth access tokens are
 * client-scoped (mcp_clients / mcp_access_tokens), never booking-scoped. So
 * without an object-level check, any authenticated caller who knows a
 * reservationId / checkoutId could cancel, reschedule, or read the PII of ANY
 * booking — classic Broken Object Level Authorization.
 *
 * The bind key is the booking's own `guest_token`
 * (bookings.guest_token: `UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE`),
 * a high-entropy per-row secret that already exists on every booking. It is
 * handed to the caller ONCE, when the booking is created, and must be
 * presented back on every mutating or PII-returning call. A caller who only
 * knows the reservationId (which can leak in URLs, emails, or prior tool
 * responses) cannot act on the booking.
 *
 * This module holds ONLY the comparison. The Bearer gate stays exactly as it
 * is; this binding sits on top of it.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Does the presented per-booking secret match the stored `guest_token`?
 *
 * Fail-closed: a non-string / blank presented value, a missing stored token,
 * or a length mismatch all return false. The compare is constant-time so a
 * wrong token cannot be recovered byte-by-byte by timing the response.
 */
export function bookingTokenMatches(presented: unknown, stored: unknown): boolean {
  if (typeof presented !== "string" || typeof stored !== "string") return false;
  const a = presented.trim();
  const b = stored.trim();
  if (a.length === 0 || b.length === 0) return false;

  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against self so the reject path costs the same regardless of
    // which side was longer — never branch out early on the length alone.
    try {
      timingSafeEqual(aBuf, aBuf);
    } catch {
      /* noop */
    }
    return false;
  }
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Caller-facing refusal text for a missing/mismatched per-booking secret.
 * Deliberately does NOT confirm whether the booking exists — a wrong token and
 * an unknown id return the same message, so the gate is not an existence
 * oracle.
 */
export const BOOKING_TOKEN_MISMATCH_MESSAGE =
  "guestToken does not match this booking. The guestToken returned when the booking was created is required to view or modify it; a Bearer token alone is not sufficient.";
