/**
 * PKCE (RFC 7636) helpers.
 *
 * Extracted from the OAuth endpoints so the cryptographic comparison can be
 * unit-tested in isolation. Production callers:
 *   - api/oauth-authorize.ts  → validateCodeChallenge
 *   - api/oauth.ts            → verifyPkce on authorization_code redemption
 *
 * Only S256 is implemented; `plain` is rejected upstream per ADR 0003 §2.2.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc7636
 */

import { createHash, timingSafeEqual } from "crypto";

// RFC 7636 §4.1: code_verifier = 43..128 unreserved chars [A-Z a-z 0-9 - . _ ~]
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

// RFC 7636 §4.2: code_challenge for S256 is BASE64URL(SHA256(verifier)).
// The encoded SHA-256 digest is 43 chars (32 bytes → 43 base64url chars,
// no padding). It uses the same unreserved alphabet so we reuse the regex
// shape with a fixed length.
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

/**
 * Validate the shape of a code_challenge submitted to /oauth/authorize.
 * Does NOT verify against any verifier — that happens later at token redemption.
 */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

/**
 * Validate the shape of a code_verifier submitted to /oauth/token.
 */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && VERIFIER_RE.test(verifier);
}

/**
 * Compute the S256 code_challenge from a code_verifier.
 * Returns the BASE64URL-encoded SHA-256 digest (no padding).
 */
export function s256(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Constant-time verification that `verifier` hashes to `expectedChallenge`
 * using S256. Returns false (without timing leak) if either input is malformed.
 */
export function verifyS256(verifier: string, expectedChallenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(expectedChallenge)) {
    return false;
  }
  const actual = Buffer.from(s256(verifier), "utf8");
  const expected = Buffer.from(expectedChallenge, "utf8");
  if (actual.length !== expected.length) {
    timingSafeEqual(actual, actual);
    return false;
  }
  return timingSafeEqual(actual, expected);
}
