// Core §2 + §5.1 (ADR 0009): the guest's booking link is a node URL, on the
// host's own domain or its www. name. Any other name under the domain
// (airbnb.villaakerlyckan.se) may be served by another party, so the offer is
// not quoteable and no link is handed on. The link is read from the signed
// payload only; an unsigned field in the response never becomes it.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";
import { isNodeUrl } from "../lib/vrp.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";

// VRP Core §2: the verifier reads the Public Suffix List and ICANN's gTLD list;
// these fetch mocks answer 404 for them, so the lists are seeded here.
primeHostOwnedLists({ icannRules: ["com", "se", "si"], specification13Tlds: [] });

afterEach(() => mock.restoreAll());

const clients = { supabase: null as never, reader: null as never };
const DOMAIN = "villaakerlyckan.se";

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
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

async function offerWithBooking(
  booking: Record<string, unknown> | undefined,
  unsignedResponseBooking?: Record<string, unknown>,
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "vrp-test-key";
  jwk.alg = "EdDSA";

  const offer: Record<string, unknown> = {
    kind: "verified_stay_offer",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    node_id: DOMAIN,
    generated_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    availability: { available: true, source: "official_host_domain", reason: null },
    price: { currency: "SEK", total: 6000, exact: true, package_applied: null },
    agent_permission: { may_quote_as_official_direct_offer: true },
  };
  if (booking) offer.booking = booking;
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
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return jsonResponse({ keys: [jwk] });
    if (url.pathname === "/api/verified-stay-offer") {
      return jsonResponse({
        kind: "signed_verified_stay_offer",
        protocol_version: "0.1",
        offer,
        signature: { format: "jws_compact", alg: "EdDSA", kid: "vrp-test-key", jws },
        ...(unsignedResponseBooking
          ? { booking: unsignedResponseBooking, direct_booking_url: unsignedResponseBooking.direct_booking_url }
          : {}),
      });
    }
    return new Response("not found", { status: 404 });
  });

  const result = await executeTool("vrp_get_verified_stay_offer", {
    domain: DOMAIN,
    check_in: "2026-12-04",
    check_out: "2026-12-06",
    guests: 2,
  }, clients);
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

describe("the booking link is a node URL (Core §2, §5.1)", () => {
  for (const url of [`https://${DOMAIN}/book?offer=a`, `https://www.${DOMAIN}/book?offer=a`]) {
    it(`passes ${new URL(url).hostname}`, async () => {
      const parsed = await offerWithBooking({ direct_booking_url: url });
      assert.equal(parsed.official_offer_summary.direct_booking_url, url);
      assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, true);
      assert.equal(parsed.agent_citation.blocked_reason, null);
    });
  }

  for (const url of [
    `https://airbnb.${DOMAIN}/book?offer=a`,
    `https://book.www.${DOMAIN}/book`,
    `https://${DOMAIN}.example.com/book`,
    "https://other-node.se/book",
    `http://${DOMAIN}/book`,
    `https://${DOMAIN}:8443/book`,
    `https://user@${DOMAIN}/book`,
  ]) {
    it(`blocks ${url}`, async () => {
      const parsed = await offerWithBooking({ direct_booking_url: url });
      assert.equal(parsed.official_offer_summary.direct_booking_url, null);
      assert.equal(parsed.official_offer_summary.bookable, false);
      assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, false);
      assert.equal(parsed.agent_citation.blocked_reason, "direct_booking_url_not_node_url");
      assert.equal(parsed.agent_guardrails.safe_to_quote, false);
    });
  }

  it("never takes the link from an unsigned field in the response", async () => {
    const parsed = await offerWithBooking(undefined, {
      direct_booking_url: `https://${DOMAIN}/book?offer=unsigned`,
    });
    assert.equal(parsed.official_offer_summary.direct_booking_url, null);
    assert.equal(parsed.agent_citation.blocked_reason, "direct_booking_url_missing");
    assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, false);
  });

  it("isNodeUrl accepts the default https port written out", () => {
    assert.equal(isNodeUrl(`https://${DOMAIN}:443/book`, DOMAIN), true);
    assert.equal(isNodeUrl("not a url", DOMAIN), false);
  });
});
