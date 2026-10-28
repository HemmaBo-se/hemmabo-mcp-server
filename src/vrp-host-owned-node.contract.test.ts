// VRP Core §2 and §7 (vrp-spec ADR 0009) in the reference verifier:
//   - a node is a host-owned domain, never a name under another party's domain
//     (host_owned + real_world vectors, examples/conformance/host-domain);
//   - a fetch follows a redirect only to a node URL of that domain (redirects);
//   - the signed offer names the domain it was fetched from (offer_binding);
//   - the lists unreadable = unknown = nothing verified (§9).
import { afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";
import { checkHostOwned } from "../lib/host-owned-domain.js";
import { loadHostOwnedLists, primeHostOwnedLists } from "../lib/host-owned-lists.js";

// vrp-spec examples/conformance/host-domain/vectors.v0.1.json: the list
// entries the vectors depend on (psl_icann_rules, icann_specification13_tlds).
const LISTS = {
  icannRules: ["com", "uk", "co.uk", "se", "si", "invalid", "*.ck", "!www.ck", "cn", "公司.cn", "booking", "hotels", "amazon", "google"],
  specification13Tlds: ["amazon", "google"],
};

const VECTORS: Array<[string, string | null]> = [
  ["example.com", null],
  ["example.co.uk", null],
  ["example-host.invalid", null],
  ["xn--exmple-cua.com", null],
  ["example.xn--55qx5d.cn", null],
  ["host.example.ck", null],
  ["www.ck", null],
  ["www.example.com", "not_host_owned"],
  ["villa.platform.example", "not_host_owned"],
  ["com", "public_suffix"],
  ["co.uk", "public_suffix"],
  ["xn--55qx5d.cn", "public_suffix"],
  ["example.ck", "public_suffix"],
  ["Example.com", "malformed_domain"],
  ["example.com.", "malformed_domain"],
  ["exämple.com", "malformed_domain"],
  ["example.se", null],
  ["villa.myshopify.com", "not_host_owned"],
  ["villa.wixsite.com", "not_host_owned"],
  ["villa.airbnb.com", "not_host_owned"],
  ["villa.hemmabo.com", "not_host_owned"],
  ["annanvilla.exempelplattform.com", "not_host_owned"],
  ["villa.booking", "closed_tld"],
  ["villa.hotels", "closed_tld"],
  ["villa.amazon", "closed_tld"],
  ["villa.google", "closed_tld"],
  ["villaakerlyckan.se", null],
  ["airbnb.villaakerlyckan.se", "not_host_owned"],
];

const clients = { supabase: null as never, reader: null as never };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function compactJws(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: "EdDSA", kid: "vrp-test-key", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

type NodeMock = {
  domain: string;
  offerDomain?: string;
  discoveryRedirect?: string[]; // chain of Location headers before the document
  jwksRedirect?: string[];
};

function mockNode({ domain, offerDomain = domain, discoveryRedirect = [], jwksRedirect = [] }: NodeMock) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "vrp-test-key";
  jwk.alg = "EdDSA";
  const offer = {
    kind: "verified_stay_offer",
    protocol_version: "0.1",
    canonical_domain: offerDomain,
    node_id: offerDomain,
    generated_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    availability: { available: true, source: "official_host_domain", reason: null },
    price: { currency: "SEK", total: 6000, exact: true, package_applied: null },
    agent_permission: { may_quote_as_official_direct_offer: true },
    booking: { direct_booking_url: `https://${offerDomain}/book?offer=a` },
  };
  const jws = compactJws(offer, privateKey);
  const discoveryHops = [...discoveryRedirect];
  const jwksHops = [...jwksRedirect];
  const seen: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    if (url.pathname === "/.well-known/vacation-rental.json") {
      const hop = discoveryHops.shift();
      if (hop) return redirectResponse(hop);
      return jsonResponse({
        protocol: "vacation-rental-protocol",
        protocol_version: "0.1",
        canonical_domain: domain,
        jwks_uri: `https://${domain}/.well-known/jwks.json`,
        verified_stay_offer_endpoint: `https://${domain}/api/verified-stay-offer`,
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      const hop = jwksHops.shift();
      if (hop) return redirectResponse(hop);
      return jsonResponse({ keys: [jwk] });
    }
    if (url.pathname === "/api/verified-stay-offer") {
      return jsonResponse({
        kind: "signed_verified_stay_offer",
        protocol_version: "0.1",
        offer,
        signature: { format: "jws_compact", alg: "EdDSA", kid: "vrp-test-key", jws },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { seen };
}

async function verifyNode(domain: string) {
  const result = await executeTool("vrp_verify_node", { domain }, clients);
  return { result, parsed: JSON.parse(result.content[0].text) };
}

async function getOffer(domain: string) {
  const result = await executeTool("vrp_get_verified_stay_offer", { domain, check_in: "2026-12-04", check_out: "2026-12-06", guests: 2 }, clients);
  return { result, parsed: JSON.parse(result.content[0].text) };
}

describe("host-owned domain (Core §2)", () => {
  before(() => primeHostOwnedLists(LISTS));
  afterEach(() => mock.restoreAll());

  for (const [domain, reason] of VECTORS) {
    it(`checkHostOwned ${domain} → ${reason}`, () => {
      assert.equal(checkHostOwned(domain, LISTS), reason);
    });
  }

  for (const domain of ["villa.wixsite.com", "villa.airbnb.com", "airbnb.villaakerlyckan.se", "villa.booking", "villa.amazon"]) {
    it(`vrp_verify_node refuses ${domain} before fetching anything`, async () => {
      const { seen } = mockNode({ domain });
      const { result, parsed } = await verifyNode(domain);
      assert.equal(result.isError, true);
      assert.match(parsed.error, /not a host-owned domain/);
      assert.deepEqual(seen, [], "no request leaves the verifier for a domain that is not a node");
    });
  }

  it("vrp_verify_node accepts the host's own registered domain", async () => {
    mockNode({ domain: "villaakerlyckan.se" });
    const { result, parsed } = await verifyNode("villaakerlyckan.se");
    assert.equal(result.isError, undefined);
    assert.equal(parsed.verified, true);
  });

  it("the lists unreadable = unknown: nothing is verified (§9)", async () => {
    primeHostOwnedLists(null);
    const { seen } = mockNode({ domain: "villaakerlyckan.se" }); // the mock answers 404 for the lists
    const { result, parsed } = await verifyNode("villaakerlyckan.se");
    assert.equal(result.isError, true);
    assert.match(parsed.error, /Node unknown/);
    assert.ok(seen.every((u) => !u.includes("villaakerlyckan.se")), "the node is not fetched");
    primeHostOwnedLists(LISTS);
  });

  it("loadHostOwnedLists returns the primed lists without fetching", async () => {
    mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
    assert.deepEqual(await loadHostOwnedLists(), LISTS);
  });
});

describe("redirects stay on node URLs (Core §2)", () => {
  before(() => primeHostOwnedLists(LISTS));
  afterEach(() => mock.restoreAll());
  const D = "example-host.invalid";

  it("to_www: a redirect to www. is followed", async () => {
    mockNode({ domain: D, discoveryRedirect: [`https://www.${D}/.well-known/vacation-rental.json`] });
    const { result } = await verifyNode(D);
    assert.equal(result.isError, undefined);
  });

  it("to_another_host: a redirect to another host fails", async () => {
    mockNode({ domain: D, discoveryRedirect: ["https://other-host.invalid/.well-known/vacation-rental.json"] });
    const { result, parsed } = await verifyNode(D);
    assert.equal(result.isError, true);
    assert.match(parsed.error, /leaves the node/);
  });

  it("via_www_to_another_host: the second hop leaves the node and fails", async () => {
    mockNode({ domain: D, discoveryRedirect: [`https://www.${D}/.well-known/vacation-rental.json`, "https://other-host.invalid/x"] });
    const { result, parsed } = await verifyNode(D);
    assert.equal(result.isError, true);
    assert.match(parsed.error, /leaves the node/);
  });

  it("to_http: a redirect that leaves https fails", async () => {
    mockNode({ domain: D, discoveryRedirect: [`http://www.${D}/.well-known/vacation-rental.json`] });
    const { result, parsed } = await verifyNode(D);
    assert.equal(result.isError, true);
    assert.match(parsed.error, /leaves the node/);
  });

  it("the JWKS fetch obeys the same rule", async () => {
    mockNode({ domain: D, jwksRedirect: ["https://keys.example-host.invalid/jwks.json"] });
    const { result, parsed } = await verifyNode(D);
    assert.equal(result.isError, true);
    assert.match(parsed.error, /leaves the node/);
  });
});

describe("the signed offer names the domain it was fetched from (Core §7)", () => {
  before(() => primeHostOwnedLists(LISTS));
  afterEach(() => mock.restoreAll());

  it("offer_names_fetched_domain passes", async () => {
    mockNode({ domain: "example-host.invalid" });
    const { result, parsed } = await getOffer("example-host.invalid");
    assert.equal(result.isError, undefined);
    assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, true);
  });

  it("offer_names_another_domain: a valid signature over another domain's offer is refused", async () => {
    mockNode({ domain: "example-host.invalid", offerDomain: "other-host.invalid" });
    const { result, parsed } = await getOffer("example-host.invalid");
    assert.equal(result.isError, true);
    assert.match(parsed.error, /names other-host\.invalid, not example-host\.invalid/);
  });
});
