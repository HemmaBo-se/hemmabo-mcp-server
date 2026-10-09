/**
 * Contract — the ACP discovery manifest (GET /acp) never names HemmaBo as seller.
 *
 * The host is merchant of record: every ACP charge settles to the host's own
 * Stripe Connect account (on_behalf_of + transfer_data.destination, 0% fee;
 * api/acp.ts). The manifest serves every node, so its `seller` names the host
 * of each checkout and points at where each checkout names it — never HemmaBo,
 * never a "federation".
 *
 * Live fail 2026-09-29: https://hemmabo-mcp-server.vercel.app/acp answered
 * "seller": "HemmaBo Federation".
 *
 * Run: npx tsx --test src/acp-seller-host.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
}

async function discovery(path: string): Promise<MockRes> {
  const mod = await import("../api/acp.js");
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  // The router behind the S22 switch (closed in production; see agent-transactions-closed.contract.test.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mod.acpRouter({ method: "GET", url: path, headers: { host: "test.local" } } as any, res as any);
  return res;
}

describe("ACP manifest — seller is the host, never HemmaBo", () => {
  for (const path of ["/acp", "/api/acp"]) {
    it(`GET ${path}: seller names the host as merchant of record`, async () => {
      const res = await discovery(path);
      assert.equal(res.statusCode, 200);
      const body = res.body as { protocol?: string; seller?: unknown };
      assert.equal(body.protocol, "agentic-commerce-protocol");
      assert.equal(typeof body.seller, "string");
      const seller = body.seller as string;
      assert.match(seller, /\bhost\b/);
      assert.match(seller, /merchant of record/);
      assert.doesNotMatch(seller, /hemmabo/i);
      assert.doesNotMatch(seller, /federation/i);
    });

    it(`GET ${path}: seller points at the per-checkout fields that name the host`, async () => {
      const seller = ((await discovery(path)).body as { seller: string }).seller;
      assert.match(seller, /metadata\.property_name/);
      assert.match(seller, /metadata\.property_domain/);
    });
  }

  it("the per-checkout fields the seller points at exist in the checkout state", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../api/acp.ts", import.meta.url), "utf8");
    assert.match(src, /property_name:\s*prop\?\.name/);
    assert.match(src, /property_domain:\s*prop\?\.domain/);
  });

  it("no string in api/acp.ts names HemmaBo as seller or merchant of record", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../api/acp.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /HemmaBo Federation/);
    assert.doesNotMatch(src, /seller\s*:\s*["'`][^"'`]*hemmabo/i);
  });
});
