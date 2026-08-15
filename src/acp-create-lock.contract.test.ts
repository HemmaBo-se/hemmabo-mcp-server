/**
 * Contract test (E) — ACP createCheckout holds a booking_lock around the
 * availability re-check → insert, the same primitive the MCP booking path uses.
 *
 *   1. A lock CONFLICT (second concurrent booker on the same dates) → 409 and
 *      NO booking row is inserted (no double booking).
 *   2. When the lock is acquired but a later step fails, the lock is RELEASED
 *      in the finally block (never left blocking the calendar for the TTL).
 *
 * createCheckout is exported with an injectable-deps seam so it can run against
 * mock Supabase clients (the handler otherwise constructs its own internally).
 *
 * Run: npx tsx --test src/acp-create-lock.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCheckout } from "../api/acp.js";

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader() { /* noop */ },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  return res;
}

const PROP = { name: "Villa", domain: "villa.se", host_id: "h1", currency: "SEK", direct_booking_discount: 0 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readerClient(): any {
  return {
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = {};
      for (const m of ["select", "eq"]) c[m] = () => c;
      c.single = () => Promise.resolve({ data: PROP, error: null });
      return c;
    },
  };
}

const BODY = {
  items: [{ id: "p-1", quantity: 2 }],
  check_in: "2026-09-02",
  check_out: "2026-09-05",
  buyer: { email: "guest@example.com", first_name: "Guest" },
};

describe("ACP createCheckout booking lock (E)", () => {
  it("lock CONFLICT → 409 and no booking is inserted", async () => {
    let bookingInsertCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = {
      from: (table: string) => {
        let inserted = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = {};
        for (const m of ["select", "eq", "order", "gte", "lte", "lt", "gt", "or", "neq", "limit", "in", "update", "delete"]) c[m] = () => c;
        c.insert = () => {
          inserted = true;
          if (table === "bookings") bookingInsertCalled = true;
          return c;
        };
        c.single = () =>
          table === "booking_locks" && inserted
            ? Promise.resolve({ data: null, error: { code: "23P01" } }) // gist no-overlap → conflict
            : Promise.resolve({ data: null, error: null });
        c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
        return c;
      },
    };

    const res = makeRes();
    await createCheckout(BODY, res as never, "https://mcp.test", { supabase, reader: readerClient() });

    assert.equal(res.statusCode, 409);
    assert.match((res.body as { error?: string }).error ?? "", /temporarily locked/i);
    assert.equal(bookingInsertCalled, false, "a lock conflict must prevent the booking insert (no double booking)");
  });

  it("acquired lock is RELEASED when a later step fails (finally)", async () => {
    let lockReleased = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = {
      from: (table: string) => {
        let inserted = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = {};
        for (const m of ["select", "eq", "order", "gte", "lte", "lt", "gt", "or", "neq", "limit", "in", "delete"]) c[m] = () => c;
        c.insert = () => { inserted = true; return c; };
        c.update = () => {
          if (table === "booking_locks") lockReleased = true; // releaseBookingLock
          return c;
        };
        c.single = () => {
          if (table === "booking_locks" && inserted) return Promise.resolve({ data: { id: "lock-1" }, error: null }); // acquired
          if (table === "properties") return Promise.resolve({ data: null, error: { message: "gone" } }); // resolveQuote fails
          return Promise.resolve({ data: null, error: null });
        };
        c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
        return c;
      },
    };

    const res = makeRes();
    await createCheckout(BODY, res as never, "https://mcp.test", { supabase, reader: readerClient() });

    assert.equal(res.statusCode, 400, "resolveQuote failure surfaces as 400");
    assert.equal(lockReleased, true, "the acquired lock must be released in the finally block");
  });
});
