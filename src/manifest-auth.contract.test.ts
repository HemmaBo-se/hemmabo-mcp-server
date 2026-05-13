/**
 * Contract test: every TOOLS entry has a deterministic auth requirement
 * exposed in /.well-known/mcp.json (api/mcp-manifest.ts) and the
 * /.well-known/mcp/server-card.json (api/server-card.ts) endpoints.
 *
 * Single source of truth: ANON_TOOLS in api/mcp.ts.
 *
 * Run: npx tsx --test src/manifest-auth.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANON_TOOLS, TOOLS } from "../api/mcp.js";
import manifestHandler from "../api/mcp-manifest.js";
import serverCardHandler from "../api/server-card.js";

type Tool = { name: string; auth?: "none" | "bearer" };

function captureJson(handler: (req: any, res: any) => unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const fakeRes = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      json: (body: unknown) => resolve(body),
      status: () => fakeRes,
    };
    try {
      handler({ method: "GET", headers: {} }, fakeRes);
    } catch (e) {
      reject(e);
    }
  });
}

describe("manifest per-tool auth contract", () => {
  it("ANON_TOOLS contains the canonical 5 read-only tools", () => {
    for (const name of [
      "hemmabo_search_properties",
      "hemmabo_search_availability",
      "hemmabo_search_similar",
      "hemmabo_compare_properties",
      "hemmabo_booking_quote",
    ]) {
      assert.ok(ANON_TOOLS.has(name), `ANON_TOOLS missing ${name}`);
    }
  });

  it("/.well-known/mcp.json exposes auth:'none' for every anon tool and auth:'bearer' for every other tool", async () => {
    const body = (await captureJson(manifestHandler as never)) as { tools: Tool[] };
    assert.ok(Array.isArray(body.tools), "manifest must have tools[]");
    assert.equal(body.tools.length, 11, "manifest must list all 11 tools");

    for (const t of body.tools) {
      assert.ok(
        t.auth === "none" || t.auth === "bearer",
        `tool ${t.name} must declare auth as "none" or "bearer", got ${String(t.auth)}`
      );
      const expected: "none" | "bearer" = ANON_TOOLS.has(t.name) ? "none" : "bearer";
      assert.equal(t.auth, expected, `tool ${t.name} expected auth=${expected}`);
    }
  });

  it("server-card endpoint annotates every tool with auth", async () => {
    const body = (await captureJson(serverCardHandler as never)) as { tools: Tool[] };
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, TOOLS.length);

    for (const t of body.tools) {
      const expected: "none" | "bearer" = ANON_TOOLS.has(t.name) ? "none" : "bearer";
      assert.equal(
        t.auth,
        expected,
        `server-card tool ${t.name} expected auth=${expected}, got ${String(t.auth)}`
      );
    }
  });

  it("anon manifest entries match the readOnlyHint annotation in TOOLS metadata", async () => {
    const body = (await captureJson(serverCardHandler as never)) as {
      tools: { name: string; auth: "none" | "bearer"; annotations?: { readOnlyHint?: boolean } }[];
    };
    for (const t of body.tools) {
      if (t.auth === "none") {
        assert.equal(
          t.annotations?.readOnlyHint,
          true,
          `tool ${t.name} declares auth:'none' but is not marked readOnlyHint:true`
        );
      }
    }
  });
});
