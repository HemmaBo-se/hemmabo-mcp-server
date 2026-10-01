/**
 * Contract (ADR 0019, CEO decision 2026-10-01): the platform connector
 * (www.hemmabo.com/mcp and /.well-known/mcp.json) is catalog and verifier.
 *
 * It serves exactly six tools, writes no bookings and moves no money. The
 * seven booking tools (quote, create, negotiate, checkout, cancel, status,
 * reschedule) are absent from tools/list, TOOL_SPECS and the manifest, and a
 * tools/call to any of them fails closed: auth is required (unknown name),
 * and with auth it is an unknown tool — no handler runs. Search hits carry
 * the node's own booking_url and are ordered by name, never by price.
 *
 * Run: npx tsx --test src/connector-catalog-verifier.contract.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import handler, { CHATGPT_TOOL_NAMES, handleJsonRpc, isAuthRequiredMessage } from "../api/mcp.js";
import manifestHandler from "../api/mcp-manifest.js";
import { TOOL_NAMES, TOOL_SPECS } from "../lib/tool-definitions.js";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS } from "../lib/server-metadata.js";
import { executeTool, type ToolClients } from "../lib/tools.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SIX = [
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
] as const;

const REMOVED = [
  "hemmabo_booking_quote",
  "hemmabo_booking_create",
  "hemmabo_booking_negotiate",
  "hemmabo_booking_checkout",
  "hemmabo_booking_cancel",
  "hemmabo_booking_status",
  "hemmabo_booking_reschedule",
] as const;

const REMOVED_ALIASES = [
  "booking.quote",
  "booking.create",
  "booking.negotiate",
  "booking.checkout",
  "booking.cancel",
  "booking.status",
  "booking.reschedule",
] as const;

const COUNT_SENTENCE = "6 runtime tools: 2 HemmaBo tools, 2 host onboarding tools, and 2 VRP verification tools.";

const CTX_FULL = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "full" as const };
const CTX_CHATGPT = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" as const };

async function listNames(ctx: typeof CTX_FULL | typeof CTX_CHATGPT): Promise<string[]> {
  const res = (await handleJsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 }, ctx)) as unknown as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (res.result?.tools ?? []).map((t) => t.name);
}

async function manifest(): Promise<{ tools: Array<{ name: string; auth: string }> }> {
  const captured: Record<string, unknown> = {};
  const fakeRes = {
    setHeader: () => {},
    json: (body: Record<string, unknown>) => Object.assign(captured, body),
  };
  await manifestHandler({ headers: {} } as never, fakeRes as never);
  return captured as unknown as { tools: Array<{ name: string; auth: string }> };
}

/** Clients whose every property access throws: proves no handler touched the database. */
function trapClients(): ToolClients {
  const trap = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`unexpected supabase call (.${String(prop)})`);
    },
  });
  return { supabase: trap as never, reader: trap as never };
}

describe("platform connector tool surface (ADR 0019)", () => {
  it("tools/list on the full surface returns exactly the six tools, in declaration order", async () => {
    assert.deepEqual(await listNames(CTX_FULL), [...SIX]);
    assert.deepEqual([...TOOL_NAMES], [...SIX]);
  });

  it("/mcp/chatgpt still lists exactly its 3 tools", async () => {
    const names = await listNames(CTX_CHATGPT);
    assert.equal(names.length, 3);
    assert.deepEqual([...names].sort(), [...CHATGPT_TOOL_NAMES].sort());
  });

  it("the mcp.json manifest lists exactly the six tools, each anonymous", async () => {
    const body = await manifest();
    assert.deepEqual(body.tools.map((t) => t.name), [...SIX]);
    for (const t of body.tools) assert.equal(t.auth, "none", `${t.name} must be anonymous`);
  });

  const manifestSource = readFileSync(join(ROOT, "api/mcp-manifest.ts"), "utf8");
  for (const name of REMOVED) {
    it(`${name} is absent from tools/list, TOOL_SPECS and MANIFEST_SUMMARIES`, async () => {
      assert.ok(!(await listNames(CTX_FULL)).includes(name), `${name} must not be in tools/list`);
      assert.ok(!TOOL_SPECS.some((t) => t.name === name), `${name} must not be in TOOL_SPECS`);
      assert.ok(!(await manifest()).tools.some((t) => t.name === name), `${name} must not be in mcp.json tools`);
      assert.ok(!manifestSource.includes(`"${name}"`), `${name} must not be in MANIFEST_SUMMARIES`);
    });
  }

  it("the full-surface description and instructions carry the count sentence and no removed tool", () => {
    for (const text of [SERVER_DESCRIPTION, SERVER_INSTRUCTIONS]) {
      assert.ok(text.includes(COUNT_SENTENCE), "count sentence must be present verbatim");
      assert.doesNotMatch(text, /hemmabo_booking_/);
      assert.doesNotMatch(text, /\b13 runtime tools\b|\b9 HemmaBo tools\b/);
    }
  });
});

