// Core §3 and the JWKS schema: a VRP signing key is `kty: OKP`,
// `crv: Ed25519` and names its `alg`: `EdDSA` in v0.1, `Ed25519` or `EdDSA`
// in the 1.0 candidate this branch follows. Until this correction the
// signed stay offer was verified with whichever OKP/Ed25519 key carried the
// JWS header's `kid`, whatever the key's own `alg` said: a key labelled with
// another algorithm, or with none, verified an offer and the offer was quoted
// as official. These cases go through the real tool handler.
//
// The node check (`vrp_verify_node`, and the first step of the offer tool)
// follows the same rule: until this correction it accepted a JWKS whose only
// OKP/Ed25519 key named no `alg`, or an empty one, reported the node as
// verified, and filled in `EdDSA` for it in the answer.
//
// `verifyCompactJws` is also the primitive for AP2 mandates and receipts,
// whose keys follow their own rules (a JWK may omit `alg`, RFC 7517 §4.4).
// The label rule is therefore an option the offer path turns on; the last
// block pins that the primitive's default is unchanged.
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";
import { verifyCompactJws } from "../lib/vrp.js";

type Json = Record<string, unknown>;

const LISTS = { icannRules: ["example", "se"], specification13Tlds: [] };
const clients = { supabase: null as never, reader: null as never };
const DOMAIN = "node.example";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const STAY = { check_in: "2027-03-08", check_out: "2027-03-12", guests: 2 };
const ARGS: Json = { domain: DOMAIN, checkIn: STAY.check_in, checkOut: STAY.check_out, guests: STAY.guests };
const iso = (ms: number) => new Date(ms).toISOString();
const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function compactJws(payload: Json, privateKey: KeyObject, kid: string, alg = "EdDSA"): string {
  const signingInput = `${b64url(JSON.stringify({ alg, kid, typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

function signedOffer(): Json {
  return {
    kind: "verified_stay_offer",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    node_id: DOMAIN,
    generated_at: iso(NOW - 60_000),
    valid_until: iso(NOW + 600_000),
    request: { ...STAY },
    property: { property_id: "p1", name: "Example Stay", domain: DOMAIN },
    availability: { available: true, source: "official_host_domain", reason: null },
    price: { currency: "EUR", public_total: 900, agent_total: 900, minor_unit: false, exact: true },
    booking: { direct_booking_url: `https://${DOMAIN}/book?offer=t1` },
    agent_permission: {
      may_quote_as_official_direct_offer: true,
      must_not_claim_ota_comparison_without_signed_ota_price: true,
    },
  };
}

const DISCOVERY: Json = {
  protocol: "vacation-rental-protocol",
  protocol_version: "0.1",
  canonical_domain: DOMAIN,
  jwks_url: `https://${DOMAIN}/.well-known/jwks.json`,
  verified_stay_offer_endpoint: `https://${DOMAIN}/api/verified-stay-offer`,
};

const publicJwk = (key: KeyObject, kid: string, alg?: unknown): Json => {
  const jwk: Json = { ...(key.export({ format: "jwk" }) as Json), kid, use: "sig" };
  if (alg !== undefined) jwk.alg = alg;
  return jwk;
};

/** Serve a node whose offer is signed by `signer` under `kid`; `keys` is its JWKS. Returns the paths fetched. */
function serveNode(keys: Json[], signer: KeyObject, kid: string): string[] {
  const fetches: string[] = [];
  const offer = signedOffer();
  const jws = compactJws(offer, signer, kid);
  const envelope: Json = {
    kind: "signed_verified_stay_offer",
    protocol_version: "0.1",
    offer,
    signature: { format: "jws_compact", alg: "EdDSA", kid, jws },
  };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    fetches.push(url.pathname);
    if (url.pathname === "/.well-known/vacation-rental.json") return jsonResponse(DISCOVERY);
    if (url.pathname === "/.well-known/jwks.json") return jsonResponse({ keys });
    if (url.pathname === "/api/verified-stay-offer") return jsonResponse(envelope);
    return new Response("not found", { status: 404 });
  });
  return fetches;
}

async function callVerifyNode() {
  const result = await executeTool("vrp_verify_node", { domain: DOMAIN }, clients);
  return { result, parsed: JSON.parse(result.content[0].text) as Json };
}

async function callOffer() {
  const result = await executeTool("vrp_get_verified_stay_offer", ARGS, clients);
  return { result, parsed: JSON.parse(result.content[0].text) as Json };
}

