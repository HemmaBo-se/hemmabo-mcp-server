/**
 * Contract (min-nights agent-surface parity): hemmabo_search_properties must
 * NOT silently drop a matched property whose only problem is a too-short stay.
 * A below-minimum window is surfaced as an unavailableMatches entry carrying
 * reasonCode "min_nights_violation", the NUMBER (minimumNights) and a
 * byte-identical reason — exactly like hemmabo_search_availability and the
 * node's /api/availability — and the agentGuidance tells the agent to extend
 * the stay, never to claim the dates are unavailable or ask to change month.
 *
 * Hole this pins shut: the search loop dropped min-nights rejections with a
 * bare `continue`, so ChatGPT got an empty result plus the wrong advice
 * ("ask if the guest can change month or guest count") for dates that were
 * actually free — it could never read or relay the "minimum 2 nights" figure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";

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
      ilike: () => query,
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
      name: "Villa Åkerlyckan",
      domain: "villaakerlyckan.se",
      region: "Skåne",
      city: "Kävlinge",
      country: "SE",
      property_type: "villa",
      min_nights: 3,
      max_guests: 6,
      direct_booking_discount: 0,
      buffer_nights_before: 0,
      buffer_nights_after: 0,
    },
  ],
};

function parsePayload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

describe("search_properties min-stay agent-surface parity", () => {
  it("surfaces a below-minimum stay as min_nights_violation with the number — never a silent drop", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_properties",
      { guests: 2, checkIn: "2031-09-05", checkOut: "2031-09-07" }, // 2 nights < min 3
      clients,
    );
    const payload = parsePayload(result as any);

    // The property is NOT dropped and NOT presented as available.
    assert.equal(payload.properties.length, 0);
    const match = payload.unavailableMatches.find((p: any) => p.propertyId === PROP);
    assert.ok(match, "the matched property must appear in unavailableMatches, not vanish");
    assert.equal(match.available, false);
    assert.equal(match.reasonCode, "min_nights_violation");
    assert.equal(match.minimumNights, 3);
    // Byte-identical with the node + hemmabo_search_availability.
    assert.equal(match.reason, "Minimum stay is 3 nights. Requested 2.");

    // The guidance must point the agent at the number and extending the stay —
    // not the old advice that told the agent the dates were unavailable. (The
    // fix's guidance mentions "change month" only inside a "do NOT" clause, so
    // we pin the positive invariant, not the mere absence of that phrase.)
    assert.match(payload.agentGuidance, /minimumNights/);
    assert.match(payload.agentGuidance, /extend/i);
    assert.doesNotMatch(payload.agentGuidance, /Ask whether the guest can change/i);
  });

  it("does not min-refuse a stay that meets the node's minimum", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_properties",
      { guests: 2, checkIn: "2031-09-05", checkOut: "2031-09-08" }, // 3 nights == min 3
      clients,
    );
    const payload = parsePayload(result as any);
    const minViolated = (payload.unavailableMatches as any[]).some(
      (p) => p.reasonCode === "min_nights_violation",
    );
    assert.equal(minViolated, false);
  });
});
