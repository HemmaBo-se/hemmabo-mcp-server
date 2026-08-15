/**
 * Contract test — per-booking ownership binding (BOLA closure) on the ACP
 * checkout-scoped routes.
 *
 * Sibling of acp-auth.contract.test.ts (#67). That test locks the Bearer gate;
 * this one locks the object-level gate that sits on top of it: an authenticated
 * caller (valid Bearer) still may NOT read or mutate an arbitrary checkout —
 * every checkout-scoped request must present the booking's own guest_token via
 * the `X-Guest-Token` header. Missing or wrong token → 403, fail-closed.
 *
 * Hermetic by construction:
 *   - A valid Bearer (MCP_API_KEY) passes auth without any DB (constant-time
 *     key compare).
 *   - A MISSING X-Guest-Token is refused before any I/O.
 *   - A WRONG X-Guest-Token forces the ownership lookup; with Supabase env
 *     unset the lookup fails and the gate denies (fail-closed) — so no live DB
 *     is needed to prove the reject path.
 *   - The public discovery doc (no checkoutId) is unaffected.
 *
 * Run: npx tsx --test src/acp-ownership-binding.contract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const TEST_API_KEY = "contract-test-key-do-not-use-in-prod";
const CHECKOUT = "00000000-0000-0000-0000-000000000000";

let saved: Record<string, string | undefined> = {};

before(() => {
  saved = {
    MCP_API_KEY: process.env.MCP_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.MCP_API_KEY = TEST_API_KEY;
  // Unset Supabase env so the ownership lookup on the wrong-token path fails
  // and the gate denies (fail-closed) without a live database.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

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

function makeReq(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): MockReq {
  return { method, url: path, headers: { host: "test.local", ...headers }, body };
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  return res;
}
async function callHandler(req: MockReq): Promise<MockRes> {
  const mod = await import("../api/acp.js");
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mod.default(req as any, res as any);
  return res;
}

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

// Every checkout-scoped route with a VALID Bearer but no per-booking proof.
const SCOPED: Array<{ label: string; req: () => MockReq }> = [
  { label: "GET /acp/checkouts/:id", req: () => makeReq("GET", `/acp/checkouts/${CHECKOUT}`, AUTH) },
  { label: "PUT /acp/checkouts/:id", req: () => makeReq("PUT", `/acp/checkouts/${CHECKOUT}`, AUTH, { guests: 3 }) },
  { label: "POST /acp/checkouts/:id/complete", req: () => makeReq("POST", `/acp/checkouts/${CHECKOUT}/complete`, AUTH, { payment_data: { token: "spt_x" } }) },
  { label: "POST /acp/checkouts/:id/cancel", req: () => makeReq("POST", `/acp/checkouts/${CHECKOUT}/cancel`, AUTH) },
];

describe("ACP per-booking ownership binding (BOLA)", () => {
  for (const { label, req } of SCOPED) {
    it(`${label} with valid Bearer but NO X-Guest-Token → 403`, async () => {
      const res = await callHandler(req());
      assert.equal(res.statusCode, 403, `${label} must be forbidden without a per-booking token`);
      assert.equal((res.body as { error?: string }).error, "forbidden");
    });

    it(`${label} with a WRONG X-Guest-Token → 403 (fail-closed)`, async () => {
      const r = req();
      r.headers["x-guest-token"] = "not-this-bookings-token";
      const res = await callHandler(r);
      assert.equal(res.statusCode, 403, `${label} must be forbidden with a mismatched per-booking token`);
    });
  }

  it("403 binding body carries no PII-shaped field", async () => {
    const res = await callHandler(makeReq("GET", `/acp/checkouts/${CHECKOUT}`, AUTH));
    const body = JSON.stringify(res.body ?? {});
    assert.ok(!/@/.test(body), `403 body must not contain email-shaped value: ${body}`);
    assert.ok(!/\+?\d{6,}/.test(body), `403 body must not contain phone-shaped value: ${body}`);
  });

  it("public discovery doc (no checkoutId) is unaffected by the binding", async () => {
    const res = await callHandler(makeReq("GET", "/acp"));
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { protocol?: string }).protocol, "agentic-commerce-protocol");
  });

  it("missing Authorization still 401s BEFORE the binding gate (order preserved)", async () => {
    const res = await callHandler(makeReq("GET", `/acp/checkouts/${CHECKOUT}`, { "x-guest-token": "anything" }));
    assert.equal(res.statusCode, 401, "Bearer gate must run first; binding sits on top of it");
  });
});
