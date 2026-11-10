/**
 * Required amenities: match / no match on the host's own declaration.
 *
 * Audit 2026-11-10 (independent reviewer), reproduced against production by
 * the builder at 18:14Z: lakeviewhome.se declares hot_tub negated and
 * villaakerlyckan.se declares hot_tub affirmed; both declare sauna negated.
 * hemmabo_search_properties had no amenity argument (an added `amenities`
 * was refused by the schema) and a plain search returned both, so a guest
 * asking for a hot tub was shown a node whose host had said no. Lakeview's
 * explicit no was also missing from the search signals and from the offer's
 * model view, so "does Lakeview have a hot tub?" degraded to unknown.
 *
 * Pinned here, with a database double shaped like production:
 *  - a required amenity matches only an affirmed claim; negated and unknown
 *    do not; the stale boolean mirror is never consulted;
 *  - a non-matching node gets no availability check and no alternative date;
 *  - a failed claims read is an error, never a yes and never a no;
 *  - no requirement leaves the search exactly as before;
 *  - more than 20 qualifying nodes are all returned, in name order;
 *  - the host's no reaches the model: signals.amenities_negated and the
 *    offer's amenity_claims (also in the ChatGPT model view).
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import { buildPropertySignals, type ToolClients } from "../lib/tools-base.js";
import {
  meetsAmenityRequirements,
  normalizeAmenityRequirement,
  parseAmenityRequirements,
} from "../lib/amenity-requirements.js";
import { amenityClaimsFromDiscovery } from "../lib/vrp.js";
import { shapeChatgptToolResult } from "../lib/chatgpt-surface.js";
import { handleJsonRpc } from "../api/mcp.js";

type Row = Record<string, unknown>;

const LAKEVIEW = { id: "11111111-1111-4111-8111-111111111111", name: "Lakeview Home", domain: "lakeviewhome.se" };
const VILLA = { id: "22222222-2222-4222-8222-222222222222", name: "Villa Åkerlyckan", domain: "villaakerlyckan.se" };

/** `rowCap`: the most rows the database returns per request (PostgREST max-rows). */
type Fixture = { properties: Row[]; claims: Row[]; detected: Row[]; claimsError: boolean; rowCap?: number };

function propertyRow(p: { id: string; name: string; domain: string }): Row {
  return {
    ...p,
    published: true,
    region: "Skåne",
    city: "Kävlinge",
    country: "Sweden",
    max_guests: 6,
    min_nights: 1,
    buffer_nights_before: 0,
    buffer_nights_after: 0,
  };
}

/** Production shape, 2026-11-10: the two nodes' hot_tub and sauna claims, and the villa's stale mirror. */
function productionFixture(): Fixture {
  return {
    properties: [propertyRow(LAKEVIEW), propertyRow(VILLA)],
    claims: [
      { property_id: LAKEVIEW.id, claim_key: "hot_tub", state: "negated" },
      { property_id: LAKEVIEW.id, claim_key: "sauna", state: "negated" },
      { property_id: LAKEVIEW.id, claim_key: "wifi", state: "affirmed" },
      { property_id: VILLA.id, claim_key: "hot_tub", state: "affirmed" },
      { property_id: VILLA.id, claim_key: "sauna", state: "negated" },
      { property_id: VILLA.id, claim_key: "wifi", state: "affirmed" },
    ],
    // The mirror says the opposite of the ledger for both nodes on purpose:
    // if a requirement ever read it, these tests would fail.
    detected: [
      { property_id: LAKEVIEW.id, has_hot_tub: true, has_sauna: true },
      { property_id: VILLA.id, has_hot_tub: false, has_sauna: true },
    ],
    claimsError: false,
  };
}

let fixture: Fixture = productionFixture();

