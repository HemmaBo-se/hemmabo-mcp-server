/**
 * Contract test (OA-2) — validateAuth respects mcp_clients.is_active.
 *
 * An OAuth access token is valid only while its issuing client is active. A
 * client deactivated after the token was issued is rejected IMMEDIATELY (not
 * only after the 1h TTL), with the SAME "Invalid or unknown token" message as a
 * token that never existed (no oracle). The MCP_API_KEY path is unaffected.
 *
 * validateAuth takes an injectable `deps.supabase` so the OAuth DB path runs
 * against a mock — no real database.
 *
 * Run: npx tsx --test src/oauth-auth-client-active.contract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { validateAuth } from "./auth.js";

const MASTER = "master-key-for-oa2-test";
const OAUTH_TOKEN = "some-oauth-access-token";
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const PAST = () => new Date(Date.now() - 3600_000).toISOString();

let saved: string | undefined;
before(() => { saved = process.env.MCP_API_KEY; process.env.MCP_API_KEY = MASTER; });
after(() => { if (saved === undefined) delete process.env.MCP_API_KEY; else process.env.MCP_API_KEY = saved; });

// Mock Supabase: token select via maybeSingle; expired-token delete via await.
function mockSupabase(row: Record<string, unknown> | null, error: unknown = null) {
  const deletedIds: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from: () => {
      let isDelete = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        delete: () => { isDelete = true; return q; },
        eq: (_col: string, val: unknown) => { if (isDelete) deletedIds.push(String(val)); return q; },
        maybeSingle: () => Promise.resolve({ data: row, error }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
      };
      return q;
    },
  };
  return { supabase, deletedIds };
}

describe("validateAuth respects mcp_clients.is_active (OA-2)", () => {
  it("ACTIVE client + unexpired token → valid (null)", async () => {
    const { supabase } = mockSupabase({ id: "t1", expires_at: FUTURE(), mcp_clients: { is_active: true } });
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.equal(result, null);
  });

  it("INACTIVE client → rejected, SAME message as an unknown token (no oracle)", async () => {
    const { supabase } = mockSupabase({ id: "t1", expires_at: FUTURE(), mcp_clients: { is_active: false } });
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.equal(result, "Invalid or unknown token");
  });

  it("missing client relation (null embed) → rejected as invalid", async () => {
    const { supabase } = mockSupabase({ id: "t1", expires_at: FUTURE(), mcp_clients: null });
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.equal(result, "Invalid or unknown token");
  });

  it("unknown token (no row) → invalid", async () => {
    const { supabase } = mockSupabase(null);
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.equal(result, "Invalid or unknown token");
  });

  it("ACTIVE client but EXPIRED token → expired message + row reaped", async () => {
    const { supabase, deletedIds } = mockSupabase({ id: "t2", expires_at: PAST(), mcp_clients: { is_active: true } });
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.match(result ?? "", /Token expired/);
    assert.deepEqual(deletedIds, ["t2"], "expired token row must be deleted");
  });

  it("tolerates a single-element-array embed shape (PostgREST variance)", async () => {
    const { supabase } = mockSupabase({ id: "t1", expires_at: FUTURE(), mcp_clients: [{ is_active: true }] });
    const result = await validateAuth(`Bearer ${OAUTH_TOKEN}`, { supabase });
    assert.equal(result, null);
  });

  it("MCP_API_KEY path is unaffected — never touches the DB", async () => {
    // Inject a supabase whose use would throw; the master-key branch must return
    // before any DB access.
    const throwing = { from: () => { throw new Error("DB must not be touched on the MCP_API_KEY path"); } } as never;
    const result = await validateAuth(`Bearer ${MASTER}`, { supabase: throwing });
    assert.equal(result, null);
  });
});
