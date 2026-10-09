/**
 * Contract — S22 (CEO order 2026-10-09): agent checkout is closed behind one switch.
 *
 * Measured 2026-10-09 before this change: https://hemmabo-mcp-server.vercel.app/acp/checkout_sessions
 * answered 200 with the ACP manifest, GET /acp/checkouts answered 405 and POST /acp/checkouts
 * answered 401, so the checkout ran its own logic. hemmabo.com/acp was closed in
 * hemmabo-smart-stays (#3178); this server's own address was not.
 *
 * With the switch off, every /acp/* request answers 403 with the CEO's sentence before auth, the
 * body, a database client, Stripe or any network call. hemmabo-smart-stays
 * scripts/agent-transactions-closed-live.mjs proves the same on the live server after each deploy.
 *
 * Run: npx tsx --test src/agent-transactions-closed.contract.test.ts
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_TRANSACTIONS_CLOSED_BODY,
  AGENT_TRANSACTIONS_ENABLED,
} from "../lib/agent-transactions.js";

// The same answer, character for character, as hemmabo-smart-stays api/_lib/agent-transactions.js.
const CLOSED = {
  error: "agent_transactions_closed",
  message: "Agents verify and send the guest to the host's booking page",
};

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (code: number) => MockRes;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(method: string, path: string, headers: Record<string, string> = {}): Promise<MockRes> {
  const mod = await import("../api/acp.js");
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  const req = { method, url: path, headers: { host: "hemmabo-mcp-server.vercel.app", ...headers }, body: {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mod.default(req as any, res as any);
  return res;
}

describe("S22 — the switch", () => {
  it("is off; opening it is the CEO's pull request", () => {
    assert.equal(AGENT_TRANSACTIONS_ENABLED, false);
    assert.deepEqual({ ...AGENT_TRANSACTIONS_CLOSED_BODY }, CLOSED);
  });

  it("is code, not an environment variable", () => {
    const src = readFileSync(new URL("../lib/agent-transactions.ts", import.meta.url), "utf8");
    assert.match(src, /export const AGENT_TRANSACTIONS_ENABLED = false;/);
    assert.doesNotMatch(src, /process\.env/);
  });

  it("the ACP handler asks the switch on its first line", () => {
    const src = readFileSync(new URL("../api/acp.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export default async function handler"));
    const first = body.slice(body.indexOf("{\n") + 2).trimStart().split("\n")[0];
    assert.equal(first, "if (agentTransactionsClosed(res)) return;");
  });
});

describe("S22 — no agent can check out, pay or cancel through /acp", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/acp"],
    ["GET", "/acp/checkout_sessions"],
    ["POST", "/acp/checkouts"],
    ["GET", "/acp/checkouts"],
    ["GET", "/acp/checkouts/cs_probe"],
    ["PUT", "/acp/checkouts/cs_probe"],
    ["POST", "/acp/checkouts/cs_probe/complete"],
    ["POST", "/acp/checkouts/cs_probe/cancel"],
    ["OPTIONS", "/acp/checkouts"],
    ["POST", "/api/acp/checkouts"],
  ];
  for (const [method, path] of routes) {
    const variants: Array<Record<string, string>> = [{}, { authorization: "Bearer probe" }];
    for (const headers of variants) {
      const label = headers.authorization ? "with a bearer token" : "without auth";
      it(`${method} ${path} ${label}: 403, the CEO's sentence, no network call`, async () => {
        const res = await call(method, path, headers);
        assert.equal(res.statusCode, 403);
        assert.deepEqual({ ...(res.body as object) }, CLOSED);
        assert.equal(res.headers["cache-control"], "no-store");
        assert.equal(fetchCalls, 0);
      });
    }
  }
});