describe("tools/call to a removed booking tool fails closed", () => {
  it("auth is required for every removed name, canonical and dotted (unknown name)", () => {
    for (const name of [...REMOVED, ...REMOVED_ALIASES]) {
      assert.equal(
        isAuthRequiredMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        true,
        `${name} must require auth`,
      );
    }
  });

  it("with auth, every removed name is an unknown tool and no handler runs", async () => {
    for (const name of [...REMOVED, ...REMOVED_ALIASES]) {
      const result = await executeTool(name, {}, trapClients());
      assert.equal(result.isError, true, `${name} must be an error`);
      assert.equal(JSON.parse(result.content[0].text).error, `Unknown tool: ${name}`);
    }
  });

  describe("over HTTP without Authorization", () => {
    let prevApiKey: string | undefined;
    before(() => {
      prevApiKey = process.env.MCP_API_KEY;
      process.env.MCP_API_KEY = "test-master-key-for-contract-only";
    });
    after(() => {
      if (prevApiKey === undefined) delete process.env.MCP_API_KEY;
      else process.env.MCP_API_KEY = prevApiKey;
    });

    it("POST /mcp tools/call hemmabo_booking_checkout answers 401 with WWW-Authenticate", async () => {
      const captured = { status: 200, headers: {} as Record<string, string> };
      const res = {
        setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
        status: (code: number) => { captured.status = code; return res; },
        json: () => res,
        end: () => res,
      };
      const req = {
        method: "POST",
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.test", "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hemmabo_booking_checkout", arguments: {} } },
      };
      await handler(req as never, res as never);
      assert.equal(captured.status, 401);
      assert.match(captured.headers["www-authenticate"] ?? "", /^Bearer /);
    });
  });
});

// ── Search hits carry the node's own booking_url ─────────────────────────────

type Row = Record<string, unknown>;

const ALPHA = "00000000-0000-0000-0000-0000000000a1";
const BETA = "00000000-0000-0000-0000-0000000000b2";

function propertyRow(id: string, name: string, domain: string | null): Row {
  return {
    id,
    published: true,
    name,
    domain,
    region: "Skåne",
    city: "Kävlinge",
    country: "Sweden",
    latitude: null,
    longitude: null,
    max_guests: 6,
    currency: "SEK",
    property_type: "villa",
    direct_booking_discount: 0,
    min_nights: 1,
    max_nights: 30,
    buffer_nights_before: 0,
    buffer_nights_after: 0,
  };
}

function priceBlock(propertyId: string, weekday: number, weekend: number): Row {
  return {
    property_id: propertyId,
    guests: 6,
    low_weekday: weekday,
    low_weekend: weekend,
    high_weekday: weekday,
    high_weekend: weekend,
    low_week: null,
    high_week: null,
    low_two_weeks: null,
    high_two_weeks: null,
  };
}

const TABLES: Record<string, Row[]> = {
  // Alpha is the more expensive node and still comes first: name order, not price.
  properties: [propertyRow(BETA, "Beta Villa", null), propertyRow(ALPHA, "Alpha Villa", " VillaAkerlyckan.SE ")],
  property_price_blocks: [priceBlock(ALPHA, 3000, 3600), priceBlock(BETA, 1000, 1200)],
  property_seasons: [
    { property_id: ALPHA, name: "low", date_from: "2031-09-01", date_to: "2031-09-30", type: "low" },
    { property_id: BETA, name: "low", date_from: "2031-09-01", date_to: "2031-09-30", type: "low" },
  ],
};

function searchClients(): ToolClients {
  const makeQuery = (table: string) => {
    const ops: Array<(r: Row) => boolean> = [];
    let singleMode = false;
    const query: any = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        ops.push((r) => !(column in r) || r[column] === value);
        return query;
      },
      in: () => query,
      gte: () => query,
      lte: () => query,
      lt: () => query,
      gt: () => query,
      or: () => query,
      neq: () => query,
      is: () => query,
      not: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: () => { singleMode = true; return query; },
      single: () => { singleMode = true; return query; },
      then: (resolve: (value: unknown) => unknown) => {
        const data = (TABLES[table] ?? []).filter((r) => ops.every((op) => op(r)));
        return Promise.resolve(singleMode ? { data: data[0] ?? null, error: null } : { data, error: null }).then(resolve);
      },
    };
    return query;
  };
  const client = { from: (table: string) => makeQuery(table) } as any;
  return { supabase: client, reader: client };
}

describe("hemmabo_search_properties hits carry the node's own booking_url", () => {
  it("booking_url is https:// + the trimmed, lower-cased domain, or null without a domain; order is by name, not price", async () => {
    const result = await executeTool(
      "hemmabo_search_properties",
      { guests: 2, checkIn: "2031-09-03", checkOut: "2031-09-06" },
      searchClients(),
    );
    assert.notEqual(result.isError, true, result.content[0]?.text);
    const payload = JSON.parse(result.content[0].text) as { properties: Array<Record<string, any>>; agentGuidance: string };
    assert.equal(payload.properties.length, 2, result.content[0].text);

    const [first, second] = payload.properties;
    assert.equal(first.name, "Alpha Villa");
    assert.equal(first.booking_url, "https://villaakerlyckan.se");
    assert.equal(second.name, "Beta Villa");
    assert.equal(second.booking_url, null);

    // Not sorted by price: the more expensive node comes first because of its name.
    assert.ok(first.directBookingTotal > second.directBookingTotal, "fixture must put the dearer node first");
    for (const hit of payload.properties) {
      assert.equal("score" in hit, false, "no score on a search hit");
      assert.equal("ota_comparison_total" in hit, false, "no OTA comparison on a search hit");
    }
    assert.match(payload.agentGuidance, /booking_url/);
    assert.doesNotMatch(payload.agentGuidance, /does not return a booking URL/);
  });

  it("the outputSchema declares booking_url as a nullable URI", () => {
    const spec = TOOL_SPECS.find((t) => t.name === "hemmabo_search_properties");
    const item = (spec?.outputSchema.properties.properties as { items?: { properties?: Record<string, any> } }).items;
    const field = item?.properties?.booking_url;
    assert.ok(field, "booking_url must be declared on each search hit");
    assert.deepEqual(field.type, ["string", "null"]);
    assert.equal(field.format, "uri");
  });
});
