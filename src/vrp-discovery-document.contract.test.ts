// Core v0.1 §2:38–39 and §7:514/§7:516 through the real tool handlers.
//
// The discovery document itself MUST declare `protocol_version: "0.1"` and a
// `canonical_domain` equal to the host-owned domain it is served from. Until
// 7.0.14 the verifier filled the gaps itself: a missing `protocol_version` was
// read from the pre-0.1 member `version`, and a missing `canonical_domain`
// from the pre-0.1 member `domain` or from the domain being verified, so a
// document without either field passed and the signed offer was quoted as
// official. Reproduced by the independent reviewer on 2026-11-09 (Node 22,
// signed test offers). These cases pin the fail-closed behaviour (§8) and
// that a conformant node still verifies.
//
// "Conformant" is itself tested: the control's discovery document, JWKS,
// response envelope and decoded signed payload are checked against the VRP
// v0.1 schemas vendored under spec/schemas/ at a pinned vrp-spec commit
// (spec/schemas/SOURCE.json; its hashes are tested in
// vrp-signed-offer-domain.contract.test.ts). Until this was added the control
// lacked jwks_url, property.property_id, price.minor_unit and a required
// agent_permission member, and passed all the same.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { executeTool } from "../lib/tools.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";

type Json = Record<string, unknown>;

const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec/schemas");
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function compactJws(payload: Json, privateKey: KeyObject): string {
  const header = { alg: "EdDSA", kid: "node-key", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

/** A schema-valid, fully quoteable signed payload for STAY, fresh at NOW. */
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

/** A conformant discovery document; `overrides` replace members, `remove` deletes them. */
function discoveryDocument(overrides: Json = {}, remove: string[] = []): Json {
  const doc: Json = {
    protocol: "vacation-rental-protocol",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    jwks_url: `https://${DOMAIN}/.well-known/jwks.json`,
    verified_stay_offer_endpoint: `https://${DOMAIN}/api/verified-stay-offer`,
    ...overrides,
  };
  for (const key of remove) delete doc[key];
  return doc;
}

type Served = { fetches: string[]; jwks: Json; envelope: Json; signed: Json };

/** Serve a node with the given discovery document; its JWKS signs a fully quoteable offer. */
function serveNode(discovery: Json): Served {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Json), kid: "node-key", alg: "EdDSA", use: "sig" };
  const offer = signedOffer();
  const jws = compactJws(offer, privateKey);
  const jwks = { keys: [jwk] };
  const envelope: Json = {
    kind: "signed_verified_stay_offer",
    protocol_version: "0.1",
    offer,
    signature: { format: "jws_compact", alg: "EdDSA", kid: "node-key", jws },
  };
  // What the node really signed, decoded from the JWS itself.
  const signed = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as Json;
  const served: Served = { fetches: [], jwks, envelope, signed };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    served.fetches.push(url.pathname);
    if (url.pathname === "/.well-known/vacation-rental.json") return jsonResponse(discovery);
    if (url.pathname === "/.well-known/jwks.json") return jsonResponse(jwks);
    if (url.pathname === "/api/verified-stay-offer") return jsonResponse(envelope);
    return new Response("not found", { status: 404 });
  });
  return served;
}

async function callOffer() {
  const result = await executeTool("vrp_get_verified_stay_offer", ARGS, clients);
  const parsed = JSON.parse(result.content[0].text) as Json;
  return { result, parsed };
}

async function callVerifyNode() {
  const result = await executeTool("vrp_verify_node", { domain: DOMAIN }, clients);
  const parsed = JSON.parse(result.content[0].text) as Json;
  return { result, parsed };
}

/** Both handlers refuse at the discovery document: nothing past it is fetched and nothing of the offer is presented. */
async function assertRefusedAtDiscovery(served: Served, message: RegExp) {
  const offer = await callOffer();
  assert.equal(offer.result.isError, true, `expected a refusal, got ${JSON.stringify(offer.parsed).slice(0, 200)}`);
  assert.match(String(offer.parsed.error), message);
  assert.deepEqual(served.fetches, ["/.well-known/vacation-rental.json"], "the verifier stops at the discovery document");
  for (const key of ["official_offer_summary", "agent_citation", "agent_guardrails", "direct_booking_url", "price", "verified", "safe_to_quote"]) {
    assert.equal(key in offer.parsed, false, `${key} must not be presented`);
  }
  served.fetches.length = 0;
  const node = await callVerifyNode();
  assert.equal(node.result.isError, true, `vrp_verify_node must refuse too, got ${JSON.stringify(node.parsed).slice(0, 200)}`);
  assert.match(String(node.parsed.error), message);
  assert.equal(node.parsed.verified, undefined);
}

