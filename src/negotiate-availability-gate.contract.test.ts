/**
 * Contract (ADR 0016, CEO decision A 2026-08-19): hemmabo_booking_negotiate
 * and hemmabo_booking_quote never price a window the node's booking engine
 * refuses.
 *
 * Hole this pins shut: both tools priced (and negotiate LOCKED, writing a
 * property_quote_snapshots row) any requested window with no availability
 * check at all — an agent could hand the guest a locked price for occupied
 * dates and only fail at checkout. Now: unavailable ⇒ error "Not available"
 * + alternative bookable windows, and NO quote snapshot is written.
 *
 * The double keys rows per table and applies eq/lt/gt/gte faithfully
 * (or/neq no-ops, same convention as the repo's availability tests), and
 * records every insert so the no-snapshot invariant is provable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";

type Row = Record<string, unknown>;

interface Fixtures {
  properties?: Row[];
  blocked?: Row[];
  bookings?: Row[];
  locks?: Row[];
}

function makeClients(fixtures: Fixtures) {
  const inserts: Array<{ table: string; row: Row }> = [];

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
    let singleMode = false;
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
      or: () => query,
      neq: () => query,
      in: () => query,
      is: () => query,
      not: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: () => {
        singleMode = true;
        return query;
      },
      single: () => {
        singleMode = true;
        return query;
      },
      insert: (row: Row) => {
        inserts.push({ table, row });
        return query;
      },
      then: (resolve: (value: unknown) => unknown) => {
        const data = tableRows(table).filter((r) => ops.every((op) => op(r)));
        return Promise.resolve(
          singleMode ? { data: data[0] ?? null, error: null } : { data, error: null },
        ).then(resolve);
      },
    };
    return query;
  };

  const client = { from: (table: string) => makeQuery(table) } as any;
  return {
    inserts,
    clients: { supabase: client, reader: client } as ToolClients,
  };
}

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";

// The live case: channex block [09-08, 09-10) + buffer 1/1 ⇒ 09-05→09-08 is
// NOT bookable (the night of 09-07 is a turnaround night).
const conflictFixtures: Fixtures = {
  properties: [
    {
      id: PROP,
      published: true,
      domain: "villaakerlyckan.se",
      min_nights: 1,
      buffer_nights_before: 1,
      buffer_nights_after: 1,
    },
  ],
  blocked: [
    { property_id: PROP, start_date: "2031-09-08", end_date: "2031-09-10", source: "channex" },
  ],
};

const ARGS = {
  propertyId: PROP,
  checkIn: "2031-09-05",
  checkOut: "2031-09-08",
  guests: 2,
};

function payloadOf(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

for (const tool of ["hemmabo_booking_negotiate", "hemmabo_booking_quote"] as const) {
  describe(`${tool} — availability gate (ADR 0016)`, () => {
    it("refuses an unbookable window with alternatives, and writes NO snapshot", async () => {
      const { inserts, clients } = makeClients(conflictFixtures);
      const result = await executeTool(tool, { ...ARGS }, clients);

      assert.equal(result.isError, true);
      const payload = payloadOf(result);
      assert.equal(payload.error, "Not available");
      assert.equal(payload.available, false);
      assert.ok(Array.isArray(payload.alternativeDates), "alternatives must be offered (no-wall)");
      assert.ok(
        inserts.every((i) => i.table !== "property_quote_snapshots"),
        "an unbookable window must never produce a quote snapshot",
      );
    });

    it("a bookable window passes the gate (any later failure is NOT 'Not available')", async () => {
      // Same fixtures, but the request avoids the buffered span entirely.
      const { clients } = makeClients(conflictFixtures);
      const result = await executeTool(
        tool,
        { ...ARGS, checkIn: "2031-09-01", checkOut: "2031-09-04" },
        clients,
      );
      // The pricing fixtures are deliberately empty, so resolveQuote fails —
      // but with a PRICING error, proving the availability gate let the
      // request through.
      const payload = payloadOf(result);
      assert.notEqual(payload.error, "Not available");
    });
  });
}

describe("negotiate tool description — price lock, not negotiation", () => {
  it("states the price is fixed and never negotiated", async () => {
    const { TOOL_SPECS } = await import("../lib/tool-definitions-base.js");
    const negotiate = (TOOL_SPECS as ReadonlyArray<{ name: string; description: string }>).find(
      (t) => t.name === "hemmabo_booking_negotiate",
    );
    assert.ok(negotiate, "tool definition must exist");
    assert.match(negotiate!.description, /PRICE LOCK, not negotiation/);
    assert.match(negotiate!.description, /never bargains, discounts, or alters/);
  });
});
