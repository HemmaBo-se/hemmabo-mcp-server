/**
 * Contract test for /.well-known/oauth-authorization-server (RFC 8414).
 *
 * Anthropic Claude.ai connectors load this document to discover the
 * authorization, token, registration and revocation endpoints. Drift in any
 * field name or value would silently break the connector flow with no
 * visible error in our logs — only Anthropic would see "OAuth discovery
 * failed" and reject the submission.
 *
 * Locks:
 *   - Required RFC 8414 fields are present and have the right type.
 *   - Endpoint URLs match the request-derived base URL (so preview deploys
 *     and self-hosted forks self-describe correctly).
 *   - Advertised grants, code-challenge methods and auth methods match
 *     ADR 0003 §2.2 — extending or shrinking the surface must come with a
 *     deliberate update to this test.
 *
 * Run: npx tsx --test src/oauth-authorization-server.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "https://example.test";

async function callHandler(): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const mod = await import("../api/oauth-authorization-server.js");
  const captured = { status: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
    status: (code: number) => { captured.status = code; return res; },
    json: (body: Record<string, unknown>) => { captured.body = body; return res; },
    end: () => res,
  };
  const req = {
    method: "GET",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.test" },
  };
  await mod.default(req as never, res as never);
  return captured;
}

describe("oauth-authorization-server discovery (RFC 8414)", () => {
  it("returns 200 with application/json and cache headers", async () => {
    const r = await callHandler();
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "public, max-age=3600");
    assert.equal(r.headers["access-control-allow-origin"], "*");
  });

  it("declares issuer = base URL (no trailing slash, request-derived)", async () => {
    const r = await callHandler();
    assert.equal(r.body.issuer, BASE);
  });

  it("advertises authorization, token, registration and revocation endpoints under base URL", async () => {
    const r = await callHandler();
    assert.equal(r.body.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(r.body.token_endpoint,         `${BASE}/oauth/token`);
    assert.equal(r.body.registration_endpoint,  `${BASE}/oauth/register`);
    assert.equal(r.body.revocation_endpoint,    `${BASE}/oauth/revoke`);
  });

  it("supports exactly the three grants from ADR 0003 §2.2", async () => {
    const r = await callHandler();
    assert.deepEqual(
      r.body.grant_types_supported,
      ["authorization_code", "refresh_token", "client_credentials"],
      "Changing the supported grants is a contract change — update ADR 0003 §2.2 in the same PR."
    );
  });

  it("supports response_type=code only (no implicit, no token)", async () => {
    const r = await callHandler();
    assert.deepEqual(r.body.response_types_supported, ["code"]);
    assert.deepEqual(r.body.response_modes_supported, ["query"]);
  });

  it("requires PKCE S256 (plain is rejected per ADR 0003 §2.2)", async () => {
    const r = await callHandler();
    assert.deepEqual(r.body.code_challenge_methods_supported, ["S256"]);
  });

  it("advertises client_secret_post, client_secret_basic and none (public PKCE clients)", async () => {
    const r = await callHandler();
    assert.deepEqual(
      r.body.token_endpoint_auth_methods_supported,
      ["client_secret_post", "client_secret_basic", "none"]
    );
  });

  it("advertises a single 'mcp' scope", async () => {
    const r = await callHandler();
    assert.deepEqual(r.body.scopes_supported, ["mcp"]);
  });

  it("rejects non-GET methods with 405", async () => {
    const mod = await import("../api/oauth-authorization-server.js");
    let status = 200;
    const res = {
      setHeader: () => {},
      status: (code: number) => { status = code; return res; },
      json: () => res,
      end: () => res,
    };
    await mod.default(
      { method: "POST", headers: {} } as never,
      res as never,
    );
    assert.equal(status, 405);
  });

  it("answers OPTIONS preflight with 204", async () => {
    const mod = await import("../api/oauth-authorization-server.js");
    let status = 200;
    const res = {
      setHeader: () => {},
      status: (code: number) => { status = code; return res; },
      json: () => res,
      end: () => res,
    };
    await mod.default(
      { method: "OPTIONS", headers: {} } as never,
      res as never,
    );
    assert.equal(status, 204);
  });
});
