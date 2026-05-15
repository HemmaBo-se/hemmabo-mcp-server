/**
 * Drift-guard contract test for the extended /oauth/token endpoint
 * (api/oauth.ts) — authorization_code and refresh_token grants.
 *
 * The token endpoint touches Supabase on every meaningful request so this
 * test runs at the source-code + perimeter level (same pattern as
 * src/oauth-authorize.contract.test.ts). It guards the security-critical
 * invariants from ADR 0003 §2.2:
 *
 *   - All three grants are wired (client_credentials, authorization_code,
 *     refresh_token). If any grant is silently removed, Anthropic's flow
 *     breaks.
 *   - PKCE verification goes through lib/pkce (single source of truth).
 *   - Authorization codes are single-use (used_at check) and bound to the
 *     redirect_uri that issued them.
 *   - Refresh tokens are stored as SHA-256 hashes, not plaintext.
 *   - Refresh tokens rotate on every use and replay is detected.
 *   - Public PKCE clients (token_endpoint_auth_method=none) are recognised.
 *   - timingSafeCompare is used for client_secret check.
 *
 * Run: npx tsx --test src/oauth-token-grants.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(resolve(REPO_ROOT, "api/oauth.ts"), "utf8");

describe("/oauth/token — three grants wired", () => {
  it("dispatches grant_type=client_credentials", () => {
    assert.match(SRC, /grantType\s*===\s*"client_credentials"/);
  });
  it("dispatches grant_type=authorization_code", () => {
    assert.match(SRC, /grantType\s*===\s*"authorization_code"/);
  });
  it("dispatches grant_type=refresh_token", () => {
    assert.match(SRC, /grantType\s*===\s*"refresh_token"/);
  });
  it("rejects any other grant with unsupported_grant_type", () => {
    assert.match(SRC, /unsupported_grant_type/);
  });
});

describe("/oauth/token — authorization_code grant invariants", () => {
  it("verifies PKCE via lib/pkce.verifyS256 (single source of truth)", () => {
    assert.match(SRC, /verifyS256\(/);
    assert.match(SRC, /from\s+"\.\.\/lib\/pkce\.js"/);
  });
  it("checks the code is single-use (used_at must be null)", () => {
    assert.match(SRC, /codeRow\.used_at/);
  });
  it("checks the code has not expired", () => {
    assert.match(SRC, /codeRow\.expires_at[\s\S]{0,60}new Date\(\)/);
  });
  it("checks the code's redirect_uri matches the request's redirect_uri exactly", () => {
    assert.match(SRC, /codeRow\.redirect_uri\s*!==\s*params\.redirect_uri/);
  });
  it("checks the code was issued to the authenticated client", () => {
    assert.match(SRC, /codeRow\.client_id\s*!==\s*auth\.client\.id/);
  });
  it("requires PKCE method S256 on the code itself", () => {
    assert.match(SRC, /code_challenge_method\s*!==\s*"S256"/);
  });
  it("atomically claims the code by updating used_at WHERE used_at IS NULL", () => {
    assert.match(SRC, /\.update\(\s*{\s*used_at:[\s\S]{0,200}?\.is\(\s*"used_at"\s*,\s*null\s*\)/);
  });
});

describe("/oauth/token — refresh_token grant invariants", () => {
  it("looks up refresh tokens by SHA-256 hash, never by plaintext", () => {
    assert.match(SRC, /hashRefreshToken\([^)]*params\.refresh_token[^)]*\)/);
    assert.match(SRC, /createHash\(\s*"sha256"\s*\)/);
    // The select must filter by token_hash, not by token.
    assert.match(SRC, /\.from\(\s*"mcp_refresh_tokens"\s*\)[\s\S]{0,400}?\.eq\(\s*"token_hash"/);
  });
  it("rejects refresh tokens issued to a different client", () => {
    assert.match(SRC, /row\.client_id\s*!==\s*auth\.client\.id/);
  });
  it("rejects expired refresh tokens", () => {
    assert.match(SRC, /row\.expires_at[\s\S]{0,60}new Date\(\)/);
  });
  it("detects replay of a revoked-and-rotated token (RFC 6749 §10.4)", () => {
    assert.match(SRC, /row\.revoked_at[\s\S]{0,300}?row\.rotated_to/);
    assert.match(SRC, /replay/i);
  });
  it("rotates: issues new refresh, marks old as revoked_at + sets rotated_to", () => {
    assert.match(
      SRC,
      /\.update\(\s*{\s*revoked_at:[\s\S]{0,200}?rotated_to:\s*refresh\.id/,
      "Old refresh row must be updated with both revoked_at AND rotated_to in the same UPDATE so the chain is auditable."
    );
  });
  it("only revokes rows that are still live (race-safe)", () => {
    assert.match(
      SRC,
      /\.update\(\s*{\s*revoked_at:[\s\S]{0,200}?\.is\(\s*"revoked_at"\s*,\s*null\s*\)/,
    );
  });
});

describe("/oauth/token — client authentication", () => {
  it("recognises public PKCE clients (token_endpoint_auth_method='none')", () => {
    assert.match(SRC, /token_endpoint_auth_method\s*===\s*"none"/);
  });
  it("uses timing-safe comparison on client_secret", () => {
    assert.match(SRC, /timingSafeEqual/);
    assert.match(SRC, /timingSafeCompare/);
  });
  it("enforces that the client opted into each grant via mcp_clients.grant_types", () => {
    assert.match(SRC, /grant_types\.includes\(\s*"client_credentials"/);
    assert.match(SRC, /grant_types\.includes\(\s*"authorization_code"/);
    assert.match(SRC, /grant_types\.includes\(\s*"refresh_token"/);
  });
});

describe("/oauth/token — TTLs and response shape", () => {
  it("issues access tokens with 1-hour TTL (3600 seconds)", () => {
    assert.match(SRC, /ACCESS_TOKEN_TTL_SECONDS\s*=\s*3600/);
  });
  it("issues refresh tokens with 30-day TTL", () => {
    assert.match(SRC, /REFRESH_TOKEN_TTL_SECONDS\s*=\s*30\s*\*\s*24\s*\*\s*3600/);
  });
});
