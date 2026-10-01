/**
 * Unit test — the shared booking_locks primitive (lib/booking-locks.ts),
 * shared with ACP createCheckout (api/acp.ts). The MCP booking tools that
 * also used it were removed from the platform connector (ADR 0019).
 *
 * Run: npx tsx --test src/booking-locks.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireBookingLock, releaseBookingLock } from "../lib/booking-locks.js";

// Mock Supabase: cleanup delete + lock insert(.select.single). The insert's
// single() result is what distinguishes success / conflict / db_error.
function makeClient(insertResult: { data: unknown; error: unknown }) {
  const ops: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (_table: string): any => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lt", "insert", "update", "delete"]) {
      chain[m] = () => chain;
    }
    chain.single = () => {
      ops.push("insert_single");
      return Promise.resolve(insertResult);
    };
    // delete().eq().lt() and update().eq() are awaited without .single()
    chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
    return chain;
  };
  return { ops, client: { from } as never };
}

describe("acquireBookingLock", () => {
  it("returns { lockId } when the insert succeeds", async () => {
    const { client } = makeClient({ data: { id: "lock-1" }, error: null });
    const result = await acquireBookingLock(client, "p-1", "2026-09-02", "2026-09-05");
    assert.deepEqual(result, { lockId: "lock-1" });
  });

  it("maps 23P01 (gist no-overlap) to a CONFLICT — the slot is genuinely held", async () => {
    const { client } = makeClient({ data: null, error: { code: "23P01" } });
    const result = await acquireBookingLock(client, "p-1", "2026-09-02", "2026-09-05");
    assert.deepEqual(result, { lockError: "conflict" });
  });

  it("maps 23505 (unique) to a CONFLICT", async () => {
    const { client } = makeClient({ data: null, error: { code: "23505" } });
    assert.deepEqual(await acquireBookingLock(client, "p", "2026-09-02", "2026-09-05"), { lockError: "conflict" });
  });

  it("maps any other error code to db_error — NOT a false 'already locked'", async () => {
    const { client } = makeClient({ data: null, error: { code: "23502" } });
    assert.deepEqual(await acquireBookingLock(client, "p", "2026-09-02", "2026-09-05"), { lockError: "db_error" });
  });

  it("treats a missing row (no data, no code) as db_error", async () => {
    const { client } = makeClient({ data: null, error: null });
    assert.deepEqual(await acquireBookingLock(client, "p", "2026-09-02", "2026-09-05"), { lockError: "db_error" });
  });
});

// booking_locks.source is NOT NULL with CHECK ('hemmabo','ai_agent','guest',
// 'system'): an insert without it fails 23502 on every call. Moved here from
// the removed MCP checkout path in src/pricing.test.ts.
describe("acquireBookingLock — booking_locks.source column", () => {
  it("lock insert includes source: 'ai_agent'", async () => {
    let capturedRow: Record<string, unknown> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const from = (_table: string): any => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "lt", "update", "delete"]) {
        chain[m] = () => chain;
      }
      chain.insert = (row: Record<string, unknown>) => {
        capturedRow = row;
        return chain;
      };
      chain.single = () => Promise.resolve({ data: { id: "lock-source" }, error: null });
      chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
      return chain;
    };
    await acquireBookingLock({ from } as never, "p-1", "2026-09-02", "2026-09-05");
    assert.ok(capturedRow, "booking_locks insert was never attempted");
    assert.equal((capturedRow as Record<string, unknown>).source, "ai_agent");
  });
});

describe("releaseBookingLock", () => {
  it("resolves without throwing (best-effort)", async () => {
    const { client } = makeClient({ data: { id: "lock-1" }, error: null });
    await assert.doesNotReject(() => releaseBookingLock(client, "lock-1"));
  });
});
