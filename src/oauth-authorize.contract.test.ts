/**
 * Contract test for /oauth/authorize (api/oauth-authorize.ts).
 *
 * The authorize endpoint touches Supabase on every meaningful request, so
 * full integration testing requires a live DB. This test runs at two
 * levels:
 *
 *   1. Wire-level drift guards (static source inspection) — confirm the
 *      handler enforces the security-critical invariants from ADR 0003:
 *        - S256-only PKCE (plain rejected)
 *        - exact-string redirect_uri allowlist (no open redirect)
 *        - guest-without-identity (no login lookups)
 *        - vercel.json rewrite exists
 *        - rate-limit wired on 'strict' tier
 *
 *   2. Behaviour at the perimeter — methods other than GET/POST return 405
 *      before any Supabase call, so we can assert that without a DB.
 *
 * Run: npx tsx --test src/oauth-authorize.contract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(resolve(REPO_ROOT, "api/oauth-authorize.ts"), "utf8");

// The handler does `createClient(requireEnv("SUPABASE_URL"), ...)` at module
// load. Provide dummy values so the import succeeds; the only behavioural
// assertion below (405 path) runs before any Supabase call is attempted.
let _origUrl: string | undefined;
let _origKey: string | undefined;
before(() => {
  _origUrl = process.env.SUPABASE_URL;
  _origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!_origUrl) process.env.SUPABASE_URL = "https://test.invalid";
  if (!_origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
});
after(() => {
  if (_origUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = _origUrl;
  if (_origKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = _origKey;
});

describe("oauth-authorize endpoint — wire-level drift guards", () => {
  it("vercel.json rewrites /oauth/authorize → /api/oauth-authorize", () => {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "vercel.json"), "utf8")) as {
      rewrites?: { source: string; destination: string }[];
    };
    const r = (cfg.rewrites ?? []).find(
      (rw) => rw.source === "/oauth/authorize" && rw.destination === "/api/oauth-authorize"
    );
    assert.ok(r, "Missing /oauth/authorize rewrite — Claude.ai will hit a 404 instead of the consent page.");
  });

  it("enforces S256-only PKCE (rejects code_challenge_method !== 'S256')", () => {
    assert.match(
      SRC,
      /code_challenge_method\s*!==\s*"S256"/,
      "Authorize endpoint must explicitly reject code_challenge_method other than S256 (ADR 0003 §2.2)."
    );
  });

  it("validates the code_challenge shape via lib/pkce", () => {
    assert.match(SRC, /isValidCodeChallenge/, "Must use lib/pkce.isValidCodeChallenge to enforce base64url SHA-256 shape.");
    assert.match(SRC, /from\s+"\.\.\/lib\/pkce\.js"/, "Must import from ../lib/pkce.js (single source of truth).");
  });

  it("requires exact-string redirect_uri allowlist match (anti open-redirect)", () => {
    assert.match(
      SRC,
      /registered\s*===\s*uri/,
      "redirect_uri MUST be compared with === against the client's registered allowlist (RFC 6749 §3.1.2.3). Substring or normalised matches are open-redirect bugs."
    );
  });

  it("renders the error page in-place when redirect_uri is invalid (never redirects)", () => {
    assert.match(
      SRC,
      /isRedirectUriAllowed[\s\S]{0,200}?renderErrorPage/,
      "When redirect_uri does not match the allowlist the handler must renderErrorPage — never call res.redirect to an unverified URI."
    );
  });

  it("checks client.grant_types includes 'authorization_code'", () => {
    assert.match(
      SRC,
      /grant_types[\s\S]{0,100}?includes\(\s*"authorization_code"\s*\)/,
      "Client must opt into the authorization_code grant in mcp_clients.grant_types — clients_credentials-only registrations must NOT reach the consent page."
    );
  });

  it("requires the client row to be is_active", () => {
    assert.match(SRC, /!data\.is_active/, "Must reject inactive clients.");
  });

  it("inserts into mcp_authorization_codes with S256 + 10min TTL", () => {
    assert.match(SRC, /"mcp_authorization_codes"/);
    assert.match(SRC, /code_challenge_method:\s*"S256"/);
    assert.match(SRC, /CODE_TTL_SECONDS\s*=\s*600/, "Authorization-code TTL must be 10 minutes (RFC 6749 §4.1.2).");
  });

  it("wires checkRateLimit on 'strict' tier", () => {
    assert.match(SRC, /checkRateLimit\(\s*"strict"/, "Authorize endpoint must use the strict rate-limit tier (#65).");
  });

  it("sets X-Frame-Options DENY + CSP frame-ancestors 'none' on the consent page (anti-clickjacking)", () => {
    assert.match(SRC, /X-Frame-Options[\s\S]{0,40}DENY/);
    assert.match(SRC, /frame-ancestors\s+'none'/);
  });

  it("does NOT set Access-Control-Allow-Origin (browser-rendered page, not CORS surface)", () => {
    assert.equal(
      /Access-Control-Allow-Origin/.test(SRC),
      false,
      "The consent page is reached by top-level browser navigation. CORS would let arbitrary JS read consent HTML."
    );
  });

  it("uses res.redirect with status 302 for error round-trip and success redirect", () => {
    assert.match(SRC, /res\.redirect\(\s*302/);
  });
});

describe("oauth-authorize endpoint — perimeter behaviour", () => {
  it("returns 405 for non-GET/non-POST methods (before any DB call)", async () => {
    const mod = await import("../api/oauth-authorize.js");
    let status = 0;
    let body: unknown;
    const res = {
      setHeader: () => {},
      status: (code: number) => { status = code; return res; },
      json: (b: unknown) => { body = b; return res; },
      send: () => res,
      redirect: () => res,
      end: () => res,
    };
    await mod.default(
      { method: "PUT", headers: {}, query: {} } as never,
      res as never,
    );
    assert.equal(status, 405);
    assert.deepEqual(body, { error: "method_not_allowed" });
  });
});
