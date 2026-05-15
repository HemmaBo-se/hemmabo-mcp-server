/**
 * Unit tests for lib/pkce.ts (RFC 7636).
 *
 * Pure cryptographic helpers — no DB, no HTTP. Locks the S256 wire format
 * (BASE64URL(SHA256(verifier)) with no padding) and verifier/challenge
 * shape constraints so a future "fix" to base64 handling cannot silently
 * break Anthropic's PKCE handshake.
 *
 * Run: npx tsx --test src/pkce.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidCodeChallenge,
  isValidCodeVerifier,
  s256,
  verifyS256,
} from "../lib/pkce.js";

describe("PKCE S256 (RFC 7636)", () => {
  // Test vector from RFC 7636 Appendix B:
  //   code_verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  //   code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const RFC_VERIFIER  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches the RFC 7636 Appendix B test vector", () => {
    assert.equal(s256(RFC_VERIFIER), RFC_CHALLENGE);
  });

  it("verifyS256 returns true for the canonical pair", () => {
    assert.equal(verifyS256(RFC_VERIFIER, RFC_CHALLENGE), true);
  });

  it("verifyS256 returns false for a wrong verifier (no exception)", () => {
    assert.equal(
      verifyS256("a".repeat(43), RFC_CHALLENGE),
      false
    );
  });

  it("verifyS256 returns false for a malformed challenge (no exception)", () => {
    assert.equal(verifyS256(RFC_VERIFIER, "too-short"), false);
    assert.equal(verifyS256(RFC_VERIFIER, ""), false);
  });

  it("verifyS256 returns false for a malformed verifier", () => {
    assert.equal(verifyS256("short", RFC_CHALLENGE), false);
    assert.equal(verifyS256("contains spaces!!!!!!!!!!!!!!!!!!!!!!!!!!!", RFC_CHALLENGE), false);
  });

  it("isValidCodeVerifier enforces 43..128 chars from the unreserved set", () => {
    assert.equal(isValidCodeVerifier("a".repeat(42)), false, "too short");
    assert.equal(isValidCodeVerifier("a".repeat(43)), true, "min length");
    assert.equal(isValidCodeVerifier("a".repeat(128)), true, "max length");
    assert.equal(isValidCodeVerifier("a".repeat(129)), false, "too long");
    assert.equal(isValidCodeVerifier("has spaces" + "a".repeat(40)), false);
    assert.equal(isValidCodeVerifier("contains/slash" + "a".repeat(40)), false);
  });

  it("isValidCodeChallenge requires exactly 43 base64url chars (sha256 digest length)", () => {
    assert.equal(isValidCodeChallenge(RFC_CHALLENGE), true);
    assert.equal(isValidCodeChallenge("a".repeat(43)), true);
    assert.equal(isValidCodeChallenge("a".repeat(42)), false);
    assert.equal(isValidCodeChallenge("a".repeat(44)), false);
    assert.equal(isValidCodeChallenge("contains+plus" + "a".repeat(30)), false, "+ is base64 std, not base64url");
    assert.equal(isValidCodeChallenge("contains/slash" + "a".repeat(29)), false);
    assert.equal(isValidCodeChallenge("padded=" + "a".repeat(36)), false);
  });

  it("s256 output has no base64 padding and uses url-safe alphabet", () => {
    const out = s256("x".repeat(43));
    assert.ok(!out.includes("="), "no padding");
    assert.ok(!out.includes("+"), "no plus");
    assert.ok(!out.includes("/"), "no slash");
    assert.equal(out.length, 43);
  });
});
