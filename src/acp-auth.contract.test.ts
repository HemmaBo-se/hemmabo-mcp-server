/**
 * Contract test for #67 — auth gate on /acp endpoints.
 *
 * Locks the privacy contract from ADR 0002 §2.3:
 *   PII is returned only to protected callers.
 *
 * What this tests:
 *   - Discovery (GET /acp) is public (no auth required).
 *   - Every checkout-scoped request (GET, POST, PUT on /acp/checkouts/:id and
 *     POST on /acp/checkouts) requires Authorization when MCP_API_KEY is set.
 *   - The handler must NOT short-circuit auth based on HTTP method.
 *
 * This test runs against the live handler with MCP_API_KEY set in env. It
 * does not need a Supabase or Stripe connection because every protected
 * request short-circuits on the auth check before any I/O.
 *
 * Run: npx tsx --test src/acp-auth.contract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const TEST_API_KEY = "contract-test-key-do-not-use-in-prod";
let originalApiKey: string | undefined;

before(() => {
  originalApiKey = process.env.MCP_API_KEY;
  process.env.MCP_API_KEY = TEST_API_KEY;
});

after(() => {
  if (originalApiKey === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = originalApiKey;
});

// Minimal req/res doubles matching the Vercel handler surface used by api/acp.ts.
interface MockReq {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => MockRes;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
}

function makeReq(method: string, path: string, headers: Record<string, string> = {}): MockReq {
  return {
    method,
    url: path,
    headers: { host: "test.local", ...headers },
  };
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

async function callHandler(req: MockReq): Promise<MockRes> {
  const mod = await import("../api/acp.js");
  const handler = mod.default;
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handler(req as any, res as any);
  return res;
}

describe("ACP auth contract (#67)", () => {
  it("GET /acp (discovery) is public — no auth required", async () => {
    const res = await callHandler(makeReq("GET", "/acp"));
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { protocol?: string }).protocol, "agentic-commerce-protocol");
  });

  it("GET /acp/checkouts/:id without Authorization returns 401", async () => {
    const res = await callHandler(makeReq("GET", "/acp/checkouts/00000000-0000-0000-0000-000000000000"));
    assert.equal(res.statusCode, 401);
  });

  it("GET /acp/checkouts/:id with wrong key returns 401", async () => {
    const res = await callHandler(
      makeReq("GET", "/acp/checkouts/00000000-0000-0000-0000-000000000000", {
        authorization: "Bearer wrong-key",
      }),
    );
    assert.equal(res.statusCode, 401);
  });

  it("401 response body contains no PII-shaped field (email, phone)", async () => {
    const res = await callHandler(makeReq("GET", "/acp/checkouts/00000000-0000-0000-0000-000000000000"));
    const body = JSON.stringify(res.body ?? {});
    assert.ok(!/@/.test(body), `401 body must not contain email-shaped value: ${body}`);
    assert.ok(!/\+?\d{6,}/.test(body), `401 body must not contain phone-shaped value: ${body}`);
  });

  it("POST /acp/checkouts (create) without Authorization returns 401", async () => {
    const res = await callHandler(makeReq("POST", "/acp/checkouts"));
    assert.equal(res.statusCode, 401);
  });

  it("PUT /acp/checkouts/:id without Authorization returns 401", async () => {
    const res = await callHandler(makeReq("PUT", "/acp/checkouts/00000000-0000-0000-0000-000000000000"));
    assert.equal(res.statusCode, 401);
  });

  it("POST /acp/checkouts/:id/complete without Authorization returns 401", async () => {
    const res = await callHandler(
      makeReq("POST", "/acp/checkouts/00000000-0000-0000-0000-000000000000/complete"),
    );
    assert.equal(res.statusCode, 401);
  });

  it("POST /acp/checkouts/:id/cancel without Authorization returns 401", async () => {
    const res = await callHandler(
      makeReq("POST", "/acp/checkouts/00000000-0000-0000-0000-000000000000/cancel"),
    );
    assert.equal(res.statusCode, 401);
  });

  it("OPTIONS preflight bypasses auth and returns 204", async () => {
    const res = await callHandler(makeReq("OPTIONS", "/acp/checkouts/anything"));
    assert.equal(res.statusCode, 204);
  });
});
