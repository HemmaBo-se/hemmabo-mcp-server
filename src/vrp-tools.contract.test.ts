import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
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

  it("get_verified_stay_offer verifies signed offer and returns official citation permission", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "vrp-test-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    const offer = {
      protocol: "vacation-rental-protocol",
      protocol_version: "0.1",
      domain: "villaakerlyckan.se",
      check_in: "2026-07-01",
      check_out: "2026-07-08",
      guests: 4,
      currency: "SEK",
      total_price: 2100000,
      availability: "available",
      booking_url: "https://villaakerlyckan.se/book?offer=vrp-test",
      valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      agent_permission: {
        may_quote_as_official_direct_offer: true,
      },
    };
    const header = { alg: "EdDSA", kid: "vrp-test-key", typ: "JWT" };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(offer))}`;
    const signature = sign(null, Buffer.from(signingInput), privateKey);
    const jws = `${signingInput}.${b64url(signature)}`;

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
        return jsonResponse({ offer, signed_verified_stay_offer: jws });
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
    assert.equal(parsed.offer.booking_url, offer.booking_url);
    assert.equal(parsed.agent_citation.agent_message, "I found the official host-domain verified offer for this stay.");
  });
});
