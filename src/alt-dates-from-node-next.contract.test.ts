/**
 * Contract (VAKTHUND B, 2026-09-16): the platform MCP never invents a
 * different "next available" than the host node.
 *
 * Live 2026-09-16, propertyId 3ef1d46d-…, 2026-10-18→19, 6 guests:
 *
 *   node /api/availability + node MCP  → available:false, host_blocked,
 *                                        nextAvailable 2026-10-26→27, 3 800 SEK
 *   www.hemmabo.com/mcp
 *     hemmabo_search_availability      → alternativeDates[0] = 2026-10-01→03, 8 600 SEK
 *     hemmabo_booking_quote            → alternativeDates[0] = 2026-10-01→03, 8 600 SEK
 *
 * Two truths for one property. Pinned here: for a closed stay, alternativeDates
 * is the node's own nextAvailable for the SAME check-in / check-out / guests —
 * one window, the node's dates, nights and total — lifted from the node's
 * /api/availability. No nextAvailable from the node ⇒ empty list, never a
 * month-scanned gap. The requested (closed) night never carries a number.
 *
 * The Supabase double leaves 2026-10-01→17 FREE on purpose: the retired
 * month scan (findFreeWindowsInMonth) would have offered 2026-10-01→03 from
 * these very fixtures. If any scanned window leaks back in, the "no
 * 2026-10-01" assertions fail.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";

type Row = Record<string, unknown>;

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";
const NODE = "villaakerlyckan.se";

// ── Supabase double (same convention as negotiate-availability-gate) ────────

function makeClients() {
  const inserts: Array<{ table: string; row: Row }> = [];
  const tableRows = (table: string): Row[] => {
    switch (table) {
      case "properties":
        return [
          {
            id: PROP,
            published: true,
            domain: NODE,
            name: "Villa Åkerlyckan",
            max_guests: 6,
            min_nights: 1,
            buffer_nights_before: 0,
            buffer_nights_after: 0,
          },
        ];
      case "property_blocked_dates":
        // The live host block — and NOTHING else in October, so a month scan
        // would find free gaps (2026-10-01→17) to fabricate from.
        return [{ property_id: PROP, start_date: "2026-10-18", end_date: "2026-10-19", source: "manual" }];
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
  return { inserts, clients: { supabase: client, reader: client } as ToolClients };
}

// ── Node double: the live /api/availability answer for 18–19 Oct ────────────

const NODE_HOST_BLOCKED = {
  available: false,
  reasonCode: "host_blocked",
  reason: "The host has blocked these dates (unavailable).",
  property: "Villa Åkerlyckan",
  domain: NODE,
  nextAvailable: {
    checkIn: "2026-10-26",
    checkOut: "2026-10-27",
    nights: 1,
    pricing: { pricePerNight: 3800, totalPrice: 3800, currency: "SEK" },
  },
  suggestion: "Try 2026-10-26 → 2026-10-27 instead, or contact the host directly.",
  bookingUrl: `https://${NODE}/?checkIn=2026-10-26&checkOut=2026-10-27&guests=6`,
  generated_at: "2026-09-16T07:17:49.642Z",
};

type NodeMode = "host_blocked" | "no_next" | "unreachable" | "http_500";
let nodeMode: NodeMode = "host_blocked";
let nodeCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    nodeCalls.push(url);
    const u = new URL(url);
    assert.equal(u.hostname, NODE, "only the property's own node may be asked");
    assert.equal(u.pathname, "/api/availability");
    if (nodeMode === "unreachable") throw new TypeError("fetch failed");
    if (nodeMode === "http_500") {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "" } as Response;
    }
    const body =
      nodeMode === "no_next"
        ? { ...NODE_HOST_BLOCKED, nextAvailable: undefined }
        : NODE_HOST_BLOCKED;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  nodeMode = "host_blocked";
  nodeCalls = [];
});

const ARGS = { propertyId: PROP, checkIn: "2026-10-18", checkOut: "2026-10-19", guests: 6 };

function payloadOf(result: { content: Array<{ text?: string }> }): { text: string; json: Record<string, any> } {
  const text = result.content[0]?.text ?? "{}";
  return { text, json: JSON.parse(text) };
}

for (const tool of ["hemmabo_search_availability", "hemmabo_booking_quote"] as const) {
  describe(`${tool} — alternativeDates is the node's nextAvailable (18–19 Oct host block)`, () => {
    it("carries exactly the node's window: 2026-10-26→27, 1 night, 3 800 SEK — never 2026-10-01", async () => {
      const { inserts, clients } = makeClients();
      const result = await executeTool(tool, { ...ARGS }, clients);
      const { text, json } = payloadOf(result);

      assert.equal(json.available, false);
      assert.ok(Array.isArray(json.alternativeDates));
      assert.equal(json.alternativeDates.length, 1, "one window — the node's, not three scanned gaps");
      const alt = json.alternativeDates[0];
      assert.equal(alt.checkIn, "2026-10-26");
      assert.equal(alt.checkOut, "2026-10-27");
      assert.equal(alt.nights, 1);
      assert.equal(alt.available, true);
      assert.equal(alt.shorterThanRequested, false);
      assert.equal(alt.currency, "SEK");
      assert.equal(alt.publicTotal, 3800);
      assert.equal(alt.federationTotal, 3800);
      assert.equal(alt.directBookingTotal, 3800);
      assert.equal(alt.hostSourcePublicTotal, 3800);
      assert.equal(alt.source, "host_node_next_available");

      // The retired month scan would have produced these from the same fixtures.
      assert.ok(!text.includes("2026-10-01"), "no month-scanned 2026-10-01 window");
      assert.ok(!text.includes("2026-10-03"), "no month-scanned 2026-10-03 window");
      assert.ok(!text.includes("8600"), "no month-scanned 8 600 total");

      // No number for the closed night itself.
      for (const key of ["total", "publicTotal", "federationTotal", "directBookingTotal", "hostSourcePublicTotal"]) {
        assert.equal(json[key], undefined, `${key} must not be quoted for the closed 18–19 Oct night`);
      }
      assert.ok(inserts.every((i) => i.table !== "property_quote_snapshots"), "no snapshot for a closed stay");
    });

    it("asks the node for the SAME check-in, check-out and guests, exactly once", async () => {
      const { clients } = makeClients();
      await executeTool(tool, { ...ARGS }, clients);
      assert.equal(nodeCalls.length, 1);
      const u = new URL(nodeCalls[0]);
      assert.equal(u.searchParams.get("checkIn"), "2026-10-18");
      assert.equal(u.searchParams.get("checkOut"), "2026-10-19");
      assert.equal(u.searchParams.get("guests"), "6");
    });

    it("node answers without nextAvailable ⇒ empty list (no scanned window substituted)", async () => {
      nodeMode = "no_next";
      const { clients } = makeClients();
      const { text, json } = payloadOf(await executeTool(tool, { ...ARGS }, clients));
      assert.equal(json.available, false);
      assert.deepEqual(json.alternativeDates, []);
      assert.ok(!text.includes("2026-10-01"));
    });

    it("node unreachable or erroring ⇒ empty list, still available:false, no invented window", async () => {
      for (const mode of ["unreachable", "http_500"] as NodeMode[]) {
        nodeMode = mode;
        const { clients } = makeClients();
        const { text, json } = payloadOf(await executeTool(tool, { ...ARGS }, clients));
        assert.equal(json.available, false, mode);
        assert.deepEqual(json.alternativeDates, [], mode);
        assert.ok(!text.includes("2026-10-01"), mode);
      }
    });
  });
}

describe("findFreeWindowsInMonth no longer feeds the tools on a closed stay", () => {
  it("tools-base.ts does not import or call the month scan", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "lib", "tools-base.ts"), "utf8");
    // Neither imported nor called (a comment naming the retired scan is fine).
    assert.ok(!/import[^;]*\bfindFreeWindowsInMonth\b/.test(src), "lib/tools-base.ts must not import findFreeWindowsInMonth");
    assert.ok(!/\bfindFreeWindowsInMonth\s*\(/.test(src), "lib/tools-base.ts must not call findFreeWindowsInMonth");
    assert.ok(/nodeNextAvailableAlternatives\(/.test(src), "alternatives come from the node's nextAvailable");
  });
});
