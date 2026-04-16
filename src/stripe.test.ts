/**
 * Tests for sanitizeDomain — guards Stripe redirect URLs against open-redirect
 * injection via a malicious or compromised properties.domain value.
 *
 * Run: npx tsx --test src/stripe.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDomain } from "./stripe.js";

const FALLBACK = "hemmabo.se";

describe("sanitizeDomain", () => {
  // ── Valid domains ──────────────────────────────────────────────

  it("accepts a plain hostname", () => {
    assert.equal(sanitizeDomain("villaaakerlyckan.se"), "villaaakerlyckan.se");
  });

  it("accepts a subdomain", () => {
    assert.equal(sanitizeDomain("booking.villaaakerlyckan.se"), "booking.villaaakerlyckan.se");
  });

  it("accepts a hostname with port", () => {
    assert.equal(sanitizeDomain("example.com:8080"), "example.com:8080");
  });

  it("strips an accidental https:// prefix and accepts the remainder", () => {
    assert.equal(sanitizeDomain("https://villaaakerlyckan.se"), "villaaakerlyckan.se");
  });

  it("strips an accidental http:// prefix and accepts the remainder", () => {
    assert.equal(sanitizeDomain("http://example.com"), "example.com");
  });

  // ── Null / empty ───────────────────────────────────────────────

  it("returns fallback for null", () => {
    assert.equal(sanitizeDomain(null), FALLBACK);
  });

  it("returns fallback for undefined", () => {
    assert.equal(sanitizeDomain(undefined), FALLBACK);
  });

  it("returns fallback for empty string", () => {
    assert.equal(sanitizeDomain(""), FALLBACK);
  });

  // ── Open-redirect attack vectors ───────────────────────────────

  it("rejects a domain with a path component", () => {
    // e.g. "evil.com/x?foo=" would produce https://evil.com/x?foo=/booking/success
    assert.equal(sanitizeDomain("evil.com/x?foo="), FALLBACK);
  });

  it("rejects a domain with a query string", () => {
    assert.equal(sanitizeDomain("evil.com?redirect="), FALLBACK);
  });

  it("rejects credential injection (user@host)", () => {
    // https://evil.com@legit.se/ — browser resolves to evil.com
    assert.equal(sanitizeDomain("evil.com@legit.se"), FALLBACK);
  });

  it("rejects a fragment", () => {
    assert.equal(sanitizeDomain("evil.com#"), FALLBACK);
  });

  it("rejects a full URL with path", () => {
    assert.equal(sanitizeDomain("https://evil.com/phish"), FALLBACK);
  });

  it("rejects a URL with credentials embedded", () => {
    assert.equal(sanitizeDomain("https://user:pass@evil.com"), FALLBACK);
  });

  it("rejects a newline (CRLF injection attempt)", () => {
    assert.equal(sanitizeDomain("evil.com\r\nX-Injected: header"), FALLBACK);
  });

  it("rejects a null byte", () => {
    assert.equal(sanitizeDomain("evil.com\x00"), FALLBACK);
  });

  // ── Private / loopback ranges ──────────────────────────────────

  it("rejects localhost", () => {
    assert.equal(sanitizeDomain("localhost"), FALLBACK);
  });

  it("rejects 127.0.0.1", () => {
    assert.equal(sanitizeDomain("127.0.0.1"), FALLBACK);
  });

  it("rejects 10.0.0.1 (RFC-1918)", () => {
    assert.equal(sanitizeDomain("10.0.0.1"), FALLBACK);
  });

  it("rejects 192.168.1.1 (RFC-1918)", () => {
    assert.equal(sanitizeDomain("192.168.1.1"), FALLBACK);
  });

  it("rejects 172.16.0.1 (RFC-1918)", () => {
    assert.equal(sanitizeDomain("172.16.0.1"), FALLBACK);
  });
});
