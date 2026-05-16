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
