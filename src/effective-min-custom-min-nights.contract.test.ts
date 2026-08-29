/**
 * Contract (PR-A3 completion — CEO order 2026-08-29, MCP surface parity):
 * the platform MCP honours the per-date `property_date_settings.custom_min_nights`
 * override (ADR 2026-08-20-custom-min-nights-effective, CEO decision 3A) with
 * the SAME precedence every other runtime already enforces:
 *
 *   custom_min_nights (arrival day)  >  gap-fill / last-minute modifiers
 *                                    >  properties.min_nights (base).
 *
 * Hole this pins shut (live 2026-08-29): the host opened ONE night by setting
 * custom_min_nights=1 on 2026-12-09; the node's /api/availability answered
 * available:true (3610 SEK) and Airbnb/Booking.com sold the night — but
 * hemmabo_search_availability still refused with min_nights_violation/2,
 * because the vendored effective-min core was the pre-3A five-parameter
 * version and resolveEffectiveMinNights never read the
 * `get_property_custom_min_nights` RPC. Search must never refuse a window the
 * node sells (and never sell a window the node refuses).
 *
 * DoD windows (guests-independent; the override sits on the ARRIVAL day):
 *   2026-12-09 → 2026-12-10  (override 1)  ⇒ available, no min refusal
 *   2026-12-08 → 2026-12-09  (no override) ⇒ min_nights_violation, minimum 2
 *   2026-12-10 → 2026-12-11  (no override) ⇒ min_nights_violation, minimum 2
 *   no-override date, 1 night              ⇒ unchanged base-min refusal
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";
import { resolveEffectiveMinNights } from "../lib/availability.js";
import { getEffectiveMinNights, type MinNightsModifiers } from "../lib/effective-min-nights.js";

type Row = Record<string, unknown>;

interface Fixtures {
  properties?: Row[];
  /** {YYYY-MM-DD: custom_min_nights} served by the get_property_custom_min_nights RPC mock. */
  customMinByDate?: Record<string, number>;
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

  const client = {
    from: (table: string) => makeQuery(table),
    // The anon-safe override RPC (smart-stays migration 20260820140000): one
    // integer for one (property, date), or null when the host set none.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "get_property_custom_min_nights") {
        const date = String(args.p_date ?? "");
        const value = fixtures.customMinByDate?.[date];
        return { data: typeof value === "number" ? value : null, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  } as any;
  return { supabase: client, reader: client } as ToolClients;
}

const PROP = "3ef1d46d-5c23-46fe-86cb-8e714abf734f";

const fixtures: Fixtures = {
  properties: [
    {
      id: PROP,
      published: true,
      domain: "villaakerlyckan.se",
      min_nights: 2,
      max_guests: 6,
      buffer_nights_before: 0,
      buffer_nights_after: 0,
    },
  ],
  // Far-future mirror of the live DoD window (custom_min_nights=1 on
  // 2026-12-09): tool-level tests pass real-clock date validation, so fixture
  // dates must not rot — same 2031 convention as the sibling min-stay tests.
  customMinByDate: { "2031-12-09": 1 },
};

function parsePayload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("search_availability honours the per-date custom_min_nights override (3A)", () => {
  it("override 1 on the arrival day opens the one-night window the node sells", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-12-09", checkOut: "2031-12-10", guests: 6 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.notEqual(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.available, true);
  });

  it("the day BEFORE the override date still refuses on the base minimum", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-12-08", checkOut: "2031-12-09", guests: 6 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.equal(payload.available, false);
    assert.equal(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.minimumNights, 2);
    // Byte-identical with the node's /api/availability refusal sentence.
    assert.equal(payload.reason, "Minimum stay is 2 nights. Requested 1.");
  });

  it("the day AFTER the override date still refuses on the base minimum", async () => {
    const clients = makeClients(fixtures);
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-12-10", checkOut: "2031-12-11", guests: 6 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.equal(payload.available, false);
    assert.equal(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.minimumNights, 2);
  });

  it("no override anywhere ⇒ unchanged base-min behaviour", async () => {
    const clients = makeClients({ ...fixtures, customMinByDate: {} });
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-12-09", checkOut: "2031-12-10", guests: 6 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.equal(payload.available, false);
    assert.equal(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.minimumNights, 2);
  });

  it("an override may also RAISE the floor (host's explicit per-date choice)", async () => {
    const clients = makeClients({ ...fixtures, customMinByDate: { "2031-03-05": 4 } });
    const result = await executeTool(
      "hemmabo_search_availability",
      { propertyId: PROP, checkIn: "2031-03-05", checkOut: "2031-03-08", guests: 6 },
      clients,
    );
    const payload = parsePayload(result as any);
    assert.equal(payload.available, false);
    assert.equal(payload.reasonCode, "min_nights_violation");
    assert.equal(payload.minimumNights, 4);
  });
});

describe("resolveEffectiveMinNights — override read is fail-closed", () => {
  // Resolver-level calls inject todayUtc — deterministic, so these keep the
  // LIVE DoD window verbatim (custom_min_nights=1 on 2026-12-09).
  const resolverFixtures: Fixtures = { ...fixtures, customMinByDate: { "2026-12-09": 1 } };

  it("returns the override for its arrival day, the base otherwise", async () => {
    const { supabase } = makeClients(resolverFixtures) as any;
    assert.equal(await resolveEffectiveMinNights(supabase, PROP, 2, "2026-12-09", "2026-08-29"), 1);
    assert.equal(await resolveEffectiveMinNights(supabase, PROP, 2, "2026-12-08", "2026-08-29"), 2);
  });

  it("an RPC error yields NO override — the published base floor holds", async () => {
    const { supabase } = makeClients(resolverFixtures) as any;
    const erroring = {
      ...supabase,
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    };
    assert.equal(await resolveEffectiveMinNights(erroring, PROP, 2, "2026-12-09", "2026-08-29"), 2);
  });

  it("an rpc-less client (legacy mocks) degrades to the base, never crashes", async () => {
    const { supabase } = makeClients(resolverFixtures) as any;
    const rpcless = { ...supabase };
    delete rpcless.rpc;
    assert.equal(await resolveEffectiveMinNights(rpcless, PROP, 2, "2026-12-09", "2026-08-29"), 2);
  });
});

describe("vendored core — 3A override anchors (cross-repo parity)", () => {
  const TODAY = "2026-08-29";
  const lastMinute: MinNightsModifiers = {
    setup_completed: true,
    gap_fill_enabled: false,
    gap_fill_min_nights: 1,
    last_minute_enabled: true,
    last_minute_days_before: 7,
    last_minute_min_nights: 1,
  };

  it("override wins over the base in BOTH directions", () => {
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, 1), 1);
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, 4), 4);
  });

  it("override wins over an active last-minute modifier (top precedence)", () => {
    // Arrival inside the last-minute window: modifier alone would give 1;
    // an override of 3 must still win.
    assert.equal(getEffectiveMinNights(2, lastMinute, "2026-09-01", [], TODAY, 3), 3);
  });

  it("invalid override values are ignored (fail-closed to the base/modifier floor)", () => {
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, 0), 2);
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, -1), 2);
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, 1.5), 2);
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY, null), 2);
  });

  it("omitting the sixth argument keeps the pre-3A behaviour (default null)", () => {
    assert.equal(getEffectiveMinNights(2, null, "2026-12-09", [], TODAY), 2);
  });
});
