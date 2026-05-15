/**
 * Contract test for the WWW-Authenticate header on POST /mcp.
 *
 * RFC 9728 §5.1 — when a protected resource returns 401, the response
 * MUST include `WWW-Authenticate: Bearer ... resource_metadata="<url>"`
 * pointing at the protected-resource metadata document. Without this
 * header, Anthropic Claude.ai cannot discover the authorization server
 * and the connector handshake terminates silently.
 *
 * The test forces the auth path by setting MCP_API_KEY (which puts
 * validateAuth in non-open mode) and POST-ing a tools/call request for
 * a non-anon tool with no Authorization header.
 *
 * Run: npx tsx --test src/mcp-www-authenticate.contract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

let prevApiKey: string | undefined;

before(() => {
  prevApiKey = process.env.MCP_API_KEY;
  // Any non-empty value flips validateAuth into auth-required mode.
  process.env.MCP_API_KEY = "test-master-key-for-contract-only";
});

after(() => {
  if (prevApiKey === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = prevApiKey;
});

async function postUnauthenticatedToolsCall() {
  const mod = await import("../api/mcp.js");
  const captured = {
    status: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const res = {
    setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
    status: (code: number) => { captured.status = code; return res; },
    json: (body: unknown) => { captured.body = body; return res; },
    end: () => res,
  };
  const req = {
    method: "POST",
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "example.test",
      "content-type": "application/json",
    },
    // tools/call for a non-anon tool → requires auth.
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hemmabo_booking_checkout", arguments: {} },
    },
  };
  await mod.default(req as never, res as never);
  return captured;
}

describe("WWW-Authenticate header on /mcp 401 (RFC 9728 §5.1)", () => {
  it("returns 401 when an auth-required tool is called without Authorization", async () => {
    const r = await postUnauthenticatedToolsCall();
    assert.equal(r.status, 401, "Unauthenticated booking call must 401.");
  });

  it("emits a Bearer WWW-Authenticate header that points at the protected-resource metadata", async () => {
    const r = await postUnauthenticatedToolsCall();
    const header = r.headers["www-authenticate"];
    assert.ok(header, "WWW-Authenticate header is required on 401 per RFC 9728 §5.1");
    assert.match(header, /^Bearer /, "Scheme must be Bearer (case-sensitive per RFC 6750).");
    assert.match(
      header,
      /resource_metadata="https:\/\/example\.test\/\.well-known\/oauth-protected-resource"/,
      "resource_metadata must be the absolute URL of the protected-resource metadata document."
    );
    assert.match(header, /realm="hemmabo-mcp"/, "realm should identify this MCP server.");
  });
});
