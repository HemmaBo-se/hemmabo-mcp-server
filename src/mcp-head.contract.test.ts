/**
 * Contract test for HEAD /mcp.
 *
 * Some uptime monitors and crawlers probe liveness with HEAD instead of GET.
 * Returning 405 creates avoidable production log noise even though the MCP
 * transport is healthy. HEAD should be a cheap 200 with the normal transport
 * headers and no response body.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

async function headMcp() {
  const mod = await import("../api/mcp.js");
  const captured = {
    status: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
  };
  const res = {
    setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
    status: (code: number) => { captured.status = code; return res; },
    json: (body: unknown) => { captured.body = body; return res; },
    end: () => { captured.ended = true; return res; },
  };
  const req = {
    method: "HEAD",
    headers: {
      host: "example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "example.test",
    },
    body: undefined,
  };
  await mod.default(req as never, res as never);
  return captured;
}

describe("HEAD /mcp liveness", () => {
  it("returns 200 without a body for liveness probes", async () => {
    const r = await headMcp();
    assert.equal(r.status, 200);
    assert.equal(r.ended, true);
    assert.equal(r.body, undefined);
  });

  it("advertises HEAD in the allowed MCP methods", async () => {
    const r = await headMcp();
    assert.match(r.headers["access-control-allow-methods"], /\bHEAD\b/);
  });
});
