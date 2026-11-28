// VRP 1.0 candidate through the real tool handlers (vrp-spec pull request 187,
// a draft and not adopted; ADR 0013, ADR 0017).
//
// The candidate keeps the v0.1 wire format and gives it a second name:
//   - a discovery document declares `protocol_version` "1.0" or "0.1";
//   - a signed offer declares its own, "1.0" or "0.1", checked separately;
//   - a JWS protected header names the signing operation `Ed25519` or `EdDSA`.
// Each value is compared as written. Anything else leaves the node or the
// offer unknown, and nothing of the offer is presented (§8, §9).
//
// The cases are the candidate's own vectors, vendored byte for byte under
// spec/conformance-1.0-candidate/ at a pinned vrp-spec commit (SOURCE.json):
// fifteen signed offers, fifteen discovery documents and eight pairs of a
// discovery document and a signed offer. Each is served as a node and read by
// vrp_get_verified_stay_offer and vrp_verify_node, so the result is what an
// agent would be given.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool } from "../lib/tools.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";
import { VRP_JWS_ALGS, VRP_PROTOCOL_VERSIONS, declaredVersionProblem, verifyCompactJws } from "../lib/vrp.js";

type Json = Record<string, unknown>;
type OfferVector = {
  name: string;
  clock: string;
  jwks: Json;
  input: Json;
  expected: { verified: boolean; reason: string | null; fresh: boolean | null };
};
type DiscoveryCase = { name: string; document: Json; expected: { reason: string | null } };
type PairCase = {
  name: string;
  discovery: Json;
  jws: string;
  expected: { discovery_reason: string | null; offer_reason: string | null; version_accepted: boolean };
};

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec/conformance-1.0-candidate");
const readJson = <T>(...parts: string[]) => JSON.parse(readFileSync(resolve(DIR, ...parts), "utf8")) as T;
const offerFiles = readdirSync(resolve(DIR, "offer")).filter((f) => f.endsWith(".json")).sort();
const offerVectors = offerFiles.map((file) => ({ file, vector: readJson<OfferVector>("offer", file) }));
const versions = readJson<{ jwks: Json; discovery: DiscoveryCase[]; pairs: PairCase[] }>("discovery-version", "vectors.v1.0.json");

// The vectors' node, stay and clock.
const DOMAIN = "example-host.invalid";
const LISTS = { icannRules: ["invalid"], specification13Tlds: [] };
const STAY = { check_in: "2026-09-12", check_out: "2026-09-15", guests: 2 };
const ARGS: Json = { domain: DOMAIN, checkIn: STAY.check_in, checkOut: STAY.check_out, guests: STAY.guests };
const CLOCK = "2026-06-02T12:05:00Z";
const clients = { supabase: null as never, reader: null as never };
const base = offerVectors.find((v) => v.file === "01-valid-fresh.json")!.vector;
const discoveryFor = (name: string) => versions.discovery.find((c) => c.name === name)!.document;

// What each vector reason reads as when the tool refuses.
const REFUSAL: Record<string, RegExp> = {
  unexpected_alg: /Unsupported JWS alg/,
  unsupported_version: /unsupported VRP version|Unsupported VRP version/i,
  missing_protocol_version: /declares no protocol_version/,
  unexpected_protocol: /Unsupported protocol/,
  signature_mismatch: /signature verification failed|does not match returned offer/,
  kid_not_in_jwks: /No matching Ed25519 key/,
};
const OFFER_KEYS = ["official_offer_summary", "agent_citation", "agent_guardrails", "direct_booking_url", "price", "verified", "safe_to_quote", "payload_matches_offer", "fresh"];

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Json;

/** The response a node gives for a bare compact JWS: the signed payload beside its signature. */
function envelopeFor(jws: string): Json {
  const [header, payload] = jws.split(".");
  const { alg, kid } = decode(header);
  return { kind: "signed_verified_stay_offer", offer: decode(payload), signature: { format: "jws_compact", alg, kid, jws } };
}

function serve(discovery: unknown, jwks: Json, envelope: Json): string[] {
  const fetches: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    fetches.push(url.pathname);
    if (url.pathname === "/.well-known/vacation-rental.json") return jsonResponse(discovery);
    if (url.pathname === "/.well-known/jwks.json") return jsonResponse(jwks);
    if (url.pathname === "/api/verified-stay-offer") return jsonResponse(envelope);
    return new Response("not found", { status: 404 });
  });
  return fetches;
}