function makeClients(): ToolClients {
  const rowsOf = (table: string): Row[] => {
    switch (table) {
      case "properties":
        return fixture.properties;
      case "property_attested_claims":
        return fixture.claims;
      case "property_detected_amenities":
        return fixture.detected;
      case "property_blocked_dates":
        // Every node is closed on the requested night, so the search reports
        // each match in unavailableMatches with the node's own next window.
        return fixture.properties.map((p) => ({
          property_id: p.id,
          start_date: "2026-12-10",
          end_date: "2026-12-12",
          source: "manual",
        }));
      default:
        return [];
    }
  };
  const makeQuery = (table: string) => {
    const ops: Array<(r: Row) => boolean> = [];
    let single = false;
    let window: [number, number] | null = null;
    const query: any = {
      select: () => query,
      eq: (c: string, v: unknown) => (ops.push((r) => r[c] === v), query),
      lt: (c: string, v: unknown) => (ops.push((r) => String(r[c]) < String(v)), query),
      gt: (c: string, v: unknown) => (ops.push((r) => String(r[c]) > String(v)), query),
      gte: (c: string, v: unknown) =>
        (ops.push((r) => (typeof v === "number" ? Number(r[c]) >= v : String(r[c]) >= String(v))), query),
      in: (c: string, vs: unknown[]) => (ops.push((r) => vs.includes(r[c])), query),
      or: () => query,
      neq: () => query,
      is: () => query,
      not: () => query,
      order: () => query,
      limit: () => query,
      // One range of the rows the query would return (the search reads to
      // the end, range by range), never more than the server's row cap.
      range: (from: number, to: number) => ((window = [from, to]), query),
      maybeSingle: () => ((single = true), query),
      single: () => ((single = true), query),
      insert: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        if (table === "property_attested_claims" && fixture.claimsError) {
          return Promise.resolve({ data: null, error: { message: "permission denied" } }).then(resolve);
        }
        // The server's row cap cuts every answer, ranged or not: an
        // unpaged query silently gets only the first `rowCap` rows.
        const all = rowsOf(table).filter((r) => ops.every((op) => op(r)));
        const cap = fixture.rowCap ?? Infinity;
        const [from, to] = window ?? [0, Infinity];
        const data = all.slice(from, Math.min(to + 1, from + cap));
        return Promise.resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null }).then(resolve);
      },
    };
    return query;
  };
  const client = { from: (table: string) => makeQuery(table) } as any;
  return { supabase: client, reader: client };
}

// ── Node double: each node's own next window for the closed night ─────────────

let nodeCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    nodeCalls.push(url.hostname);
    const body = {
      available: false,
      reasonCode: "host_blocked",
      nextAvailable: { checkIn: "2026-12-14", checkOut: "2026-12-16", nights: 2 },
    };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fixture = productionFixture();
  nodeCalls = [];
});

const STAY = { guests: 2, checkIn: "2026-12-10", checkOut: "2026-12-12" };

async function search(args: Row): Promise<{ isError?: boolean; json: Record<string, any> }> {
  const result = await executeTool("hemmabo_search_properties", { ...STAY, ...args }, makeClients());
  return { isError: result.isError, json: JSON.parse(result.content[0]?.text ?? "{}") };
}

const names = (list: Array<{ name: string }>) => list.map((p) => p.name);

