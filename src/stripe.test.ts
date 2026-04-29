/**
 * Security unit tests.
 *
 * Run: npx tsx --test src/stripe.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDomain } from "./stripe.js";
import { validateApiKey } from "./auth.js";

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

describe("validateApiKey", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.MCP_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.MCP_API_KEY;
    } else {
      process.env.MCP_API_KEY = originalKey;
    }
  });

  // ── Open mode (no key configured) ─────────────────────────────

  it("allows any request when MCP_API_KEY is unset", () => {
    delete process.env.MCP_API_KEY;
    assert.equal(validateApiKey(undefined), null);
    assert.equal(validateApiKey("Bearer anything"), null);
    assert.equal(validateApiKey("wrong"), null);
  });

  // ── Valid key ──────────────────────────────────────────────────

  it("accepts a correct Bearer token", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer secret-key-123"), null);
  });

  it("rejects a token without Bearer prefix", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(
      validateApiKey("secret-key-123"),
      "Authorization required. Pass: Authorization: Bearer <key>"
    );
  });

  // ── Missing header ─────────────────────────────────────────────

  it("rejects missing Authorization header", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(
      validateApiKey(undefined),
      "Authorization required. Pass: Authorization: Bearer <key>"
    );
  });

  // ── Wrong key ─────────────────────────────────────────────────

  it("rejects a wrong token", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer wrong-key-456"), "Invalid API key");
  });

  it("rejects a token that is a prefix of the correct key", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer secret-key"), "Invalid API key");
  });

  it("rejects a token that extends the correct key", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer secret-key-123-extra"), "Invalid API key");
  });

  it("rejects an empty token", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer "), "Invalid API key");
  });

  it("rejects a token that differs by one character", () => {
    process.env.MCP_API_KEY = "secret-key-123";
    assert.equal(validateApiKey("Bearer secret-key-124"), "Invalid API key");
  });
});