async function assertNotQuoted() {
  const { result, parsed } = await callOffer();
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 200)}`);
  for (const key of ["official_offer_summary", "agent_citation", "direct_booking_url", "price", "verified", "safe_to_quote"]) {
    assert.equal(key in parsed, false, `${key} must not be presented`);
  }
}

describe("Core §3: the signed stay offer is verified only with a key labelled EdDSA", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("control: a key labelled EdDSA verifies and the offer is quoteable", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    serveNode([publicJwk(publicKey, "node-key", "EdDSA")], privateKey, "node-key");
    const { result, parsed } = await callOffer();
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.equal(parsed.verified, true);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
  });

  for (const alg of ["ES256", "RS256", "none", "eddsa", "ed25519", "EDDSA", "", null, 1]) {
    it(`refuses an offer signed by a key labelled ${JSON.stringify(alg)}, beside a properly labelled key`, async () => {
      const good = generateKeyPairSync("ed25519");
      const mislabelled = generateKeyPairSync("ed25519");
      serveNode(
        [publicJwk(good.publicKey, "node-key-good", "EdDSA"), publicJwk(mislabelled.publicKey, "node-key", alg)],
        mislabelled.privateKey,
        "node-key"
      );
      await assertNotQuoted();
    });
  }

  it("1.0 candidate: a key labelled Ed25519 is a VRP signing key too, and the offer is quoteable", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    serveNode([publicJwk(publicKey, "node-key", "Ed25519")], privateKey, "node-key");
    const { result, parsed } = await callOffer();
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.equal(parsed.verified, true);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
    const node = await callVerifyNode();
    assert.equal(node.result.isError, undefined, String(node.parsed.error));
    assert.deepEqual(node.parsed.signing, { alg: "Ed25519", kty: "OKP", crv: "Ed25519", kid: "node-key" });
  });

  it("refuses an offer signed by a key that names no alg", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    serveNode([publicJwk(publicKey, "node-key")], privateKey, "node-key");
    await assertNotQuoted();
  });
});

describe("Core §3: a node is verified only when its JWKS holds a key labelled EdDSA", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  const NO_VRP_KEY = /JWKS does not contain a VRP signing key/;

  it("control: a key labelled EdDSA verifies the node, and the answer reports the key's own label", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    serveNode([publicJwk(publicKey, "node-key", "EdDSA")], privateKey, "node-key");
    const { result, parsed } = await callVerifyNode();
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.equal(parsed.verified, true);
    assert.deepEqual(parsed.signing, { alg: "EdDSA", kty: "OKP", crv: "Ed25519", kid: "node-key" });
  });

  it("refuses a node whose only key names no alg; EdDSA is not filled in for it", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const fetches = serveNode([publicJwk(publicKey, "node-key")], privateKey, "node-key");
    const node = await callVerifyNode();
    assert.equal(node.result.isError, true, `expected a refusal, got ${JSON.stringify(node.parsed).slice(0, 200)}`);
    assert.match(String(node.parsed.error), NO_VRP_KEY);
    assert.equal("verified" in node.parsed, false);
    assert.equal("signing" in node.parsed, false);
    // The offer tool stops at the same place: the offer is never fetched.
    fetches.length = 0;
    const offer = await callOffer();
    assert.equal(offer.result.isError, true);
    assert.match(String(offer.parsed.error), NO_VRP_KEY);
    assert.deepEqual(fetches, ["/.well-known/vacation-rental.json", "/.well-known/jwks.json"]);
  });

  for (const alg of ["ES256", "RS256", "none", "eddsa", "ed25519", "EDDSA", "", null, 1, 0, false]) {
    it(`refuses a node whose only key is labelled ${JSON.stringify(alg)}`, async () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      serveNode([publicJwk(publicKey, "node-key", alg)], privateKey, "node-key");
      const { result, parsed } = await callVerifyNode();
      assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 200)}`);
      assert.match(String(parsed.error), NO_VRP_KEY);
      assert.equal("verified" in parsed, false);
      assert.equal("signing" in parsed, false);
    });
  }

  it("a mislabelled key beside a properly labelled one: the node is verified on the labelled key, and that key is reported", async () => {
    const good = generateKeyPairSync("ed25519");
    const unlabelled = generateKeyPairSync("ed25519");
    serveNode(
      [publicJwk(unlabelled.publicKey, "node-key-unlabelled"), publicJwk(good.publicKey, "node-key-good", "EdDSA")],
      good.privateKey,
      "node-key-good"
    );
    const { result, parsed } = await callVerifyNode();
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.deepEqual(parsed.signing, { alg: "EdDSA", kty: "OKP", crv: "Ed25519", kid: "node-key-good" });
  });

  it("a JWKS with no keys, or with a key that is not OKP/Ed25519, is refused as before", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    serveNode([], privateKey, "node-key");
    assert.match(String((await callVerifyNode()).parsed.error), NO_VRP_KEY);
    mock.restoreAll();
    serveNode([{ kty: "EC", crv: "P-256", kid: "node-key", alg: "EdDSA", x: "AA", y: "AA" }], privateKey, "node-key");
    assert.match(String((await callVerifyNode()).parsed.error), NO_VRP_KEY);
  });
});

describe("verifyCompactJws: the label rule is the offer path's, the primitive's default is unchanged", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jws = compactJws({ kind: "test" }, privateKey, "k1");

  it("without the option a JWK that omits alg still verifies (AP2 mandates, receipts)", () => {
    assert.equal(verifyCompactJws(jws, { keys: [publicJwk(publicKey, "k1")] }).kid, "k1");
  });

  it("with the option the same key is refused, and a key labelled EdDSA verifies", () => {
    assert.throws(() => verifyCompactJws(jws, { keys: [publicJwk(publicKey, "k1")] }, { vrpSigningKey: true }), /No matching Ed25519 key/);
    assert.equal(verifyCompactJws(jws, { keys: [publicJwk(publicKey, "k1", "EdDSA")] }, { vrpSigningKey: true }).kid, "k1");
  });

  for (const alg of ["ES256", "none", "ed25519", "Ed25519"]) {
    it(`a genuine Ed25519 signature under a header that says ${JSON.stringify(alg)} is refused in either mode`, () => {
      const foreign = compactJws({ kind: "test" }, privateKey, "k1", alg);
      const keys = { keys: [publicJwk(publicKey, "k1", "EdDSA")] };
      assert.throws(() => verifyCompactJws(foreign, keys), /Unsupported JWS alg/);
      assert.throws(() => verifyCompactJws(foreign, keys, { vrpSigningKey: true }), /Unsupported JWS alg/);
    });
  }
});