describe("required amenities in hemmabo_search_properties", () => {
  it("before this change both nodes came back for a hot-tub request; now only the host who declared one", async () => {
    const { isError, json } = await search({ amenities: ["hot_tub"] });
    assert.notEqual(isError, true);
    assert.deepEqual(names(json.unavailableMatches), ["Villa Åkerlyckan"]);
    assert.deepEqual(json.unavailableMatches[0].amenityFacts, { hot_tub: "affirmed" });
    assert.deepEqual(json.amenities, ["hot_tub"]);
    assert.equal(json.amenityRequirement.nodesWithoutConfirmedAmenities, 1);
  });

  it("alternative dates are asked only of nodes that meet the requirement", async () => {
    await search({ amenities: ["hot_tub"] });
    assert.deepEqual(nodeCalls, [VILLA.domain]);
  });

  it("a sauna request matches neither node: both hosts said no", async () => {
    const { json } = await search({ amenities: ["sauna"] });
    assert.deepEqual(json.properties, []);
    assert.deepEqual(json.unavailableMatches, []);
    assert.deepEqual(nodeCalls, []);
    assert.equal(json.amenityRequirement.nodesWithoutConfirmedAmenities, 2);
    assert.match(json.agentGuidance, /No property in this location and capacity has a host-declared yes/);
  });

  it("several requirements all have to be affirmed", async () => {
    const { json } = await search({ amenities: ["hot_tub", "sauna"] });
    assert.deepEqual(json.unavailableMatches, []);
    const both = await search({ amenities: ["hot_tub", "wifi"] });
    assert.deepEqual(names(both.json.unavailableMatches), ["Villa Åkerlyckan"]);
    assert.deepEqual(both.json.unavailableMatches[0].amenityFacts, { hot_tub: "affirmed", wifi: "affirmed" });
  });

  it("unknown is not a match: a node with no claim row for the amenity is left out", async () => {
    fixture.claims = fixture.claims.filter((c) => !(c.property_id === VILLA.id && c.claim_key === "hot_tub"));
    const { json } = await search({ amenities: ["hot_tub"] });
    assert.deepEqual(json.unavailableMatches, []);
  });

  it("the stale boolean mirror never decides a requirement, in either direction", async () => {
    // Mirror: Lakeview has_hot_tub true, Villa has_hot_tub false. Ledger: the opposite.
    const { json } = await search({ amenities: ["hot_tub"] });
    assert.deepEqual(names(json.unavailableMatches), ["Villa Åkerlyckan"]);
    // No claim rows at all: the mirror's true still does not make a match.
    fixture.claims = [];
    const none = await search({ amenities: ["hot_tub"] });
    assert.deepEqual(none.json.unavailableMatches, []);
  });

  it("a failed claims read is an error, not a yes and not a no", async () => {
    fixture.claimsError = true;
    const { isError, json } = await search({ amenities: ["hot_tub"] });
    assert.equal(isError, true);
    assert.match(json.error, /cannot be read right now/);
    assert.equal(json.unavailableMatches, undefined);
    assert.deepEqual(nodeCalls, []);
  });

  it("without a requirement the search is unchanged: both nodes, no amenity fields", async () => {
    const { json } = await search({});
    assert.deepEqual(names(json.unavailableMatches), ["Lakeview Home", "Villa Åkerlyckan"]);
    assert.equal(json.amenities, undefined);
    assert.equal(json.amenityRequirement, undefined);
    for (const m of json.unavailableMatches) assert.equal(m.amenityFacts, undefined);
    // A claims failure does not touch a search without a requirement.
    fixture.claimsError = true;
    const still = await search({});
    assert.deepEqual(names(still.json.unavailableMatches), ["Lakeview Home", "Villa Åkerlyckan"]);
  });

  it("the same requirement, spelled differently, gives the same match set", async () => {
    const spellings = [["hot_tub"], ["Hot tub"], ["HOT-TUB"], ["has_hot_tub"], ["jacuzzi"], ["hot_tub", "hot_tub"]];
    for (const amenities of spellings) {
      const { json } = await search({ amenities });
      assert.deepEqual(names(json.unavailableMatches), ["Villa Åkerlyckan"], JSON.stringify(amenities));
      assert.deepEqual(json.amenities, ["hot_tub"], JSON.stringify(amenities));
    }
  });

  it("a value that is not an amenity name is refused, never silently dropped", async () => {
    for (const amenities of [["hot tub!"], [""], [42], "hot_tub"]) {
      const { isError } = await search({ amenities });
      assert.equal(isError, true, JSON.stringify(amenities));
    }
  });

  it("more than 20 qualifying nodes all come back, in name order, whatever the input order", async () => {
    const many = Array.from({ length: 25 }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return { id: `33333333-3333-4333-8333-3333333333${n}`, name: `Node ${n}`, domain: `node${n}.example` };
    });
    fixture.properties = [...many].reverse().map(propertyRow);
    fixture.claims = many.map((p) => ({ property_id: p.id, claim_key: "hot_tub", state: "affirmed" }));
    const { json } = await search({ amenities: ["hot_tub"] });
    assert.equal(json.unavailableMatches.length, 25);
    assert.deepEqual(names(json.unavailableMatches), many.map((p) => p.name));
  });

  it("capacity still applies before the requirement", async () => {
    const { json } = await search({ guests: 7, amenities: ["hot_tub"] });
    assert.deepEqual(json.unavailableMatches, []);
    assert.match(json.agentGuidance, /No published property matched the location and capacity/);
  });
});

describe("the whole decision basis is read, whatever the server's row cap (review of 1d76fbe)", () => {
  const nodes = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const n = String(i).padStart(4, "0");
      return { id: `44444444-4444-4444-8444-44444444${n}`, name: `Node ${n}`, domain: `node${n}.example` };
    });

  it("100 nodes with 11 claims each under a 1 000-row cap: all 100 match (before: 90)", async () => {
    const many = nodes(100);
    const keys = ["a_a", "b_b", "c_c", "d_d", "e_e", "f_f", "g_g", "h_h", "i_i", "j_j", "sauna"];
    fixture.properties = many.map(propertyRow);
    fixture.claims = many.flatMap((p) => keys.map((k) => ({ property_id: p.id, claim_key: k, state: "affirmed" })));
    fixture.rowCap = 1000;
    const { json } = await search({ amenities: ["sauna"] });
    assert.equal(json.unavailableMatches.length, 100);
    assert.deepEqual(names(json.unavailableMatches), many.map((p) => p.name));
  });

  it("1 001 published nodes with an affirmed hot tub under a 1 000-row cap: all 1 001 are considered", async () => {
    const many = nodes(1001);
    fixture.properties = many.map(propertyRow);
    fixture.claims = many.map((p) => ({ property_id: p.id, claim_key: "hot_tub", state: "affirmed" }));
    fixture.rowCap = 1000;
    const { json } = await search({ amenities: ["hot_tub"] });
    assert.equal(json.unavailableMatches.length, 1001);
  });

  it("a contradicting alias row beyond the cap is still read: the node is unknown, not a match", async () => {
    const filler = Array.from({ length: 1200 }, (_, i) => ({
      property_id: LAKEVIEW.id, claim_key: `c_${String(i).padStart(4, "0")}`, state: "affirmed",
    }));
    fixture.claims = [
      { property_id: LAKEVIEW.id, claim_key: "bbq", state: "affirmed" },
      ...filler,
      { property_id: LAKEVIEW.id, claim_key: "grill", state: "negated" },
    ];
    fixture.rowCap = 1000;
    const { json } = await search({ amenities: ["grill"] });
    assert.deepEqual(json.unavailableMatches, []);
  });
});