async function call(tool: "vrp_get_verified_stay_offer" | "vrp_verify_node") {
  const args = tool === "vrp_verify_node" ? { domain: DOMAIN } : ARGS;
  const result = await executeTool(tool, args, clients);
  return { result, parsed: JSON.parse(result.content[0].text) as Json };
}

async function assertQuoteable(): Promise<Json> {
  const { result, parsed } = await call("vrp_get_verified_stay_offer");
  assert.equal(result.isError, undefined, String(parsed.error));
  assert.equal(parsed.verified, true);
  assert.equal(parsed.fresh, true);
  assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
  assert.equal((parsed.agent_citation as Json).quote_status, "official_host_domain_verified_offer");
  return parsed;
}

async function assertRefused(reason: RegExp): Promise<void> {
  const { result, parsed } = await call("vrp_get_verified_stay_offer");
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 200)}`);
  assert.match(String(parsed.error), reason);
  for (const key of OFFER_KEYS) assert.equal(key in parsed, false, `${key} must not be presented`);
}

describe("VRP 1.0 candidate: the two version names and the two signature names", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse(CLOCK) });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("the vendored vectors are the pinned vrp-spec files, byte for byte", () => {
    const source = readJson<{ commit: string; files: Record<string, { sha256: string }> }>("SOURCE.json");
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(
      Object.keys(source.files).sort(),
      [...offerFiles.map((f) => `offer/${f}`), "discovery-version/vectors.v1.0.json"].sort()
    );
    assert.equal(offerFiles.length, 15);
    for (const [name, pin] of Object.entries(source.files)) {
      const sha256 = createHash("sha256").update(readFileSync(resolve(DIR, name))).digest("hex");
      assert.equal(sha256, pin.sha256, `${name} differs from the pinned vrp-spec file`);
    }
  });

  it("the known names are exactly the two of each", () => {
    assert.deepEqual([...VRP_PROTOCOL_VERSIONS], ["1.0", "0.1"]);
    assert.deepEqual([...VRP_JWS_ALGS], ["Ed25519", "EdDSA"]);
  });

  // -------------------------------------------------------------------------
  // The fifteen signed offers, served by a node whose discovery document is conformant.

  const combinations = new Set<string>();
  for (const { file, vector } of offerVectors) {
    const quoteable = vector.expected.verified && vector.expected.fresh === true;
    it(`offer ${file}: ${quoteable ? "quoteable" : `not presented (${vector.expected.reason ?? "expired"})`}`, async () => {
      // Each vector is judged at its own clock.
      mock.timers.setTime(Date.parse(vector.clock));
      const fetches = serve(discoveryFor("version_0_1"), vector.jwks, vector.input);
      if (quoteable) {
        const parsed = await assertQuoteable();
        const header = decode(String((vector.input.signature as Json).jws).split(".")[0]);
        const payload = decode(String((vector.input.signature as Json).jws).split(".")[1]);
        // The tool reports the name the signed header carries.
        assert.equal((parsed.signature as Json).alg, header.alg);
        combinations.add(`${String(payload.protocol_version)}/${String(header.alg)}`);
      } else if (vector.expected.reason) {
        await assertRefused(REFUSAL[vector.expected.reason]);
      } else {
        // Verified but no longer fresh at the vector's clock: the tool says
        // both, and presents nothing of the offer.
        const { result, parsed } = await call("vrp_get_verified_stay_offer");
        assert.equal(result.isError, true);
        assert.deepEqual(parsed.reasons, ["expired"]);
        assert.equal(parsed.signature_valid, true);
        assert.equal(parsed.safe_to_quote, false);
        for (const key of OFFER_KEYS.filter((k) => k !== "safe_to_quote")) assert.equal(key in parsed, false, `${key} must not be presented`);
      }
      assert.deepEqual(fetches, ["/.well-known/vacation-rental.json", "/.well-known/jwks.json", "/api/verified-stay-offer"]);
    });
  }

  it("every pairing of a version name and a signature name is quoteable in some vector", () => {
    assert.deepEqual([...combinations].sort(), ["0.1/Ed25519", "0.1/EdDSA", "1.0/Ed25519", "1.0/EdDSA"]);
  });

  // -------------------------------------------------------------------------
  // The fifteen discovery documents, each serving the valid fresh offer.

  const accepted = new Set<unknown>();
  const refused = new Set<string>();
  for (const c of versions.discovery) {
    it(`discovery ${c.name}: ${c.expected.reason ?? "accepted"}`, async () => {
      const fetches = serve(c.document, base.jwks, base.input);
      if (c.expected.reason === null) {
        await assertQuoteable();
        const node = await call("vrp_verify_node");
        assert.equal(node.result.isError, undefined, String(node.parsed.error));
        assert.equal(node.parsed.verified, true);
        // The tool reports the version the document declares, as declared.
        assert.equal(node.parsed.protocol_version, c.document.protocol_version);
        accepted.add(c.document.protocol_version);
      } else {
        await assertRefused(REFUSAL[c.expected.reason]);
        assert.deepEqual(fetches, ["/.well-known/vacation-rental.json"], "the verifier stops at the discovery document");
        const node = await call("vrp_verify_node");
        assert.equal(node.result.isError, true);
        assert.match(String(node.parsed.error), REFUSAL[c.expected.reason]);
        assert.equal(node.parsed.verified, undefined);
        refused.add(c.expected.reason);
      }
    });
  }

  it("discovery: both known versions are accepted and each failure occurs", () => {
    assert.deepEqual([...accepted].sort(), ["0.1", "1.0"]);
    assert.deepEqual([...refused].sort(), ["missing_protocol_version", "unexpected_protocol", "unsupported_version"]);
  });

  // -------------------------------------------------------------------------
  // Two declarations, checked separately: the eight pairs.

  for (const c of versions.pairs) {
    it(`pair ${c.name}: ${c.expected.version_accepted ? "quoteable" : "not presented"}`, async () => {
      // The signature itself is genuine in every pair: only the versions decide.
      const jws = verifyCompactJws(c.jws, versions.jwks, { algs: VRP_JWS_ALGS });
      const offerProblem = declaredVersionProblem(jws.payload.protocol_version);
      const expectedOffer = { unsupported_version: "unsupported", missing_protocol_version: "missing" } as Record<string, string>;
      assert.equal(offerProblem, c.expected.offer_reason === null ? null : expectedOffer[c.expected.offer_reason]);

      const fetches = serve(c.discovery, versions.jwks, envelopeFor(c.jws));
      if (c.expected.version_accepted) {
        await assertQuoteable();
      } else if (c.expected.discovery_reason) {
        await assertRefused(REFUSAL[c.expected.discovery_reason]);
        assert.deepEqual(fetches, ["/.well-known/vacation-rental.json"]);
      } else {
        // A known discovery version does not repair the signed offer's own.
        const reason = c.expected.offer_reason === "missing_protocol_version"
          ? /Signed offer declares no protocol_version/
          : /Signed offer declares an unsupported VRP version/;
        await assertRefused(reason);
        assert.deepEqual(fetches, ["/.well-known/vacation-rental.json", "/.well-known/jwks.json", "/api/verified-stay-offer"]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // The signed version decides, never the unsigned envelope beside it.

  it("an envelope that says 1.0 beside a signed offer that says 0.2 is not presented", async () => {
    const pair = versions.pairs.find((p) => p.name === "discovery_1_0_offer_0_2")!;
    serve(pair.discovery, versions.jwks, { ...envelopeFor(pair.jws), protocol_version: "1.0" });
    await assertRefused(/Signed offer declares an unsupported VRP version: "0\.2"/);
  });

  it("a key that carries the name Ed25519 is reported under that name", async () => {
    const vector = offerVectors.find((v) => v.file === "11-alg-ed25519-jwk-alg-ed25519-valid-fresh.json")!.vector;
    serve(discoveryFor("version_1_0"), vector.jwks, vector.input);
    const node = await call("vrp_verify_node");
    assert.equal(node.result.isError, undefined, String(node.parsed.error));
    assert.equal((node.parsed.signing as Json).alg, "Ed25519");
    assert.equal(node.parsed.protocol_version, "1.0");
  });

  it("the receipt and mandate callers still accept EdDSA alone", () => {
    const vector = offerVectors.find((v) => v.file === "06-alg-ed25519-valid-fresh.json")!.vector;
    const jws = String((vector.input.signature as Json).jws);
    assert.throws(() => verifyCompactJws(jws, vector.jwks), /Unsupported JWS alg: Ed25519/);
    assert.equal(verifyCompactJws(jws, vector.jwks, { algs: VRP_JWS_ALGS }).header.alg, "Ed25519");
  });
});
