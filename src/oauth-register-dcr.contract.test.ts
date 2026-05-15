/**
 * Drift-guard contract test for the extended /oauth/register endpoint
 * (api/oauth-register.ts) — RFC 7591 Dynamic Client Registration.
 *
 * Anthropic Claude.ai sends RFC 7591-shaped requests with redirect_uris,
 * grant_types and token_endpoint_auth_method. Before this PR the handler
 * silently ignored those fields and persisted every client as
 * client_credentials-only with empty redirect_uris[] — which made
 * /oauth/authorize refuse them. This test locks the new behaviour.
 *
 * Run: npx tsx --test src/oauth-register-dcr.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(resolve(REPO_ROOT, "api/oauth-register.ts"), "utf8");

describe("/oauth/register — accepts RFC 7591 fields", () => {
  it("reads redirect_uris from the request body", () => {
    assert.match(SRC, /body\.redirect_uris/);
  });
  it("reads grant_types from the request body", () => {
    assert.match(SRC, /body\.grant_types/);
  });
  it("reads token_endpoint_auth_method from the request body", () => {
    assert.match(SRC, /body\.token_endpoint_auth_method/);
  });

  it("persists redirect_uris, grant_types, token_endpoint_auth_method into mcp_clients", () => {
    assert.match(SRC, /redirect_uris:\s*redirectUris/);
    assert.match(SRC, /grant_types:\s*grantTypes/);
    assert.match(SRC, /token_endpoint_auth_method:\s*authMethod/);
  });

  it("validates each grant_type against the allowed set", () => {
    assert.match(SRC, /ALLOWED_GRANTS/);
    assert.match(SRC, /authorization_code/);
    assert.match(SRC, /refresh_token/);
    assert.match(SRC, /client_credentials/);
  });

  it("validates each token_endpoint_auth_method against the allowed set", () => {
    assert.match(SRC, /ALLOWED_AUTH_METHODS/);
  });

  it("requires redirect_uris when authorization_code is requested", () => {
    assert.match(
      SRC,
      /grantTypes\.includes\(\s*"authorization_code"\s*\)[\s\S]{0,200}?redirectUris\.length\s*===\s*0/,
      "authorization_code grant without redirect_uris must be rejected as invalid_redirect_uri (RFC 7591)."
    );
  });

  it("rejects token_endpoint_auth_method=none without authorization_code (PKCE required)", () => {
    assert.match(
      SRC,
      /authMethod\s*===\s*"none"[\s\S]{0,150}?!grantTypes\.includes\(\s*"authorization_code"/
    );
  });

  it("rejects javascript:, data:, vbscript: and file: redirect URI schemes", () => {
    assert.match(SRC, /javascript/);
    assert.match(SRC, /data/);
    assert.match(SRC, /vbscript/);
    assert.match(SRC, /file/);
  });

  it("allows http:// only for loopback (RFC 8252 §7.3)", () => {
    assert.match(SRC, /127\.0\.0\.1/);
    assert.match(SRC, /\[::1\]/);
    assert.match(SRC, /localhost/);
  });

  it("returns client_id_issued_at and client_secret_expires_at per RFC 7591 §3.2.1", () => {
    assert.match(SRC, /client_id_issued_at/);
    assert.match(SRC, /client_secret_expires_at/);
  });

  it("keeps legacy default (client_credentials only) for ChatGPT-style minimal registrations", () => {
    assert.match(
      SRC,
      /grantTypes\s*=\s*\[\s*"client_credentials"\s*\]/,
      "When grant_types is omitted, default to client_credentials so the ChatGPT Apps SDK track keeps working."
    );
  });

  it("never logs the plaintext client_secret", () => {
    // Scan each console.* call's argument list (up to the closing paren on the
    // same statement) for a reference to the local clientSecret binding.
    // Non-greedy + bounded so we don't span the whole file.
    const consoleCallsWithSecret = SRC.match(/console\.(?:log|error|warn|info|debug)\([^)]{0,400}\bclientSecret\b[^)]{0,400}\)/g);
    assert.equal(
      consoleCallsWithSecret,
      null,
      `client_secret must never be passed to console.* — only the hash is persisted, plaintext is returned once. Found: ${consoleCallsWithSecret}`
    );
  });
});