describe("claim rows are read under their canonical key (review of becbbfe)", () => {
  it("an alias row meets the canonical requirement: bbq affirmed matches grill", async () => {
    fixture.claims.push({ property_id: LAKEVIEW.id, claim_key: "bbq", state: "affirmed" });
    for (const amenities of [["grill"], ["bbq"]]) {
      const { json } = await search({ amenities });
      assert.deepEqual(names(json.unavailableMatches), ["Lakeview Home"], JSON.stringify(amenities));
      assert.deepEqual(json.unavailableMatches[0].amenityFacts, { grill: "affirmed" });
    }
  });

  it("an alias and its canonical key that disagree are unknown, in either order: no match", async () => {
    for (const rows of [
      [["grill", "affirmed"], ["bbq", "negated"]],
      [["bbq", "negated"], ["grill", "affirmed"]],
      [["bbq", "affirmed"], ["grill", "negated"]],
    ]) {
      fixture = productionFixture();
      for (const [claim_key, state] of rows) fixture.claims.push({ property_id: VILLA.id, claim_key, state });
      const { json } = await search({ amenities: ["grill"] });
      assert.deepEqual(json.unavailableMatches, [], JSON.stringify(rows));
      const without = await search({ excludedAmenities: ["grill"] });
      assert.deepEqual(without.json.unavailableMatches, [], JSON.stringify(rows));
    }
  });
});

describe("must be without: only a host-declared no matches", () => {
  it("without a hot tub returns Lakeview only; the villa has one", async () => {
    const { json } = await search({ excludedAmenities: ["hot_tub"] });
    assert.deepEqual(names(json.unavailableMatches), ["Lakeview Home"]);
    assert.deepEqual(json.unavailableMatches[0].amenityFacts, { hot_tub: "negated" });
    assert.deepEqual(json.excludedAmenities, ["hot_tub"]);
    assert.deepEqual(nodeCalls, [LAKEVIEW.domain]);
  });

  it("unknown does not prove absence: a node that never answered is not a match", async () => {
    const { json } = await search({ excludedAmenities: ["pool"] });
    assert.deepEqual(json.unavailableMatches, []);
  });

  it("combines with a requirement, and refuses a contradiction", async () => {
    const both = await search({ amenities: ["wifi"], excludedAmenities: ["sauna"] });
    assert.deepEqual(names(both.json.unavailableMatches), ["Lakeview Home", "Villa Åkerlyckan"]);
    const clash = await search({ amenities: ["hot_tub"], excludedAmenities: ["jacuzzi"] });
    assert.equal(clash.isError, true);
  });

  it("a failed claims read is an error here too", async () => {
    fixture.claimsError = true;
    const { isError } = await search({ excludedAmenities: ["hot_tub"] });
    assert.equal(isError, true);
  });
});

