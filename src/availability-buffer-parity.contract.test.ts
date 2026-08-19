/**
 * Buffer-parity contract (PR 1b) — the MCP server's availability answers must
 * match the host node's truth path (smart-stays api/_lib/availability-truth.ts).
 *
 * Live hole this pins shut (SoT audit 2026-08-18 #1, third implementation):
 * this repo compared blocks/bookings RAW against the requested window while
 * the node's booking engine expands bookings and channel-manager blocks by
 * the property's turnaround buffer (buffer_nights_before/after). The MCP
 * tools therefore promised windows the node refused. Live case
 * (villaakerlyckan.se): channex block [2026-09-08, 2026-09-10) + buffer 1/1
 * ⇒ the night 09-07 is blocked ⇒ /api/availability says host_blocked for
 * 09-05→09-08 while hemmabo_search_availability said available.
 *
 * The Supabase double applies eq/lt/gt/gte faithfully (or/neq stay no-ops,
 * same as the repo's other availability tests), so these tests also prove the
 * fetch window is WIDENED enough to see rows whose buffered span reaches into
 * the request — an unwidened query would never fetch the conflicting row.
 * Fixtures use far-future 2031 dates with the live case's month/day shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAvailability, findFreeWindowsInMonth } from "../lib/availability.js";

type Row = Record<string, unknown>;

interface Fixtures {
  properties?: Row[];
  blocked?: Row[];
  bookings?: Row[];
  locks?: Row[];
  /** Queries against this table resolve { data: null, error } — what
   *  supabase-js returns on a transport failure. */
  errorTable?: string;
}

function makeSupabase(fixtures: Fixtures) {
  const tableRows = (table: string): Row[] => {
    switch (table) {
      case "properties":
        return fixtures.properties ?? [];
      case "property_blocked_dates":
        return fixtures.blocked ?? [];
      case "bookings":
        return fixtures.bookings ?? [];
      case "booking_locks":
        return fixtures.locks ?? [];
      default:
        return [];
    }
  };

  const makeQuery = (table: string) => {
    const ops: Array<(r: Row) => boolean> = [];
    const query: any = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        ops.push((r) => r[column] === value);
        return query;
      },
      lt: (column: string, value: unknown) => {
        ops.push((r) => String(r[column]) < String(value));
        return query;
      },
      gt: (column: string, value: unknown) => {
        ops.push((r) => String(r[column]) > String(value));
        return query;
      },
      gte: (column: string, value: unknown) => {
        ops.push((r) => String(r[column]) >= String(value));
        return query;
      },
      // Same convention as src/availability.test.ts: or/neq are no-ops; the
      // status/staleness rules are applied in code via blocksAvailability.
      or: () => query,
      neq: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        if (fixtures.errorTable === table) {
          return Promise.resolve({
            data: null,
            error: { message: "injected transport failure" },
          }).then(resolve);
        }
        const data = tableRows(table).filter((r) => ops.every((op) => op(r)));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return query;
  };

  return { from: (table: string) => makeQuery(table) } as any;
}

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";

const bufferedProperty = (before: number, after: number, minNights = 1): Row => ({
  id: PROP,
  min_nights: minNights,
  buffer_nights_before: before,
  buffer_nights_after: after,
});

