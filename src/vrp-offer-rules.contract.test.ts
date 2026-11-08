// Core v0.1 §5, §6, §7, §8, §9 through the real tool handler.
//
// `vrp_get_verified_stay_offer` (lib/vrp.ts) is the path every agent takes;
// these tests run signed offers through it with a mocked node and a mocked
// clock. Each negative case is signed by a key the node's own JWKS serves, so
// the SIGNATURE is valid and the Core rules, not the crypto, decide. The
// production-shaped fixture is the same as src/vrp-tools.contract.test.ts.
//
// What this file pins (each item is a Core rule the handler did not apply, or
// an unsigned value it used, before this change):
//   - a quoteable fact comes from the verified signed payload only; a member
//     missing there is never supplied, nor overridden, by the unsigned response;
//   - `price.exact` must be true, explicitly; an amount is not exactness;
//   - `availability.available` and the permission to quote must be true in
//     the payload;
//   - `generated_at` and `valid_until`: UTC date-times ending in Z, a positive
//     lifetime of at most 900 s, at most 60 s ahead of the clock, not passed;
//   - the signed `request` names dates that exist and have not passed, a
//     language of §5's form, and exactly the stay this call asked for;
//   - a valid signature and permission to quote are told apart in the result;
//   - the standard's own offer-rules vectors, byte-identical copy at
//     spec/offer-rules/vectors.v0.1.json, through the handler.

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";
import { primeHostOwnedLists } from "../lib/host-owned-lists.js";

type Json = Record<string, unknown>;

// Core §2: the verifier reads the Public Suffix List and ICANN's gTLD list;
// the fetch mocks answer 404 for them, so the lists are seeded. The cache is
// judged by the clock, and the clock is mocked below, so the seeding happens
// after every clock change (see beforeEach and the vector cases).
const LISTS = { icannRules: ["example", "se"], specification13Tlds: [] };

const clients = { supabase: null as never, reader: null as never };
const DOMAIN = "node.example";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const STAY = { check_in: "2027-03-08", check_out: "2027-03-12", guests: 2 };
const ARGS: Json = { domain: DOMAIN, checkIn: STAY.check_in, checkOut: STAY.check_out, guests: STAY.guests };
const iso = (ms: number) => new Date(ms).toISOString();

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VECTORS = JSON.parse(readFileSync(join(REPO_ROOT, "spec", "offer-rules", "vectors.v0.1.json"), "utf8")) as {
  now: string;
  max_lifetime_seconds: number;
  clock_skew_seconds: number;
  vectors: { name: string; offer: Json; asked: { check_in: string; check_out: string; guests: number } | null; expected: { reasons: string[] } }[];
};

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

/** A production-shaped signed payload for STAY, fresh at NOW; `overrides` replace members, `remove` deletes them. */
function signedOffer(overrides: Json = {}, remove: string[] = []): Json {
  const offer: Json = {
    kind: "verified_stay_offer",
    protocol_version: "0.1",
    canonical_domain: DOMAIN,
    node_id: DOMAIN,
    generated_at: iso(NOW - 60_000),
    valid_until: iso(NOW + 600_000),
    request: { ...STAY },
    property: { id: "p1", name: "Example Stay", domain: DOMAIN },
    availability: { available: true, source: "official_host_domain", reason: null },
    price: { currency: "EUR", total: 900, public_total: 900, agent_total: 900, exact: true, no_add_on_fees: true, package_applied: null },
    booking: { direct_booking_url: `https://${DOMAIN}/book?offer=t1` },
    agent_permission: { may_quote_as_official_direct_offer: true },
    ...overrides,
  };
  for (const key of remove) delete offer[key];
  return offer;
}

type Served = { fetches: string[] };

/**
 * Serve a node whose JWKS signs `offer`. `outer` adds unsigned members to the
 * offer response; `visibleOffer` replaces the plaintext `offer` member;
 * `tamper` edits the compact JWS after signing.
 */
