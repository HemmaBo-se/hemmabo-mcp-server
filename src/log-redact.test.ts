import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeParams, redactMessage } from "../lib/log-redact.js";

describe("log redaction — guest PII (GDPR) + secrets", () => {
  it("redacts guestName (camelCase) — the original clear-text leak", () => {
    const out = sanitizeParams({ guestName: "Anna Svensson", guests: 6 });
    assert.equal(out.guestName, "[redacted]");
    // The guest COUNT is not PII — keep it for debugging.
    assert.equal(out.guests, 6);
  });

  it("redacts guest_name (snake_case) and other case styles", () => {
    assert.equal(sanitizeParams({ guest_name: "Anna" }).guest_name, "[redacted]");
    assert.equal(sanitizeParams({ "guest-name": "Anna" })["guest-name"], "[redacted]");
  });

  it("redacts email and phone regardless of case style", () => {
    const out = sanitizeParams({ guestEmail: "a@b.se", guestPhone: "+46701234567", guest_email: "x@y.se" });
    assert.equal(out.guestEmail, "[redacted]");
    assert.equal(out.guestPhone, "[redacted]");
    assert.equal(out.guest_email, "[redacted]");
  });

  it("redacts camelCase secret/token keys (sptToken, stripeToken)", () => {
    const out = sanitizeParams({ sptToken: "x", stripeToken: "y", authorization: "Bearer z" });
    assert.equal(out.sptToken, "[redacted]");
    assert.equal(out.stripeToken, "[redacted]");
    assert.equal(out.authorization, "[redacted]");
  });

  it("keeps non-PII fields untouched", () => {
    const out = sanitizeParams({ propertyId: "uuid-1", checkIn: "2026-07-01", region: "Skåne", guests: 4, domain: "villa.se" });
    assert.equal(out.propertyId, "uuid-1");
    assert.equal(out.region, "Skåne");
    assert.equal(out.domain, "villa.se");
    assert.equal(out.checkIn, "2026-07-01");
  });

  it("redacts nested PII (deep, not just top level)", () => {
    const out = sanitizeParams({ booking: { guestName: "Bo", nights: 3 } }) as { booking: Record<string, unknown> };
    assert.equal(out.booking.guestName, "[redacted]");
    assert.equal(out.booking.nights, 3);
  });

  it("value-based: redacts a Stripe key or email even in an unexpected field", () => {
    const out = sanitizeParams({ note: "contact a@b.se with key sk_live_abc123456 ok" });
    assert.equal(out.note, "contact [redacted] with key [redacted] ok");
  });

  it("redactMessage scrubs secrets/emails/JWTs from error text", () => {
    assert.equal(redactMessage("insert failed for guest a@b.se"), "insert failed for guest [redacted]");
    assert.equal(redactMessage("auth error: sk_live_deadbeef1234 denied"), "auth error: [redacted] denied");
    assert.equal(redactMessage(undefined), undefined);
    assert.equal(redactMessage(null), undefined);
  });
});