describe("the requirement helpers", () => {
  it("normalize to one canonical claim key", () => {
    assert.equal(normalizeAmenityRequirement("hot_tub"), "hot_tub");
    assert.equal(normalizeAmenityRequirement(" Hot Tub "), "hot_tub");
    assert.equal(normalizeAmenityRequirement("has_hot_tub"), "hot_tub");
    assert.equal(normalizeAmenityRequirement("bbq"), "grill");
    assert.equal(normalizeAmenityRequirement("crib"), "crib_available");
    assert.equal(normalizeAmenityRequirement("x"), null);
    assert.equal(normalizeAmenityRequirement(7), null);
  });

  it("parse an absent argument as no requirement and sort a present one", () => {
    assert.deepEqual(parseAmenityRequirements(undefined), { ok: true, required: [] });
    assert.deepEqual(parseAmenityRequirements(["wifi", "hot_tub", "wifi"]), { ok: true, required: ["hot_tub", "wifi"] });
  });

  it("match only on affirmed", () => {
    const claims = { affirmed: new Set(["hot_tub"]), negated: new Set(["sauna"]) };
    assert.equal(meetsAmenityRequirements(claims, ["hot_tub"]), true);
    assert.equal(meetsAmenityRequirements(claims, ["sauna"]), false);
    assert.equal(meetsAmenityRequirements(claims, ["pool"]), false);
    assert.equal(meetsAmenityRequirements(undefined, ["hot_tub"]), false);
    assert.equal(meetsAmenityRequirements(undefined, []), true);
  });
});

describe("the host's no reaches the model", () => {
  it("search signals list an explicit amenity no; an unanswered amenity is not listed", () => {
    const claims = {
      affirmed: new Set(["wifi"]),
      negated: new Set(["hot_tub", "sauna"]),
      known: new Set(["wifi", "hot_tub", "sauna"]),
    };
    const signals = buildPropertySignals({ property_id: LAKEVIEW.id, has_hot_tub: true }, claims);
    assert.deepEqual(signals?.amenities_negated, ["hot_tub", "sauna"]);
    assert.ok(!signals?.amenities?.includes("hot_tub"), "the ledger's no beats the mirror's true");
    const unanswered = buildPropertySignals({ property_id: VILLA.id }, {
      affirmed: new Set(),
      negated: new Set(),
      known: new Set(),
    });
    assert.equal(unanswered?.amenities_negated, undefined);
  });

  // The two nodes' discovery claims as served 2026-11-10 18:14Z (excerpt).
  const LAKEVIEW_DISCOVERY = {
    amenities: ["wifi", "fireplace", "ev_charging", "garden"],
    claims: [
      { claim: "wifi", state: "affirmed" },
      { claim: "hot_tub", state: "negated" },
      { claim: "sauna", state: "negated" },
      { claim: "pool", state: "negated" },
      { claim: "bbq", state: "affirmed" },
      { claim: "pets_dogs", state: "affirmed" },
    ],
  };

  it("the offer's amenity_claims keeps every answered yes and no, apart from the card's short row", () => {
    const facts = amenityClaimsFromDiscovery(LAKEVIEW_DISCOVERY);
    assert.deepEqual(facts, { affirmed: ["grill", "wifi"], negated: ["hot_tub", "pool", "sauna"] });
  });

  it("no claims, or a claim the node states both ways, gives unknown, never a guess", () => {
    assert.equal(amenityClaimsFromDiscovery({ amenities: ["hot_tub"] }), null);
    assert.equal(amenityClaimsFromDiscovery({ claims: "broken" }), null);
    const both = amenityClaimsFromDiscovery({
      claims: [
        { claim: "bbq", state: "affirmed" },
        { claim: "grill", state: "negated" },
      ],
    });
    assert.deepEqual(both, { affirmed: [], negated: [] });
  });

  it("the ChatGPT model view of the offer carries amenity_claims among its facts", () => {
    const amenityClaims = amenityClaimsFromDiscovery(LAKEVIEW_DISCOVERY);
    const full = {
      domain: LAKEVIEW.domain,
      verified: true,
      official_offer_summary: {
        property: { name: "Lakeview Home", amenities: ["WiFi", "Fireplace", "EV charging", "Garden"] },
        amenity_claims: amenityClaims,
      },
    };
    const shaped = shapeChatgptToolResult("vrp_get_verified_stay_offer", {
      content: [{ type: "text", text: "{}" }],
      structuredContent: full,
    });
    const facts = (shaped.structuredContent as Record<string, any>).facts;
    assert.deepEqual(facts.amenity_claims.negated, ["hot_tub", "pool", "sauna"]);
    assert.deepEqual(facts.amenities, ["WiFi", "Fireplace", "EV charging", "Garden"]);
  });

  it("the ChatGPT surface's search tool accepts amenities", async () => {
    const res = (await handleJsonRpc(
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" },
    )) as unknown as { result?: { tools?: Array<{ name: string; inputSchema?: Record<string, any> }> } };
    const search = res.result?.tools?.find((t) => t.name === "hemmabo_search_properties");
    assert.equal(search?.inputSchema?.properties?.amenities?.type, "array");
    assert.deepEqual(search?.inputSchema?.required, ["guests", "checkIn", "checkOut"]);
  });
});
