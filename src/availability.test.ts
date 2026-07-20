import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAvailability } from "../lib/availability.js";

describe("availability — blocked dates", () => {
  function stubSupabaseForBlockedRows(rows: Array<{ start_date: string; end_date: string; source: string }>) {
    const calls: Array<{ table: string; op: string; column: string; value: unknown }> = [];

    const makeQuery = (table: string) => {
      const query: any = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          calls.push({ table, op: "eq", column, value });
          return query;
        },
        lt: (column: string, value: unknown) => {
          calls.push({ table, op: "lt", column, value });
          return query;
        },
        gt: (column: string, value: unknown) => {
          calls.push({ table, op: "gt", column, value });
          return query;
        },
        gte: (column: string, value: unknown) => {
          calls.push({ table, op: "gte", column, value });
          return query;
        },
        or: () => query,
        neq: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          const payload =
            table === "property_blocked_dates"
              ? { data: rows, error: null }
              : { data: [], error: null };
          return Promise.resolve(payload).then(resolve);
        },
      };
      return query;
    };

    return {
      calls,
      supabase: { from: (table: string) => makeQuery(table) } as any,
    };
  }

  it("treats a legacy one-day blocked date as unavailable for that night", async () => {
    const { calls, supabase } = stubSupabaseForBlockedRows([
      {
        start_date: "2026-05-23",
        end_date: "2026-05-23",
        source: "ical_import",
      },
    ]);

    const result = await checkAvailability(
      supabase,
      "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      "2026-05-23",
      "2026-05-24",
    );

    assert.equal(result.available, false);
    assert.equal(result.reason, "Dates blocked");
    assert.ok(
      calls.some(
        (call) =>
          call.table === "property_blocked_dates" &&
          call.op === "gte" &&
          call.column === "end_date" &&
          call.value === "2026-05-23",
      ),
      "property_blocked_dates query must fetch legacy same-day rows before half-open filtering",
    );
  });

  it("does not block the checkout day for a standard exclusive iCal range", async () => {
    const { supabase } = stubSupabaseForBlockedRows([
      {
        start_date: "2026-05-23",
        end_date: "2026-05-24",
        source: "ical_import",
      },
    ]);

    const result = await checkAvailability(
      supabase,
      "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      "2026-05-24",
      "2026-05-25",
    );

    assert.equal(result.available, true);
  });
});

// ── own-lock exclusion (under-lock availability re-check) ─────────────────────
//
// The booking paths acquire a lock, then RE-CHECK availability while holding
// it. Without excludeLockId the re-check sees the caller's own booking_locks
// row and returns "Dates temporarily locked" — the checkout deterministically
// defeats itself. This was invisible while lock acquisition was broken (the
// missing NOT NULL source column) and surfaced the moment locks could be
// created. These tests pin the exclusion contract.

describe("availability — own-lock exclusion under re-check", () => {
  const OWN_LOCK_ID = "own-lock-uuid-1";

  function stubSupabaseWithOwnLock() {
    let lockNeqValue: unknown = null;

    const makeQuery = (table: string) => {
      const query: any = {
        select: () => query,
        eq: () => query,
        lt: () => query,
        gt: () => query,
        gte: () => query,
        or: () => query,
        neq: (column: string, value: unknown) => {
          if (table === "booking_locks" && column === "id") lockNeqValue = value;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          let payload: { data: unknown[]; error: null } = { data: [], error: null };
          if (table === "booking_locks") {
            // The caller's own live lock overlaps the requested range. It is
            // returned unless the query excluded it via neq("id", OWN_LOCK_ID).
            payload =
              lockNeqValue === OWN_LOCK_ID
                ? { data: [], error: null }
                : {
                    data: [
                      {
                        id: OWN_LOCK_ID,
                        check_in: "2026-11-01",
                        check_out: "2026-11-02",
                        locked_until: new Date(Date.now() + 60_000).toISOString(),
                      },
                    ],
                    error: null,
                  };
          }
          return Promise.resolve(payload).then(resolve);
        },
      };
      return query;
    };

    return { supabase: { from: (table: string) => makeQuery(table) } as any };
  }

  it("without excludeLockId the caller's own lock blocks the re-check (pre-fix behavior)", async () => {
    const { supabase } = stubSupabaseWithOwnLock();
    const result = await checkAvailability(
      supabase,
      "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      "2026-11-01",
      "2026-11-02",
    );
    assert.equal(result.available, false);
    assert.match(result.reason ?? "", /temporarily locked/i);
  });

  it("with excludeLockId the caller's own lock is ignored and the re-check passes", async () => {
    const { supabase } = stubSupabaseWithOwnLock();
    const result = await checkAvailability(
      supabase,
      "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
      "2026-11-01",
      "2026-11-02",
      undefined,
      OWN_LOCK_ID,
    );
    assert.equal(result.available, true, "own lock must not block the under-lock re-check");
  });
});
