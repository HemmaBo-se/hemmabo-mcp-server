import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";

afterEach(() => mock.restoreAll());

const clients = { supabase: null as never, reader: null as never };

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function compactJws(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: "EdDSA", kid: "vrp-test-key", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

describe("VRP MCP tools", () => {
  it("verify_vacation_rental_node verifies discovery and Ed25519 JWKS without Supabase", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "vrp-test-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/vacation-rental.json") {
        return jsonResponse({
          protocol: "vacation-rental-protocol",
          protocol_version: "0.1",
          canonical_domain: "villaakerlyckan.se",
          jwks_uri: "https://villaakerlyckan.se/.well-known/jwks.json",
          verified_stay_offer_endpoint: "https://villaakerlyckan.se/api/verified-stay-offer",
        });
      }
      if (url.pathname === "/.well-known/jwks.json") {
        return jsonResponse({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executeTool("verify_vacation_rental_node", { domain: "villaakerlyckan.se" }, clients);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verified, true);
    assert.equal(parsed.protocol, "vacation-rental-protocol");
    assert.equal(parsed.protocol_version, "0.1");
    assert.equal(parsed.signing.alg, "EdDSA");
  });

  it("get_verified_stay_offer reads production signature.jws and returns safe quote guardrails", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "vrp-test-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    const offer = {
      kind: "verified_stay_offer",
      protocol_version: "0.1",
      canonical_domain: "villaakerlyckan.se",
      node_id: "villaakerlyckan.se",
      generated_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      request: {
        check_in: "2026-07-01",
        check_out: "2026-07-08",
        nights: 7,
        guests: 4,
      },
      property: {
        id: "prop-test",
        name: "Villa Åkerlyckan",
        domain: "villaakerlyckan.se",
      },
      availability: {
        available: true,
        source: "official_host_domain",
        reason: null,
      },
      price: {
        currency: "SEK",
        total: 21000,
        public_total: 21000,
        agent_total: 17850,
        agent_discount_pct: 15,
        savings_vs_public_total: 3150,
        discount_basis: "direct_booking_ai_agent",
        ota_comparison_total: null,
        ota_comparison_source: null,
        exact: true,
        package_applied: null,
        breakdown: [
          { date: "2026-07-01", day_of_week: "Wed", nightly_rate: 3000 },
        ],
      },
      booking: {
        direct_booking_url: "https://villaakerlyckan.se/book?offer=vrp-test",
        offer_id: "vrp-test",
      },
      agent_permission: {
        may_quote_as_official_direct_offer: true,
      },
    };
    const jws = compactJws(offer, privateKey);

    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/vacation-rental.json") {
        return jsonResponse({
          protocol: "vacation-rental-protocol",
          protocol_version: "0.1",
          canonical_domain: "villaakerlyckan.se",
          jwks_uri: "https://villaakerlyckan.se/.well-known/jwks.json",
          verified_stay_offer_endpoint: "https://villaakerlyckan.se/api/verified-stay-offer",
        });
      }
      if (url.pathname === "/.well-known/jwks.json") {
        return jsonResponse({ keys: [jwk] });
      }
      if (url.pathname === "/api/verified-stay-offer") {
        assert.equal(url.searchParams.get("check_in"), "2026-07-01");
        assert.equal(url.searchParams.get("check_out"), "2026-07-08");
        assert.equal(url.searchParams.get("guests"), "4");
        return jsonResponse({
          kind: "signed_verified_stay_offer",
          protocol_version: "0.1",
          offer,
          signature: {
            format: "jws_compact",
            alg: "EdDSA",
            kid: "vrp-test-key",
            jws,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executeTool("get_verified_stay_offer", {
      domain: "villaakerlyckan.se",
      check_in: "2026-07-01",
      check_out: "2026-07-08",
      guests: 4,
    }, clients);

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verified, true);
    assert.equal(parsed.signature.verified, true);
    assert.equal(parsed.payload_matches_offer, true);
    assert.equal(parsed.fresh, true);
    assert.equal(parsed.signed_verified_stay_offer, jws);
    assert.equal(parsed.offer.booking.direct_booking_url, offer.booking.direct_booking_url);
    assert.equal(parsed.agent_citation.agent_message, "I found the official host-domain verified offer for this stay. AI/direct booking total: 17850 SEK.");
    assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, true);
    assert.equal(parsed.official_offer_summary.price.total, 21000);
    assert.equal(parsed.official_offer_summary.price.public_total, 21000);
    assert.equal(parsed.official_offer_summary.price.agent_total, 17850);
    assert.equal(parsed.official_offer_summary.price.agent_discount_pct, 15);
    assert.equal(parsed.official_offer_summary.price.savings_vs_public_total, 3150);
    assert.equal(parsed.official_offer_summary.price.discount_basis, "direct_booking_ai_agent");
    assert.equal(parsed.official_offer_summary.price.ota_comparison_total, null);
    assert.equal(parsed.official_offer_summary.direct_booking_url, offer.booking.direct_booking_url);
    assert.equal(parsed.agent_guardrails.must_not_invent_discounts, true);
    assert.equal(parsed.agent_guardrails.must_not_claim_ota_comparison_without_signed_ota_price, true);
    assert.match(parsed.agent_guardrails.price_claim_rule, /Never call public_total an OTA price/);
    assert.match(parsed.agent_guardrails.blocked_claims.join("\n"), /Do not invent discounts/);
  });

  it("get_verified_stay_offer refuses quoteable status for signed but unavailable offers", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "vrp-test-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    const offer = {
      kind: "verified_stay_offer",
      protocol_version: "0.1",
      canonical_domain: "villaakerlyckan.se",
      node_id: "villaakerlyckan.se",
      generated_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      availability: {
        available: false,
        source: "official_host_domain",
        reason: "not_available",
      },
      price: {
        currency: "SEK",
        total: null,
        exact: false,
        package_applied: null,
      },
      booking: {
        direct_booking_url: "https://villaakerlyckan.se/book?offer=blocked",
      },
      agent_permission: {
        may_quote_as_official_direct_offer: false,
      },
    };
    const jws = compactJws(offer, privateKey);

    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/vacation-rental.json") {
        return jsonResponse({
          protocol: "vacation-rental-protocol",
          protocol_version: "0.1",
          canonical_domain: "villaakerlyckan.se",
          jwks_uri: "https://villaakerlyckan.se/.well-known/jwks.json",
          verified_stay_offer_endpoint: "https://villaakerlyckan.se/api/verified-stay-offer",
        });
      }
      if (url.pathname === "/.well-known/jwks.json") {
        return jsonResponse({ keys: [jwk] });
      }
      if (url.pathname === "/api/verified-stay-offer") {
        return jsonResponse({
          kind: "signed_verified_stay_offer",
          protocol_version: "0.1",
          offer,
          signature: {
            format: "jws_compact",
            alg: "EdDSA",
            kid: "vrp-test-key",
            jws,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executeTool("get_verified_stay_offer", {
      domain: "villaakerlyckan.se",
      check_in: "2026-05-22",
      check_out: "2026-05-24",
      guests: 6,
    }, clients);

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verified, true);
    assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, false);
    assert.equal(parsed.agent_citation.agent_message, null);
    assert.equal(parsed.agent_citation.blocked_reason, "agent_permission_denied");
    assert.equal(parsed.official_offer_summary.bookable, false);
    assert.equal(parsed.official_offer_summary.available, false);
    assert.equal(parsed.agent_guardrails.safe_to_quote, false);
  });
});
