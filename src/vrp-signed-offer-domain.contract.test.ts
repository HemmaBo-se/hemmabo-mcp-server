// Core v0.1 §7:520 through the real tool handler: the signed payload's
// `canonical_domain` is the domain the discovery document was fetched from,
// compared as written (§2 host-owned domain, items 1–2).
//
// Until this change the signed value was normalized before the comparison, so
// a node that signed `https://node.example/path`, `www.node.example`,
// `NODE.EXAMPLE` or `node.example.` was quoted as official. Reproduced by two
// independent reviews on 2026-11-09 with real Ed25519 signatures. A missing
// value, a non-string value and another domain were refused before and still
// are. This is a conformance gap, not a forged signature: in every case the
// node signs its own offer.
//
// The positive controls are checked against the VRP v0.1 schemas, vendored
// under spec/schemas/ at a pinned vrp-spec commit (spec/schemas/SOURCE.json),
// so "conformant" is a tested statement and the tests run offline.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { executeTool } from "../lib/tools.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";

type Json = Record<string, unknown>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = resolve(REPO_ROOT, "spec/schemas");
const readSchema = (name: string) => JSON.parse(readFileSync(resolve(SCHEMA_DIR, name), "utf8")) as Json;

// No coercion, no defaults, nothing removed: invalid test data must stay invalid.
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
(addFormatsModule as unknown as (a: Ajv2020) => Ajv2020)(ajv);
const validators = {
  discovery: ajv.compile(readSchema("discovery-v0.1.schema.json")),
  jwks: ajv.compile(readSchema("jwks-v0.1.schema.json")),
  offer: ajv.compile(readSchema("verified-stay-offer-v0.1.schema.json")),
};

function assertSchemaValid(kind: keyof typeof validators, value: unknown): void {
  const validate = validators[kind];
  assert.equal(validate(value), true, `${kind} is not schema-valid: ${JSON.stringify(validate.errors)}`);
}

const LISTS = { icannRules: ["example", "se"], specification13Tlds: [] };
const clients = { supabase: null as never, reader: null as never };
const DOMAIN = "node.example";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const STAY = { check_in: "2027-03-08", check_out: "2027-03-12", guests: 2 };
const ARGS: Json = { domain: DOMAIN, checkIn: STAY.check_in, checkOut: STAY.check_out, guests: STAY.guests };
const iso = (ms: number) => new Date(ms).toISOString();
const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function compactJws(payload: Json, privateKey: KeyObject): string {
  const header = { alg: "EdDSA", kid: "node-key", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

/** A schema-valid, fully quoteable signed payload for STAY, fresh at NOW. */
function signedPayload(): Json {
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

function discoveryDocument(): Json {
  return {
    protocol: "vacation-rental-protocol",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    jwks_url: `https://${DOMAIN}/.well-known/jwks.json`,
    verified_stay_offer_endpoint: `https://${DOMAIN}/api/verified-stay-offer`,
  };
}

type Served = { fetches: string[]; discovery: Json; jwks: Json; envelope: Json; signed: Json };

/** Serve a conformant node whose signed payload is changed by `mutate` and then signed as changed. */
function serveNode(mutate: (payload: Json) => void = () => {}): Served {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Json), kid: "node-key", alg: "EdDSA", use: "sig" };
  const payload = signedPayload();
  mutate(payload);
  const jws = compactJws(payload, privateKey);
  const discovery = discoveryDocument();
  const jwks = { keys: [jwk] };
  const envelope: Json = {
    kind: "signed_verified_stay_offer",
    protocol_version: "0.1",
    offer: payload,
    signature: { format: "jws_compact", alg: "EdDSA", kid: "node-key", jws },
  };
  // What the node really signed, decoded from the JWS itself.
  const signed = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as Json;
  const served: Served = { fetches: [], discovery, jwks, envelope, signed };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    served.fetches.push(url.pathname);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/.well-known/vacation-rental.json") return json(discovery);
    if (url.pathname === "/.well-known/jwks.json") return json(jwks);
    if (url.pathname === "/api/verified-stay-offer") return json(envelope);
    return new Response("not found", { status: 404 });
  });
  return served;
}

async function callOffer() {
  const result = await executeTool("vrp_get_verified_stay_offer", ARGS, clients);
  const parsed = JSON.parse(result.content[0].text) as Json;
  return { result, parsed };
}

const NODE_FETCHES = ["/.well-known/vacation-rental.json", "/.well-known/jwks.json", "/api/verified-stay-offer"];
const OFFER_KEYS = ["official_offer_summary", "agent_citation", "agent_guardrails", "direct_booking_url", "price", "verified", "safe_to_quote", "payload_matches_offer", "fresh"];