describe("buffer parity — checkAvailability matches the node's truth path", () => {
  it("channex block + buffer 1/1: 09-05→09-08 is blocked (the live case)", async () => {
    const supabase = makeSupabase({
      properties: [bufferedProperty(1, 1)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "channex" },
      ],
    });
    const result = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-08");
    assert.equal(result.available, false);
    assert.equal(result.reason, "Dates blocked");
  });

  it("channex block + buffer 1/1: 09-05→09-07 stays bookable (buffer does not over-block)", async () => {
    const supabase = makeSupabase({
      properties: [bufferedProperty(1, 1)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "channex" },
      ],
    });
    const result = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-07");
    assert.equal(result.available, true);
  });

  it("manual block stays EXACT despite buffers — adjacent window bookable", async () => {
    const supabase = makeSupabase({
      properties: [bufferedProperty(1, 1)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "manual" },
      ],
    });
    const adjacent = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-08");
    assert.equal(adjacent.available, true);
    const inside = await checkAvailability(supabase, PROP, "2031-09-08", "2031-09-09");
    assert.equal(inside.available, false);
  });

  it("legacy ical_import block stays EXACT — checkout day bookable (ADR 2026-06-24)", async () => {
    const supabase = makeSupabase({
      properties: [bufferedProperty(1, 1)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "ical_import" },
      ],
    });
    const checkoutDay = await checkAvailability(supabase, PROP, "2031-09-10", "2031-09-12");
    assert.equal(checkoutDay.available, true);
  });

  it("booking's AFTER-buffer blocks the turnover nights (fetch window is widened)", async () => {
    // Booking [09-01, 09-05) + after-buffer 2 ⇒ effective end 09-07. An
    // unwidened query (.gt check_out_date > 09-05) would never fetch the row.
    const supabase = makeSupabase({
      properties: [bufferedProperty(0, 2)],
      bookings: [
        {
          property_id: PROP,
          check_in_date: "2031-09-01",
          check_out_date: "2031-09-05",
          status: "confirmed",
        },
      ],
    });
    const insideBuffer = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-07");
    assert.equal(insideBuffer.available, false);
    assert.equal(insideBuffer.reason, "Dates already booked");
    const afterBuffer = await checkAvailability(supabase, PROP, "2031-09-07", "2031-09-09");
    assert.equal(afterBuffer.available, true);
  });

  it("booking's BEFORE-buffer blocks the preceding nights", async () => {
    // Booking [09-10, 09-12) + before-buffer 2 ⇒ effective start 09-08.
    const supabase = makeSupabase({
      properties: [bufferedProperty(2, 0)],
      bookings: [
        {
          property_id: PROP,
          check_in_date: "2031-09-10",
          check_out_date: "2031-09-12",
          status: "confirmed",
        },
      ],
    });
    const intoBuffer = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-09");
    assert.equal(intoBuffer.available, false);
    const beforeBuffer = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-08");
    assert.equal(beforeBuffer.available, true);
  });

  it("booking locks are NEVER buffered — adjacent night bookable with buffers 1/1", async () => {
    const supabase = makeSupabase({
      properties: [bufferedProperty(1, 1)],
      locks: [
        {
          id: "l1",
          property_id: PROP,
          check_in: "2031-09-07",
          check_out: "2031-09-09",
          locked_until: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const adjacent = await checkAvailability(supabase, PROP, "2031-09-05", "2031-09-07");
    assert.equal(adjacent.available, true);
    const overlapping = await checkAvailability(supabase, PROP, "2031-09-06", "2031-09-08");
    assert.equal(overlapping.available, false);
    assert.match(overlapping.reason ?? "", /temporarily locked/i);
  });

  it("buffer read failure is FAIL-CLOSED, and an explicit buffers arg skips the read", async () => {
    const fixtures: Fixtures = {
      properties: [bufferedProperty(1, 1)],
      errorTable: "properties",
    };
    const failed = await checkAvailability(makeSupabase(fixtures), PROP, "2031-09-05", "2031-09-08");
    assert.equal(failed.available, false);
    assert.match(failed.reason ?? "", /buffer rules query error/);

    // Callers that already hold the property row pass buffers in — no
    // properties read happens, so the injected failure never triggers.
    const passed = await checkAvailability(
      makeSupabase(fixtures),
      PROP,
      "2031-09-05",
      "2031-09-08",
      undefined,
      undefined,
      { before: 0, after: 0 },
    );
    assert.equal(passed.available, true);
  });
});

describe("buffer parity — gap-scan (alternative windows)", () => {
  it("respects min_nights: a 1-night gap is never offered when the host requires 2", async () => {
    // Manual blocks [09-02, 09-05) and [09-06, 09-09) leave the single free
    // night 09-05 — a window the booking engine would refuse.
    const fixtures: Fixtures = {
      properties: [bufferedProperty(0, 0, 2)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-02", end_date: "2031-09-05", source: "manual" },
        { property_id: PROP, start_date: "2031-09-06", end_date: "2031-09-09", source: "manual" },
      ],
    };
    const windows = await findFreeWindowsInMonth(
      makeSupabase(fixtures),
      PROP,
      "2031-09-05",
      "2031-09-08",
    );
    assert.ok(windows.length > 0, "longer runs must still be offered");
    for (const w of windows) {
      assert.ok(w.nights >= 2, `window ${w.checkIn}→${w.checkOut} is below min_nights`);
    }
    assert.ok(!windows.some((w) => w.checkIn === "2031-09-05"), "the 1-night gap must be dropped");

    // Control: with min_nights 1 the same gap IS offered.
    const lenient = await findFreeWindowsInMonth(
      makeSupabase(fixtures),
      PROP,
      "2031-09-05",
      "2031-09-08",
      { minNights: 1, buffers: { before: 0, after: 0 } },
    );
    assert.ok(lenient.some((w) => w.checkIn === "2031-09-05" && w.nights === 1));
  });

  it("respects the turnaround buffer: the night before a channex stay is not offered", async () => {
    const fixtures: Fixtures = {
      properties: [bufferedProperty(1, 1, 1)],
      blocked: [
        { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "channex" },
      ],
    };
    const windows = await findFreeWindowsInMonth(
      makeSupabase(fixtures),
      PROP,
      "2031-09-05",
      "2031-09-08",
    );
    const before = windows.find((w) => w.checkIn <= "2031-09-05");
    assert.ok(before, "a window before the stay must exist");
    assert.equal(
      before!.checkOut,
      "2031-09-07",
      "the free run must end where the buffered span begins (09-07 is a cleaning night)",
    );
    assert.ok(!windows.some((w) => w.checkIn === "2031-09-07"));
  });

  it("fail-closed: an errored properties read yields no windows", async () => {
    const windows = await findFreeWindowsInMonth(
      makeSupabase({
        properties: [bufferedProperty(1, 1)],
        errorTable: "properties",
      }),
      PROP,
      "2031-09-05",
      "2031-09-08",
    );
    assert.deepEqual(windows, []);
  });
});
