/**
 * Contract test for /.well-known/oauth-protected-resource (RFC 9728).
 *
 * Claude.ai fetches this URL after receiving a 401 + WWW-Authenticate from
 * /mcp (see src/mcp-www-authenticate.contract.test.ts). It uses the
 * `authorization_servers` array to bootstrap the OAuth flow.
 *
 * Run: npx tsx --test src/oauth-protected-resource.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "https://example.test";

async function callHandler(
  url = "/.well-known/oauth-protected-resource",
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const mod = await import("../api/oauth-protected-resource.js");
  const captured = { status: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
    status: (code: number) => { captured.status = code; return res; },
    json: (body: Record<string, unknown>) => { captured.body = body; return res; },
    end: () => res,
  };
  const req = {
    method: "GET",
    url,
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.test" },
  };
  await mod.default(req as never, res as never);
  return captured;
}

describe("oauth-protected-resource discovery (RFC 9728)", () => {
  it("returns 200 with cache + CORS headers", async () => {
    const r = await callHandler();
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "public, max-age=3600");
    assert.equal(r.headers["access-control-allow-origin"], "*");
  });

  it("declares the MCP JSON-RPC endpoint as the protected resource", async () => {
    const r = await callHandler();
    assert.equal(r.body.resource, `${BASE}/mcp`);
  });

  it("serves the same document at the RFC 9728 path-suffix URL: resource stays {base}/mcp, never {base}/mcp/mcp", async () => {
    const root = await callHandler("/.well-known/oauth-protected-resource");
    const suffix = await callHandler("/.well-known/oauth-protected-resource/mcp");
    assert.equal(suffix.body.resource, `${BASE}/mcp`);
    assert.deepEqual(suffix.body, root.body, "path-suffix and root documents must be byte-identical");
  });

  it("lists this deployment as the only authorization server", async () => {
    const r = await callHandler();
    assert.deepEqual(r.body.authorization_servers, [BASE]);
  });

  it("accepts bearer tokens only in the Authorization header", async () => {
    const r = await callHandler();
    assert.deepEqual(
      r.body.bearer_methods_supported,
      ["header"],
      "Form-body and URI-query bearer transports are deprecated (RFC 6750 §2.2, §2.3) and MUST NOT be advertised."
    );
  });

  it("advertises a single 'mcp' scope (matches authorization-server metadata)", async () => {
    const r = await callHandler();
    assert.deepEqual(r.body.scopes_supported, ["mcp"]);
  });

  it("includes resource_name for human-readable consent screens", async () => {
    const r = await callHandler();
    assert.equal(r.body.resource_name, "HemmaBo Host Booking Engine");
  });

  it("rejects non-GET methods with 405", async () => {
    const mod = await import("../api/oauth-protected-resource.js");
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
});
