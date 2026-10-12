import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { handleJsonRpc } from "../api/mcp.js";
import { CHATGPT_WIDGET_MODEL_LINE, HEMMABO_ALL_WIDGET_URIS, HEMMABO_NATIVE_WIDGET_URI } from "../lib/apps-widget.js";
import { CHATGPT_WIDGET_TOOL_NAMES, WIDGET_PAYLOAD_META_KEY } from "../lib/chatgpt-surface.js";
import { BLOCKED_AGENT_CLAIMS } from "../lib/vrp.js";

// ADR 0020. A tool result outranks the server instructions, so on
// /mcp/chatgpt a widget tool's result must not order the model to present
// the offer itself, and must not hand it image URLs. The widget presents.

afterEach(() => mock.restoreAll());

const CTX_CHATGPT = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" as const };
const CTX_FULL = { ...CTX_CHATGPT, surface: "full" as const };

const PRESENTATION_ORDER = /VERBATIM|relay|introduce|quote/i;
const IMAGE_URL = /https?:\/\/[^\s"]+?\.(?:jpe?g|png|webp|gif|avif)\b|\/property-images\//i;
const DOMAIN = "stay.example.com";
const PHOTO = "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/test/other/hero.jpg";

type CallResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function compactJws(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: "EdDSA", kid: "test-key", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

/** A host node that signs one available two-night offer. */
function mockHostNode(): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-key", alg: "EdDSA", use: "sig" };
  const offer = {
    kind: "verified_stay_offer",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    node_id: DOMAIN,
    generated_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    request: { check_in: "2027-02-14", check_out: "2027-02-16", nights: 2, guests: 2 },
    property: { id: "prop-test", name: "Test Stay", domain: DOMAIN },
    availability: { available: true, source: "official_host_domain", reason: null },
    price: {
      currency: "EUR",
      total: 900,
      public_total: 900,
      agent_total: 900,
      exact: true,
      no_add_on_fees: true,
      breakdown: [
        { date: "2027-02-14", nightly_rate: 450 },
        { date: "2027-02-15", nightly_rate: 450 },
      ],
      adjustments: [],
      reconciliation: { nightly_subtotal: 900, adjustments_total: 0, computed_total: 900, matches_quoted_total: true },
    },
    source_authority: { model: "host_verified_direct_source", payment_recipient: "host", booking_model: "direct_with_host" },
    booking: { direct_booking_url: `https://${DOMAIN}/book?offer=test`, offer_id: "test" },
    rules: { pets: "allowed", refund_schedule: [{ hours_before_checkin: 24, refund_percent: 100 }], minimum_guest_age: 21 },
    terms: { policy_claims: { affirmed: ["pets_dogs"], negated: ["pets_cats"] }, service_included: ["wifi"], service_not_included: [] },
    agent_permission: { may_quote_as_official_direct_offer: true },
  };
  const jws = compactJws(offer, privateKey);
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/vacation-rental.json") {
      return jsonResponse({
        protocol: "vacation-rental-protocol",
        protocol_version: "0.1",
        canonical_domain: DOMAIN,
        jwks_uri: `https://${DOMAIN}/.well-known/jwks.json`,
        verified_stay_offer_endpoint: `https://${DOMAIN}/api/verified-stay-offer`,
        media: { images: [{ url: PHOTO, alt: "Exterior", category: "exterior" }] },
        claims: [
          { claim: "pets_dogs", state: "affirmed", verified_at: null },
          { claim: "pets_cats", state: "negated", verified_at: null },
        ],
        availability: { check_in_time: "16:00", check_out_time: "11:00" },
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return jsonResponse({ keys: [jwk] });
    if (url.pathname === "/api/verified-stay-offer") {
      return jsonResponse({
        kind: "signed_verified_stay_offer",
        protocol_version: "0.1",
        offer,
        signature: { format: "jws_compact", alg: "EdDSA", kid: "test-key", jws },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

async function callOffer(ctx: typeof CTX_CHATGPT | typeof CTX_FULL): Promise<CallResult> {
  mockHostNode();
  const res = (await handleJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "vrp_get_verified_stay_offer", arguments: { domain: DOMAIN, checkIn: "2027-02-14", checkOut: "2027-02-16", guests: 2 } },
    },
    ctx,
  )) as unknown as { result: CallResult };
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  return res.result;
}

/** Every string the model reads: content text, structuredContent keys and values. */
function modelVisible(result: CallResult): Array<[path: string, text: string]> {
  const out: Array<[string, string]> = result.content.map((c, i) => [`content[${i}]`, c.text]);
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        out.push([`${path}.${key} (key)`, key]);
        walk(v, `${path}.${key}`);
      }
    }
  };
  walk(result.structuredContent, "structuredContent");
  return out;
}

// blocked_claims are prohibitions ("Do not …"), the claims the model must not make.
function isBlockedClaim(path: string, text: string): boolean {
  return /^structuredContent\.blocked_claims\[\d+\]$/.test(path)
    && text.startsWith("Do not ")
    && (BLOCKED_AGENT_CLAIMS as readonly string[]).includes(text);
}

describe("ChatGPT widget surface: what the model reads (ADR 0020)", () => {
  it("the stay offer gives the model one line and a short summary: no presentation orders, no image URLs", async () => {
    const result = await callOffer(CTX_CHATGPT);
    assert.deepEqual(result.content, [{ type: "text", text: CHATGPT_WIDGET_MODEL_LINE }]);
    for (const [path, text] of modelVisible(result)) {
      if (!isBlockedClaim(path, text)) assert.doesNotMatch(text, PRESENTATION_ORDER, `${path} orders the model to present: ${text}`);
      assert.doesNotMatch(text, IMAGE_URL, `${path} hands the model an image URL: ${text}`);
    }
    const summary = result.structuredContent ?? {};
    for (const key of ["guest_welcome", "agent_guardrails", "agent_citation", "widget_media", "official_offer_summary"]) {
      assert.equal(key in summary, false, `${key} must not reach the model on /mcp/chatgpt`);
    }
    assert.equal(summary.verified, true);
    assert.deepEqual(summary.property, { name: "Test Stay" });
    assert.deepEqual(summary.price, { currency: "EUR", exact: true, total: 900 });
    assert.equal(summary.direct_booking_url, `https://${DOMAIN}/book?offer=test`);
    assert.ok((summary.facts as Record<string, unknown>).policy_claims, "facts for follow-up questions stay");
    assert.deepEqual(summary.blocked_claims, [...BLOCKED_AGENT_CLAIMS]);
  });

  it("the widget still gets the full offer, photos included, only in _meta", async () => {
    const result = await callOffer(CTX_CHATGPT);
    const full = result._meta?.[WIDGET_PAYLOAD_META_KEY] as Record<string, any>;
    assert.equal(full.widget_media.images[0].url.startsWith(PHOTO), true);
    assert.ok(full.guest_welcome, "the widget payload is the unshaped result");
    assert.equal(result._meta?.["openai/outputTemplate"], HEMMABO_NATIVE_WIDGET_URI);
  });

  it("/mcp is not shaped", async () => {
    const result = await callOffer(CTX_FULL);
    assert.ok(result.structuredContent?.agent_guardrails);
    assert.ok(result.structuredContent?.guest_welcome);
    assert.equal(result._meta?.[WIDGET_PAYLOAD_META_KEY], undefined);
  });

  it("every widget tool on /mcp/chatgpt has a model view", async () => {
    const res = (await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, CTX_CHATGPT)) as unknown as {
      result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
    };
    const widgetTools = res.result.tools.filter((t) => t._meta?.["openai/outputTemplate"]).map((t) => t.name);
    assert.ok(widgetTools.length > 0);
    for (const name of widgetTools) assert.ok(CHATGPT_WIDGET_TOOL_NAMES.has(name), `${name} renders a widget but has no model view`);
  });

  it("tools/list on /mcp/chatgpt gives no order on how to present a price", async () => {
    const res = (await handleJsonRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, CTX_CHATGPT)) as unknown as {
      result: { tools: Array<{ name: string; outputSchema?: unknown }> };
    };
    const tools = res.result.tools;
    assert.doesNotMatch(JSON.stringify(tools.map((t) => t.outputSchema)), /user-facing copy|Describe directBookingTotal/);
    const offerSchema = JSON.stringify(tools.find((t) => t.name === "vrp_get_verified_stay_offer")?.outputSchema);
    assert.doesNotMatch(offerSchema, PRESENTATION_ORDER);
  });

  it("the widget resource on /mcp/chatgpt describes itself with the same line; /mcp keeps its own", async () => {
    const listed = (await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "resources/list" }, CTX_CHATGPT)) as unknown as {
      result: { resources: Array<{ _meta: Record<string, unknown> }> };
    };
    assert.equal(listed.result.resources[0]._meta["openai/widgetDescription"], CHATGPT_WIDGET_MODEL_LINE);
    const read = async (ctx: typeof CTX_CHATGPT | typeof CTX_FULL) =>
      ((await handleJsonRpc({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: HEMMABO_NATIVE_WIDGET_URI } }, ctx)) as unknown as {
        result: { contents: Array<{ _meta: Record<string, unknown> }> };
      }).result.contents[0]._meta["openai/widgetDescription"];
    assert.equal(await read(CTX_CHATGPT), CHATGPT_WIDGET_MODEL_LINE);
    assert.notEqual(await read(CTX_FULL), CHATGPT_WIDGET_MODEL_LINE);
  });

  it("no widget template carries demo data or a node of its own, and each reads the _meta payload", async () => {
    for (const uri of HEMMABO_ALL_WIDGET_URIS) {
      const res = (await handleJsonRpc({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri } }, CTX_CHATGPT)) as unknown as {
        result: { contents: Array<{ text: string }> };
      };
      const html = res.result.contents[0].text;
      assert.doesNotMatch(html, /demoData|searchParams|villaakerlyckan|3ef1d46d/, `${uri} still carries demo data or one node`);
      assert.ok(html.includes(`"${WIDGET_PAYLOAD_META_KEY}"`), `${uri} must read the full offer from _meta`);
    }
  });
});
