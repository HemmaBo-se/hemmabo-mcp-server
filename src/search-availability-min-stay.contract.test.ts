/**
 * Contract (CEO order 2026-08-19, min-nights node parity):
 * hemmabo_search_availability enforces the SAME per-node min-stay as the
 * node's /api/availability — search must never answer available where the
 * node answers min_nights_violation, and the refusal must be byte-identical
 * in reason ("Minimum stay is X nights. Requested N.").
 *
 * Hole this pins shut: search was a pure calendar-conflict check, so an
 * agent could see available:true for a 2-night window on a min-3 node and
 * only hit the wall at quote/checkout (the live 2026-08-19 smoke showed
 * exactly this divergence).
 *
 * Also pins the fallback lockstep with smart-stays contracts/ts:
 * DEFAULT_MIN_NIGHTS = 2 (the DB default since migration 20260819120000);
 * min_nights is PER NODE — the constant is the platform-level defensive
 * fallback only, never a node value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";
import { DEFAULT_MIN_NIGHTS } from "../lib/availability-core.js";

type Row = Record<string, unknown>;

interface Fixtures {
  properties?: Row[];
}

function makeClients(fixtures: Fixtures) {
  const tableRows = (table: string): Row[] => {
    switch (table) {
      case "properties":
        return fixtures.properties ?? [];
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
      lt: () => query,
      gt: () => query,
      gte: () => query,
      lte: () => query,
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
  return { supabase: client, reader: client } as ToolClients;
}

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";

const fixtures: Fixtures = {
  properties: [
    {
      id: PROP,
      published: true,
      domain: "villaakerlyckan.se",
      min_nights: 3,
      max_guests: 6,
      buffer_nights_before: 0,
      buffer_nights_after: 0,
    },
  ],
};

function parsePayload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("search_availability min-stay node parity", () => {
  it("refuses a below-minimum window exactly like the node", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-09-05", checkOut: "2031-09-07", guests: 2 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.equal(payload.available, false);
    assert.equal(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.minimumNights, 3);
    // Byte-identical with api/availability.ts min_nights_violation reason.
    assert.equal(payload.reason, "Minimum stay is 3 nights. Requested 2.");
  });

  it("does not min-refuse a window that meets the node's minimum", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-09-05", checkOut: "2031-09-08" },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.notEqual(payload.reasonCode, "min_nights_violation");
  });

  it("pins the platform fallback lockstep: DEFAULT_MIN_NIGHTS = 2", () => {
    assert.equal(DEFAULT_MIN_NIGHTS, 2);
    // The quote path's defensive fallback must use the constant, never a
    // numeric literal (mcp-server twin of the smart-stays fallback ban).
    // (?<!\w) spares columns that merely END in min_nights, e.g.
    // gap_fill_min_nights — same lookbehind as the smart-stays gate.
    const ban = /(?<!\w)min_nights\s*\?\?\s*\d/;
    const pricing = readFileSync(new URL("../lib/pricing.ts", import.meta.url), "utf8");
    assert.ok(!ban.test(pricing), "lib/pricing.ts has a numeric min_nights fallback");
    const toolsBase = readFileSync(new URL("../lib/tools-base.ts", import.meta.url), "utf8");
    assert.ok(!ban.test(toolsBase), "lib/tools-base.ts has a numeric min_nights fallback");
  });
});