function serveNode(offer: Json, outer: Json = {}, options: { visibleOffer?: Json; tamper?: (jws: string) => string } = {}): Served {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Json), kid: "node-key", alg: "EdDSA", use: "sig" };
  const signed = compactJws(offer, privateKey);
  const jws = options.tamper ? options.tamper(signed) : signed;
  const served: Served = { fetches: [] };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    served.fetches.push(url.pathname);
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
        offer: options.visibleOffer ?? offer,
        signature: { format: "jws_compact", alg: "EdDSA", kid: "node-key", jws },
        ...outer,
      });
    }
    return new Response("not found", { status: 404 });
  });
  return served;
}

async function call(args: Json = ARGS) {
  const result = await executeTool("vrp_get_verified_stay_offer", args, clients);
  const parsed = JSON.parse(result.content[0].text) as Json;
  return { result, parsed };
}

/** The handler refused with a Core rule: the signature verified, nothing of the offer is presented. */
function assertRuleRefusal(parsed: Json, result: { isError?: boolean }, code: string, ...alsoCodes: string[]) {
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 200)}`);
  assert.equal(parsed.signature_valid, true, "the signature verified; the rule, not the crypto, refused");
  assert.equal(parsed.safe_to_quote, false);
  assert.equal(parsed.quote_status, "not_quoteable");
  assert.equal(parsed.code, code, `first reason: ${JSON.stringify(parsed.reasons)}`);
  for (const c of alsoCodes) assert.ok((parsed.reasons as string[]).includes(c), `${c} in ${JSON.stringify(parsed.reasons)}`);
  assert.match(String(parsed.error), /^Signature valid, but the signed offer is not quoteable:/);
  assert.match(String(parsed.error), /Core §8/);
  // Fail closed (§8, §9): no price, no booking URL, no summary, no guardrail text.
  for (const key of ["official_offer_summary", "agent_citation", "agent_guardrails", "direct_booking_url", "price", "verified", "fresh"]) {
    assert.equal(key in parsed, false, `${key} must not be presented`);
  }
}

/** The handler answered (signature valid) but the offer is not quoteable for a signed, structural reason. */
function assertNotQuoteable(parsed: Json, result: { isError?: boolean }, blockedReason: string) {
  assert.equal(result.isError, undefined);
  assert.equal(parsed.verified, true);
  const citation = parsed.agent_citation as Json;
  const summary = parsed.official_offer_summary as Json;
  const guardrails = parsed.agent_guardrails as Json;
  assert.equal(citation.safe_to_quote_as_official_direct_offer, false);
  assert.equal(citation.quote_status, "not_quoteable");
  assert.equal(citation.blocked_reason, blockedReason);
  assert.equal(citation.agent_message, null);
  assert.equal(summary.bookable, false);
  assert.equal(guardrails.safe_to_quote, false);
  assert.equal(guardrails.required_phrase_when_safe, null);
}

describe("Core §5–§9 in vrp_get_verified_stay_offer", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
    primeHostOwnedLists(LISTS);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  // -------------------------------------------------------------------------
  // Valid offers are still accepted

  it("accepts a fresh, signed offer for the stay asked for, and says both that the signature verified and that it may be quoted", async () => {
    serveNode(signedOffer());
    const { result, parsed } = await call();
    assert.equal(result.isError, undefined);
    assert.equal(parsed.verified, true);
    assert.equal((parsed.signature as Json).verified, true);
    assert.equal(parsed.fresh, true);
    assert.equal(parsed.payload_matches_offer, true);
    const citation = parsed.agent_citation as Json;
    const summary = parsed.official_offer_summary as Json;
    assert.equal(citation.safe_to_quote_as_official_direct_offer, true);
    assert.equal(citation.quote_status, "official_host_domain_verified_offer");
    assert.equal(citation.blocked_reason, null);
    assert.equal(summary.bookable, true);
    assert.equal(summary.direct_booking_url, `https://${DOMAIN}/book?offer=t1`);
    assert.equal(summary.generated_at, iso(NOW - 60_000));
    assert.equal(summary.valid_until, iso(NOW + 600_000));
    assert.equal((summary.price as Json).exact, true);
    assert.equal((summary.price as Json).total, 900);
    assert.equal(parsed.checkIn, STAY.check_in);
    assert.equal(parsed.checkOut, STAY.check_out);
    assert.equal(parsed.guests, 2);
  });

  it("accepts the same stay asked for in legacy snake_case arguments", async () => {
    serveNode(signedOffer());
    const { result, parsed } = await call({ domain: DOMAIN, check_in: STAY.check_in, check_out: STAY.check_out, guests: 2 });
    assert.equal(result.isError, undefined);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
  });

  it("accepts a signed request that carries the node's own computed members and a language tag", async () => {
    serveNode(signedOffer({ request: { ...STAY, nights: 4, check_in_weekday: "Monday", check_out_weekday: "Friday", language: "sv-SE" } }));
    const { result, parsed } = await call({ ...ARGS, language: "sv" });
    assert.equal(result.isError, undefined);
    assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
  });

  it("accepts a lifetime of exactly 900 seconds, generated_at exactly 60 seconds ahead, and valid_until one millisecond from now", async () => {
    for (const offer of [
      signedOffer({ generated_at: iso(NOW - 300_000), valid_until: iso(NOW + 600_000) }), // 900 s
      signedOffer({ generated_at: iso(NOW + 60_000), valid_until: iso(NOW + 660_000) }), // +60 s
      signedOffer({ generated_at: iso(NOW - 300_000), valid_until: iso(NOW + 1) }), // fresh by 1 ms
    ]) {
      serveNode(offer);
      const { result, parsed } = await call();
      assert.equal(result.isError, undefined, JSON.stringify(parsed.error));
      assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
      mock.restoreAll();
    }
  });

  it("accepts arrival on the day before the UTC date (the node applies the property's own date)", async () => {
    const stay = { check_in: "2026-11-09", check_out: "2026-11-12", guests: 2 };
    serveNode(signedOffer({ request: stay }));
    const { result } = await call({ domain: DOMAIN, checkIn: stay.check_in, checkOut: stay.check_out, guests: 2 });
    assert.equal(result.isError, undefined);
  });

  // -------------------------------------------------------------------------
  // Only the signed payload speaks: unsigned members never supply a missing one

  it("does not take valid_until from the unsigned response when the signed payload lacks it", async () => {
    serveNode(signedOffer({}, ["valid_until"]), { valid_until: iso(NOW + 600_000) });
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "malformed_valid_until");
  });

  it("does not take generated_at from the unsigned response when the signed payload lacks it", async () => {
    serveNode(signedOffer({}, ["generated_at"]), { generated_at: iso(NOW - 60_000) });
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "malformed_generated_at");
  });

  it("does not take price from the unsigned response when the signed payload lacks it: no exact price, no total", async () => {
    serveNode(signedOffer({}, ["price"]), { price: { currency: "EUR", total: 900, exact: true } });
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "price_not_exact");
    const price = (parsed.official_offer_summary as Json).price as Json;
    assert.equal(price.exact, false);
    assert.equal(price.total, null);
    assert.equal(price.currency, null);
  });

  it("does not take availability from the unsigned response when the signed payload lacks it", async () => {
    serveNode(signedOffer({}, ["availability"]), { availability: { available: true, reason: null } });
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "not_available");
    assert.equal((parsed.official_offer_summary as Json).available, false);
  });

  it("does not take the permission to quote from the unsigned response when the signed payload lacks it", async () => {
    serveNode(signedOffer({}, ["agent_permission"]), { agent_permission: { may_quote_as_official_direct_offer: true } });
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "agent_permission_denied");
    assert.equal((parsed.agent_citation as Json).may_quote_as_official_direct_offer, false);
  });

  it("does not take request from the unsigned response when the signed payload lacks it", async () => {
    serveNode(signedOffer({}, ["request"]), { request: { ...STAY } });
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "request_missing");
  });

  // -------------------------------------------------------------------------
  // Unsigned members never override signed ones

  it("signed price.exact false stays false when the unsigned response says true", async () => {
    serveNode(signedOffer({ price: { currency: "EUR", total: 900, exact: false } }), { price: { currency: "EUR", total: 900, exact: true } });
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "price_not_exact");
  });

  it("signed availability false stays false when the unsigned response says true", async () => {
    serveNode(signedOffer({ availability: { available: false, reason: "not_available" } }), { availability: { available: true } });
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "not_available");
    assert.equal((parsed.official_offer_summary as Json).availability_reason, "not_available");
  });

  it("a signed valid_until that has passed is expired whatever the unsigned response says", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW - 900_000), valid_until: iso(NOW - 1) }), { valid_until: iso(NOW + 600_000) });
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "expired");
  });

  it("a signed stay for other dates is refused even when the unsigned response echoes the dates asked for", async () => {
    serveNode(signedOffer({ request: { check_in: "2027-03-09", check_out: "2027-03-12", guests: 2 } }), { request: { ...STAY } });
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "request_mismatch");
  });

  // -------------------------------------------------------------------------
  // price.exact is explicit

  for (const [name, exact] of [["missing", undefined], ["false", false], ['the string "true"', "true"], ["the number 1", 1], ["null", null]] as const) {
    it(`a signed total with price.exact ${name} is not an exact price`, async () => {
      const price: Json = { currency: "EUR", total: 900, public_total: 900, agent_total: 900 };
      if (exact !== undefined) price.exact = exact;
      serveNode(signedOffer({ price }));
      const { result, parsed } = await call();
      assertNotQuoteable(parsed, result, "price_not_exact");
      assert.equal(((parsed.official_offer_summary as Json).price as Json).exact, false);
    });
  }

  it("a signed reconciliation that does not add up overrides exact: true", async () => {
    serveNode(signedOffer({ price: { currency: "EUR", total: 900, exact: true, reconciliation: { computed_total: 950, matches_quoted_total: false } } }));
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "price_not_exact");
  });

  // -------------------------------------------------------------------------
  // The stay asked for (§7)

  for (const [name, request] of [
    ["another arrival date", { check_in: "2027-03-07", check_out: "2027-03-12", guests: 2 }],
    ["another departure date", { check_in: "2027-03-08", check_out: "2027-03-13", guests: 2 }],
    ["another guest count", { check_in: "2027-03-08", check_out: "2027-03-12", guests: 4 }],
    ["a guest count as a string", { check_in: "2027-03-08", check_out: "2027-03-12", guests: "2" }],
  ] as const) {
    it(`refuses a genuine signed offer for ${name}`, async () => {
      serveNode(signedOffer({ request }));
      const { result, parsed } = await call();
      assertRuleRefusal(parsed, result, "request_mismatch");
    });
  }

  it("refuses to fetch at all when the stay asked for is incomplete (no guests)", async () => {
    const served = serveNode(signedOffer());
    const { result, parsed } = await call({ domain: DOMAIN, checkIn: STAY.check_in, checkOut: STAY.check_out });
    assert.equal(result.isError, true);
    assert.match(String(parsed.error), /guests/);
    assert.deepEqual(served.fetches, []);
  });

  it("refuses to fetch at all when the stay asked for names a date that does not exist", async () => {
    const served = serveNode(signedOffer());
    const { result, parsed } = await call({ ...ARGS, checkIn: "2027-02-30", checkOut: "2027-03-02" });
    assert.equal(result.isError, true);
    assert.match(String(parsed.error), /date that exists/);
    assert.deepEqual(served.fetches, []);
  });

  // -------------------------------------------------------------------------
  // Dates, language and time values in the signed payload (§5)

  it("refuses a signed check_in that does not exist (30 February), even with valid arguments", async () => {
    serveNode(signedOffer({ request: { check_in: "2027-02-30", check_out: "2027-03-02", guests: 2 } }));
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "invalid_check_in", "request_mismatch");
  });

  it("refuses a signed stay of zero nights and a stay that runs backwards", async () => {
    serveNode(signedOffer({ request: { check_in: "2027-03-08", check_out: "2027-03-08", guests: 2 } }));
    let { result, parsed } = await call({ ...ARGS, checkOut: "2027-03-09" });
    assertRuleRefusal(parsed, result, "check_out_not_after_check_in");
    mock.restoreAll();
    serveNode(signedOffer({ request: { check_in: "2027-03-12", check_out: "2027-03-08", guests: 2 } }));
    ({ result, parsed } = await call());
    assertRuleRefusal(parsed, result, "check_out_not_after_check_in");
  });

  it("refuses a signed stay that has passed everywhere (two days before the UTC date)", async () => {
    const stay = { check_in: "2026-11-08", check_out: "2026-11-12", guests: 2 };
    serveNode(signedOffer({ request: stay }));
    const { result, parsed } = await call({ domain: DOMAIN, checkIn: stay.check_in, checkOut: stay.check_out, guests: 2 });
    assertRuleRefusal(parsed, result, "check_in_in_past");
  });

  for (const [name, language] of [
    ["free text", "AUDIT TEXT: this stay is free of charge"],
    ["an empty string", ""],
    ["words joined by hyphens", "en-this-stay-is-free"],
    ["a trailing line break", "sv\n"],
  ] as const) {
    it(`refuses a signed request.language that is ${name}`, async () => {
      serveNode(signedOffer({ request: { ...STAY, language } }));
      const { result, parsed } = await call();
      assertRuleRefusal(parsed, result, "invalid_language");
    });
  }

  for (const [name, value, code] of [
    ["an offset instead of Z", "2026-11-10T13:00:00+02:00", "malformed_generated_at"],
    ["hour 24", "2026-11-10T24:00:00Z", "malformed_generated_at"],
    ["a date a JavaScript Date would still parse", "Nov 10 2026", "malformed_generated_at"],
    ["a number", NOW - 60_000, "malformed_generated_at"],
  ] as const) {
    it(`refuses generated_at that is ${name}`, async () => {
      serveNode(signedOffer({ generated_at: value }));
      const { result, parsed } = await call();
      assertRuleRefusal(parsed, result, code);
    });
  }

  for (const [name, value] of [
    ["an offset instead of Z", "2026-11-10T14:10:00+02:00"],
    ["30 February", "2027-02-30T12:10:00Z"],
    ["a date a JavaScript Date would still parse", "Nov 10 2036"],
  ] as const) {
    it(`refuses valid_until that is ${name}`, async () => {
      serveNode(signedOffer({ valid_until: value }));
      const { result, parsed } = await call();
      assertRuleRefusal(parsed, result, "malformed_valid_until");
    });
  }

  // -------------------------------------------------------------------------
  // The lifetime boundaries (§5, §6)

  it("refuses a lifetime of 900 seconds and one millisecond", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW - 300_000), valid_until: iso(NOW + 600_001) }));
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "lifetime_too_long");
  });

  it("refuses a lifetime of 901 seconds and one of ten years", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW - 300_000), valid_until: iso(NOW + 601_000) }));
    let { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "lifetime_too_long");
    mock.restoreAll();
    serveNode(signedOffer({ generated_at: iso(NOW - 60_000), valid_until: "2036-11-10T12:00:00Z" }));
    ({ result, parsed } = await call());
    assertRuleRefusal(parsed, result, "lifetime_too_long");
  });

  it("refuses valid_until equal to generated_at and valid_until before generated_at", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW - 10_000), valid_until: iso(NOW - 10_000) }));
    let { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "lifetime_not_positive");
    mock.restoreAll();
    serveNode(signedOffer({ generated_at: iso(NOW + 30_000), valid_until: iso(NOW + 20_000) }));
    ({ result, parsed } = await call());
    assertRuleRefusal(parsed, result, "lifetime_not_positive");
  });

  it("refuses generated_at 60 seconds and one millisecond ahead of the clock, and a window that starts a year from now", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW + 60_001), valid_until: iso(NOW + 660_000) }));
    let { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "generated_at_in_future");
    mock.restoreAll();
    const year = 365 * 86_400_000;
    serveNode(signedOffer({ generated_at: iso(NOW + year), valid_until: iso(NOW + year + 900_000) }));
    ({ result, parsed } = await call());
    assertRuleRefusal(parsed, result, "generated_at_in_future");
  });

  it("refuses valid_until equal to now (fresh means later than now)", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW - 300_000), valid_until: iso(NOW) }));
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "expired");
  });

  it("lists every rule broken, first one as the code", async () => {
    serveNode(signedOffer({ generated_at: iso(NOW + 120_000), valid_until: iso(NOW - 1), request: { ...STAY, guests: 3 } }));
    const { result, parsed } = await call();
    assertRuleRefusal(parsed, result, "lifetime_not_positive", "generated_at_in_future", "expired", "request_mismatch");
  });

  // -------------------------------------------------------------------------
  // The protections that were already there stay

  it("still refuses a tampered signature, and does not call the signature valid", async () => {
    serveNode(signedOffer(), {}, { tamper: (jws) => `${jws.slice(0, -4)}AAAA` });
    const { result, parsed } = await call();
    assert.equal(result.isError, true);
    assert.match(String(parsed.error), /signature verification failed/);
    assert.equal(parsed.signature_valid, undefined);
  });

  it("still refuses a plaintext offer that differs from the signed payload", async () => {
    const offer = signedOffer({ price: { currency: "EUR", total: 900, exact: false } });
    serveNode(offer, {}, { visibleOffer: { ...offer, price: { currency: "EUR", total: 900, exact: true } } });
    const { result, parsed } = await call();
    assert.equal(result.isError, true);
    assert.match(String(parsed.error), /Signed payload does not match returned offer/);
  });

  it("still refuses a signed offer that names another domain", async () => {
    serveNode(signedOffer({ canonical_domain: "other.example", node_id: "other.example", booking: { direct_booking_url: "https://other.example/book" } }));
    const { result, parsed } = await call();
    assert.equal(result.isError, true);
    assert.match(String(parsed.error), /not this node's offer \(VRP §7\)/);
  });

  it("still withholds a booking URL that is not a node URL of the domain", async () => {
    serveNode(signedOffer({ booking: { direct_booking_url: `https://airbnb.${DOMAIN}/book` } }));
    const { result, parsed } = await call();
    assertNotQuoteable(parsed, result, "direct_booking_url_not_node_url");
    assert.equal((parsed.official_offer_summary as Json).direct_booking_url, null);
  });

  // -------------------------------------------------------------------------
  // The standard's own offer-rules vectors, through the handler

  describe("vrp-spec offer-rules vectors (spec/offer-rules/vectors.v0.1.json)", () => {
    it("state the same cap and clock allowance as Core §5 and §6", () => {
      assert.equal(VECTORS.max_lifetime_seconds, 900);
      assert.equal(VECTORS.clock_skew_seconds, 60);
      assert.ok(VECTORS.vectors.length >= 40);
    });

    for (const v of VECTORS.vectors) {
      it(`${v.name}: ${v.expected.reasons.length === 0 ? "quoteable" : v.expected.reasons.join(", ")}`, async () => {
        mock.timers.reset();
        mock.timers.enable({ apis: ["Date"], now: Date.parse(VECTORS.now) });
        primeHostOwnedLists(LISTS);
        const offer = signedOffer(
          Object.fromEntries(["generated_at", "valid_until", "request"].filter((k) => k in v.offer).map((k) => [k, v.offer[k]])),
          ["generated_at", "valid_until", "request"].filter((k) => !(k in v.offer)),
        );
        const served = serveNode(offer);
        if (v.asked === null) {
          // The tool cannot be asked without a stay: its arguments are required,
          // so "asked_stay_unknown" cannot arise here; it is refused earlier.
          const { result } = await call({ domain: DOMAIN });
          assert.equal(result.isError, true);
          assert.deepEqual(served.fetches, []);
          return;
        }
        const { result, parsed } = await call({ domain: DOMAIN, checkIn: v.asked.check_in, checkOut: v.asked.check_out, guests: v.asked.guests });
        if (v.expected.reasons.length === 0) {
          assert.equal(result.isError, undefined, String(parsed.error));
          assert.equal((parsed.agent_citation as Json).safe_to_quote_as_official_direct_offer, true);
          return;
        }
        assert.equal(result.isError, true, "the vector expects a refusal");
        if (parsed.reasons !== undefined) {
          // Refused by the Core rules, with exactly the vector's reasons in the vector's order.
          assert.deepEqual(parsed.reasons, v.expected.reasons);
          assert.equal(parsed.signature_valid, true);
        } else {
          // Refused before fetching: the stay asked for itself names a date that
          // does not exist, or a departure that is not after the arrival.
          assert.deepEqual(served.fetches, []);
          assert.match(String(parsed.error), /date that exists|checkOut must be after checkIn/);
        }
      });
    }
  });
});