/** The offer is refused after it was fetched and its signature read; nothing of it is presented. */
async function assertRefused(served: Served) {
  const { result, parsed } = await callOffer();
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 200)}`);
  assert.equal(typeof parsed.error, "string");
  assert.deepEqual(served.fetches, NODE_FETCHES);
  for (const key of OFFER_KEYS) assert.equal(key in parsed, false, `${key} must not be presented`);
  assert.equal(JSON.stringify(parsed).includes("/book?offer=t1"), false, "the signed booking URL must not be presented");
}

async function assertQuoteable(served: Served) {
  assertSchemaValid("discovery", served.discovery);
  assertSchemaValid("jwks", served.jwks);
  assertSchemaValid("offer", served.envelope);
  assertSchemaValid("offer", { ...served.envelope, offer: served.signed });
  const { result, parsed } = await callOffer();
  assert.equal(result.isError, undefined, String(parsed.error));
  assert.equal(parsed.verified, true);
  const citation = parsed.agent_citation as Json;
  assert.equal(citation.safe_to_quote_as_official_direct_offer, true);
  assert.equal(citation.quote_status, "official_host_domain_verified_offer");
  assert.deepEqual(served.fetches, NODE_FETCHES);
  return parsed;
}

describe("Core §7:520: the signed canonical_domain is the fetched domain, as written", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("the vendored schemas are the pinned vrp-spec files, byte for byte", () => {
    const source = JSON.parse(readFileSync(resolve(SCHEMA_DIR, "SOURCE.json"), "utf8")) as {
      commit: string;
      files: Record<string, { sha256: string }>;
    };
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(source.files).sort(), [
      "discovery-v0.1.schema.json",
      "jwks-v0.1.schema.json",
      "verified-stay-offer-v0.1.schema.json",
    ]);
    for (const [name, pin] of Object.entries(source.files)) {
      const sha256 = createHash("sha256").update(readFileSync(resolve(SCHEMA_DIR, name))).digest("hex");
      assert.equal(sha256, pin.sha256, `${name} differs from the pinned vrp-spec file`);
    }
  });

  it("control: a schema-valid node whose signed canonical_domain is the domain is quoteable", async () => {
    const parsed = await assertQuoteable(serveNode());
    assert.equal((parsed.official_offer_summary as Json).direct_booking_url, `https://${DOMAIN}/book?offer=t1`);
  });

  it("control: a booking URL on www. + the domain is still a node URL (§2, §5.1); the signed canonical_domain stays the bare domain", async () => {
    const url = `https://www.${DOMAIN}/book?offer=t1`;
    const parsed = await assertQuoteable(serveNode((payload) => { payload.booking = { direct_booking_url: url }; }));
    assert.equal((parsed.official_offer_summary as Json).direct_booking_url, url);
  });

  it("control: the agent's own domain argument is still normalized (https://WWW.Node.Example/ names node.example)", async () => {
    const served = serveNode();
    const result = await executeTool("vrp_get_verified_stay_offer", { ...ARGS, domain: "https://WWW.Node.Example/" }, clients);
    const parsed = JSON.parse(result.content[0].text) as Json;
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.equal(parsed.domain, DOMAIN);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
    assert.deepEqual(served.fetches, NODE_FETCHES);
  });

  // Each value names the same host and was accepted until this change.
  for (const value of [
    "https://node.example/path",
    "https://node.example",
    "HTTPS://Node.Example./x?y#z",
    "www.node.example",
    "NODE.EXAMPLE",
    "node.example.",
    " node.example",
    "node.example\n",
  ]) {
    it(`refuses a signed canonical_domain ${JSON.stringify(value)}: not the domain as written`, async () => {
      await assertRefused(serveNode((payload) => { payload.canonical_domain = value; }));
    });
  }

  // Refused before this change too; pinned so the raw comparison keeps them refused.
  it("still refuses a signed canonical_domain that names another domain", async () => {
    await assertRefused(serveNode((payload) => { payload.canonical_domain = "other.example"; }));
  });

  it("still refuses a signed payload without canonical_domain", async () => {
    await assertRefused(serveNode((payload) => { delete payload.canonical_domain; }));
  });

  for (const value of ["", 42, null, ["node.example"], { domain: "node.example" }]) {
    it(`still refuses a signed canonical_domain that is not a non-empty string: ${JSON.stringify(value)}`, async () => {
      await assertRefused(serveNode((payload) => { payload.canonical_domain = value; }));
    });
  }
});