describe("Core §2 and §7: the discovery document declares protocol_version and canonical_domain itself", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("a conformant discovery document still verifies and the signed offer is quoteable", async () => {
    const discovery = discoveryDocument();
    const served = serveNode(discovery);
    assertSchemaValid("discovery", discovery);
    assertSchemaValid("jwks", served.jwks);
    assertSchemaValid("offer", served.envelope);
    assertSchemaValid("offer", { ...served.envelope, offer: served.signed });
    const { result, parsed } = await callOffer();
    assert.equal(result.isError, undefined, String(parsed.error));
    assert.equal(parsed.verified, true);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
    assert.equal((parsed.agent_citation as Json).quote_status, "official_host_domain_verified_offer");
    assert.deepEqual(served.fetches, ["/.well-known/vacation-rental.json", "/.well-known/jwks.json", "/api/verified-stay-offer"]);
    const node = await callVerifyNode();
    assert.equal(node.result.isError, undefined, String(node.parsed.error));
    assert.equal(node.parsed.verified, true);
    assert.equal(node.parsed.protocol_version, "0.1");
  });

  it("refuses a discovery document without canonical_domain (§2:39, §7:514); the fetched domain is not a substitute", async () => {
    const served = serveNode(discoveryDocument({}, ["canonical_domain"]));
    await assertRefusedAtDiscovery(served, /declares no canonical_domain/);
  });

  it("refuses the pre-0.1 member `domain` in place of canonical_domain", async () => {
    const served = serveNode(discoveryDocument({ domain: DOMAIN }, ["canonical_domain"]));
    await assertRefusedAtDiscovery(served, /declares no canonical_domain/);
  });

  it("refuses an empty canonical_domain", async () => {
    const served = serveNode(discoveryDocument({ canonical_domain: "  " }));
    await assertRefusedAtDiscovery(served, /declares no canonical_domain/);
  });

  it("refuses a discovery document without protocol_version (§2:38, §7:516); the pre-0.1 member `version` is not a substitute", async () => {
    const served = serveNode(discoveryDocument({ version: "0.1" }, ["protocol_version"]));
    await assertRefusedAtDiscovery(served, /declares no protocol_version/);
  });

  it("refuses a discovery document that declares neither field", async () => {
    const served = serveNode(discoveryDocument({ version: "0.1", domain: DOMAIN }, ["protocol_version", "canonical_domain"]));
    await assertRefusedAtDiscovery(served, /declares no protocol_version/);
  });

  it("still refuses a protocol_version other than 0.1", async () => {
    const served = serveNode(discoveryDocument({ protocol_version: "0.2" }));
    await assertRefusedAtDiscovery(served, /Unsupported VRP version: "0\.2"/);
  });

  it("still refuses a canonical_domain that names another domain", async () => {
    const served = serveNode(discoveryDocument({ canonical_domain: "other.example" }));
    await assertRefusedAtDiscovery(served, /canonical_domain mismatch: expected node\.example, got "other\.example"/);
  });

  // §2 host-owned domain, items 1–2: the document's value is the canonical
  // domain itself, compared as written. Each of these names the same host and
  // was accepted at 213c52f, where the value was normalized before the check
  // (reproduced by the independent reviewer on 2026-11-09).
  for (const value of ["www.node.example", "NODE.EXAMPLE", "node.example.", "https://node.example/path", " node.example", "node.example\n"]) {
    it(`refuses canonical_domain ${JSON.stringify(value)}: not the canonical domain as written (§2 items 1–2)`, async () => {
      const served = serveNode(discoveryDocument({ canonical_domain: value }));
      await assertRefusedAtDiscovery(served, /canonical_domain mismatch: expected node\.example, got "/);
    });
  }

  for (const value of [" 0.1", "0.1 ", "0.1\n", "0.10"]) {
    it(`refuses protocol_version ${JSON.stringify(value)}: not "0.1" as written (§2:38)`, async () => {
      const served = serveNode(discoveryDocument({ protocol_version: value }));
      await assertRefusedAtDiscovery(served, /Unsupported VRP version: "/);
    });
  }

  it("refuses a canonical_domain that is not a string", async () => {
    const served = serveNode(discoveryDocument({ canonical_domain: ["node.example"] }));
    await assertRefusedAtDiscovery(served, /declares no canonical_domain/);
  });
});
