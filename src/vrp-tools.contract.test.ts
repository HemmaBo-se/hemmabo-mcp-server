import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { executeTool } from "../lib/tools.js";
import { VRP_FETCH_TIMEOUT_MS } from "../lib/vrp.js";
import { HEMMABO_WIDGET_URI } from "../lib/apps-widget.js";

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
  it("uses a bounded fetch timeout for host-domain VRP calls", async () => {
    assert.equal(VRP_FETCH_TIMEOUT_MS, 8_000);
    const { publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "vrp-test-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";
    const signals: AbortSignal[] = [];

    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal instanceof AbortSignal, "VRP fetch must include an AbortSignal timeout");
      signals.push(init.signal);
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/vacation-rental.json") {
        return jsonResponse({
          protocol: "vacation-rental-protocol",
          protocol_version: "0.1",
          canonical_domain: "villaakerlyckan.se",
          jwks_uri: "https://villaakerlyckan.se/.well-known/jwks.json",
          verified_stay_offer_endpoint: "https://villaakerlyckan.se/api/verified-stay-offer",
          media: {
            images: [
              {
                url: "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/hero.jpg",
                alt: "Villa Akerlyckan exterior",
                category: "exterior",
              },
            ],
          },
          // Tri-state claims ledger excerpt: dogs yes, cats NO, plus a
          // non-policy claim that must NOT leak into policy_claims.
          claims: [
            { claim: "pets_dogs", state: "affirmed", verified_at: null },
            { claim: "pets_cats", state: "negated", verified_at: null },
            { claim: "smoking_outdoor", state: "affirmed", verified_at: null },
            { claim: "piano", state: "negated", verified_at: "2026-07-08" },
            { claim: "blackout_curtains", state: "affirmed", verified_at: "2026-07-08" },
            { claim: "air_conditioning", state: "negated", verified_at: null },
            // W5: the host's starred "Det lilla extra" (starred only on
            // affirmed rows per the editor's write rule). A starred NEGATED
            // row must never surface (defensive — the editor forbids it).
            { claim: "hot_tub", state: "affirmed", verified_at: "2026-07-08", starred: true },
            { claim: "ev_charging", state: "affirmed", verified_at: null, starred: true },
            { claim: "sauna", state: "negated", verified_at: null, starred: true },
          ],
          // LS-2/6 long-tail source blocks (mirrors the villa node file shape).
          capacity: {
            max_guests: 6,
            bedrooms: 3,
            beds: {
              double: 3,
              single: 0,
              rooms: [
                { label: "Sovrum 1", beds: [{ type: "double", count: 1, firmness: "medium" }] },
                { label: "Sovrum 3 Loft", beds: [{ type: "double", count: 1, firmness: "firm" }] },
              ],
            },
          },
          availability: { check_in_time: "16:00", check_out_time: "11:00" },
          policies: { allow_early_checkin: false, allow_late_checkout: false },
        });
      }
      if (url.pathname === "/.well-known/jwks.json") {
        return jsonResponse({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executeTool("verify_vacation_rental_node", { domain: "villaakerlyckan.se" }, clients);
    assert.equal(result.isError, undefined);
    assert.equal(signals.length, 2, "VRP node verification fetches discovery and JWKS");
    assert.ok(signals.every((signal) => !signal.aborted), "timeout signals should not abort successful fast responses");
  });

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
          media: {
            images: [
              {
                url: "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/hero.jpg",
                alt: "Villa Akerlyckan exterior",
                category: "exterior",
              },
            ],
          },
          // Tri-state claims ledger excerpt: dogs yes, cats NO, plus a
          // non-policy claim that must NOT leak into policy_claims.
          claims: [
            { claim: "pets_dogs", state: "affirmed", verified_at: null },
            { claim: "pets_cats", state: "negated", verified_at: null },
            { claim: "smoking_outdoor", state: "affirmed", verified_at: null },
            { claim: "piano", state: "negated", verified_at: "2026-07-08" },
            { claim: "blackout_curtains", state: "affirmed", verified_at: "2026-07-08" },
            { claim: "air_conditioning", state: "negated", verified_at: null },
            // W5: the host's starred "Det lilla extra" (starred only on
            // affirmed rows per the editor's write rule). A starred NEGATED
            // row must never surface (defensive — the editor forbids it).
            { claim: "hot_tub", state: "affirmed", verified_at: "2026-07-08", starred: true },
            { claim: "ev_charging", state: "affirmed", verified_at: null, starred: true },
            { claim: "sauna", state: "negated", verified_at: null, starred: true },
          ],
          // LS-2/6 long-tail source blocks (mirrors the villa node file shape).
          capacity: {
            max_guests: 6,
            bedrooms: 3,
            beds: {
              double: 3,
              single: 0,
              rooms: [
                { label: "Sovrum 1", beds: [{ type: "double", count: 1, firmness: "medium" }] },
                { label: "Sovrum 3 Loft", beds: [{ type: "double", count: 1, firmness: "firm" }] },
              ],
            },
          },
          availability: { check_in_time: "16:00", check_out_time: "11:00" },
          policies: { allow_early_checkin: false, allow_late_checkout: false },
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
        // P5: `total` is the channel-resolved (agent) total. Σ breakdown
        // (21000) + Σ adjustments (−3150) === agent_total (17850).
        total: 17850,
        public_total: 21000,
        agent_total: 17850,
        ota_comparison_total: null,
        ota_comparison_source: null,
        exact: true,
        no_add_on_fees: true,
        package_applied: null,
        breakdown: [
          { date: "2026-07-01", day_of_week: "Wed", nightly_rate: 21000 },
        ],
        adjustments: [
          {
            code: "agent_channel_rate",
            label: "Agentkanal-pris",
            amount: -3150,
            scope: "stay",
          },
        ],
        reconciliation: {
          nightly_subtotal: 21000,
          adjustments_total: -3150,
          computed_total: 17850,
          matches_quoted_total: true,
        },
      },
      source_authority: {
        model: "host_verified_direct_source",
        is_official_source_for_property: true,
        intermediary: "none",
        payment_recipient: "host",
        booking_model: "direct_with_host",
        booking_commission_pct: 0,
      },
      booking: {
        direct_booking_url: "https://villaakerlyckan.se/book?offer=vrp-test",
        offer_id: "vrp-test",
      },
      rules: {
        pets: "allowed",
        // Signed cancellation terms (vrp-spec §5.3) — inside the SAME JWS
        // as the price; the summary must relay them verbatim.
        refund_schedule: [{ hours_before_checkin: 24, refund_percent: 100 }],
        // W1 villkorssymmetrin: minimum age inside the signed payload.
        minimum_guest_age: 21,
      },
      // W1 villkorssymmetrin: the host's explicit terms INSIDE the JWS —
      // the summary must relay them as class "verifiable".
      terms: {
        policy_claims: { affirmed: ["pets_dogs"], negated: ["pets_cats", "smoking_indoor"] },
        service_included: ["breakfast_included", "wifi"],
        service_not_included: ["linens_included"],
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
          media: {
            images: [
              {
                url: "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/hero.jpg",
                alt: "Villa Akerlyckan exterior",
                category: "exterior",
              },
            ],
          },
          // Tri-state claims ledger excerpt: dogs yes, cats NO, plus a
          // non-policy claim that must NOT leak into policy_claims.
          claims: [
            { claim: "pets_dogs", state: "affirmed", verified_at: null },
            { claim: "pets_cats", state: "negated", verified_at: null },
            { claim: "smoking_outdoor", state: "affirmed", verified_at: null },
            { claim: "piano", state: "negated", verified_at: "2026-07-08" },
            { claim: "blackout_curtains", state: "affirmed", verified_at: "2026-07-08" },
            { claim: "air_conditioning", state: "negated", verified_at: null },
            // W5: the host's starred "Det lilla extra" (starred only on
            // affirmed rows per the editor's write rule). A starred NEGATED
            // row must never surface (defensive — the editor forbids it).
            { claim: "hot_tub", state: "affirmed", verified_at: "2026-07-08", starred: true },
            { claim: "ev_charging", state: "affirmed", verified_at: null, starred: true },
            { claim: "sauna", state: "negated", verified_at: null, starred: true },
          ],
          // LS-2/6 long-tail source blocks (mirrors the villa node file shape).
          capacity: {
            max_guests: 6,
            bedrooms: 3,
            beds: {
              double: 3,
              single: 0,
              rooms: [
                { label: "Sovrum 1", beds: [{ type: "double", count: 1, firmness: "medium" }] },
                { label: "Sovrum 3 Loft", beds: [{ type: "double", count: 1, firmness: "firm" }] },
              ],
            },
          },
          availability: { check_in_time: "16:00", check_out_time: "11:00" },
          policies: { allow_early_checkin: false, allow_late_checkout: false },
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
      checkIn: "2026-07-01",
      checkOut: "2026-07-08",
      guests: 4,
    }, clients);

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verified, true);
    assert.equal(parsed.signature.verified, true);
    assert.equal(parsed.payload_matches_offer, true);
    assert.equal(parsed.fresh, true);
    // Output echoes the canonical camelCase date params (not snake_case).
    assert.equal(parsed.checkIn, "2026-07-01");
    assert.equal(parsed.checkOut, "2026-07-08");
    assert.equal(result._meta?.["openai/outputTemplate"], HEMMABO_WIDGET_URI);
    assert.deepEqual(result._meta?.ui, { resourceUri: HEMMABO_WIDGET_URI });
    assert.equal(result._meta?.signed_verified_stay_offer, jws);
    assert.deepEqual(result._meta?.offer, offer);
    assert.equal(parsed.signed_verified_stay_offer, undefined);
    assert.equal(parsed.offer, undefined);
    assert.equal(parsed.agent_citation.agent_message, "I found the official host-domain verified offer for this stay. Direct host-domain total: 17850 SEK.");
    assert.equal(parsed.agent_citation.safe_to_quote_as_official_direct_offer, true);
    assert.equal(parsed.official_offer_summary.property.name, "Villa Åkerlyckan");
    assert.equal(parsed.official_offer_summary.property.domain, "villaakerlyckan.se");
    assert.equal(parsed.official_offer_summary.property.images[0].url, "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/hero.jpg");
    assert.equal(parsed.widget_media.source, "vacation-rental.json");
    assert.equal(parsed.widget_media.images[0].category, "exterior");
    // P5: the summary `total` is the channel-resolved (agent) total, and it
    // reconciles against the signed breakdown + adjustments.
    assert.equal(parsed.official_offer_summary.price.total, 17850);
    assert.equal(parsed.official_offer_summary.price.public_total, 21000);
    assert.equal(parsed.official_offer_summary.price.agent_total, 17850);
    assert.equal(parsed.official_offer_summary.price.adjustments[0].code, "agent_channel_rate");
    assert.equal(parsed.official_offer_summary.price.adjustments[0].label, "Agentkanal-pris");
    assert.equal(parsed.official_offer_summary.price.adjustments[0].amount, -3150);
    assert.equal(parsed.official_offer_summary.price.reconciliation.computed_total, 17850);
    assert.equal(parsed.official_offer_summary.price.reconciliation.matches_quoted_total, true);
    assert.equal(parsed.official_offer_summary.price.agent_discount_pct, undefined);
    assert.equal(parsed.official_offer_summary.price.savings_vs_public_total, undefined);
    assert.equal(parsed.official_offer_summary.price.discount_basis, undefined);
    assert.equal(parsed.official_offer_summary.price.ota_comparison_total, undefined);
    assert.equal(parsed.official_offer_summary.direct_booking_url, offer.booking.direct_booking_url);
    assert.equal(parsed.official_offer_summary.price.no_add_on_fees, true);
    assert.equal(parsed.official_offer_summary.source_authority.model, "host_verified_direct_source");
    assert.equal(parsed.official_offer_summary.source_authority.intermediary, "none");
    assert.equal(parsed.official_offer_summary.source_authority.payment_recipient, "host");
    assert.equal(parsed.official_offer_summary.source_authority.booking_commission_pct, 0);
    assert.match(parsed.agent_guardrails.direct_source_rule, /never as an OTA comparison/);
    assert.equal(parsed.agent_guardrails.must_not_invent_discounts, true);
    assert.equal(parsed.agent_guardrails.must_not_present_discounts_or_savings, true);
    assert.equal(parsed.agent_guardrails.must_not_claim_ota_comparison_without_signed_ota_price, true);
    assert.match(parsed.agent_guardrails.price_claim_rule, /Do not describe the difference as a discount/);
    assert.match(parsed.agent_guardrails.blocked_claims.join("\n"), /Do not present discounts/);

    // LS-1: the host's explicit yes/no policy answers ride the offer, sourced
    // from the node's own tri-state claims ledger — whitelisted policy keys
    // only (piano must not leak).
    assert.deepEqual(parsed.official_offer_summary.policy_claims, {
      affirmed: ["pets_dogs", "smoking_outdoor"],
      negated: ["pets_cats"],
    });
    assert.match(parsed.agent_guardrails.policy_claims_rule, /clear, friendly no/);
    assert.match(parsed.agent_guardrails.policy_claims_rule, /UNKNOWN/);
    // LS-1: warm tone — commission/fee rhetoric and 'perfect match' are out.
    assert.doesNotMatch(parsed.agent_guardrails.guest_booking_framing_rule, /0% commission/);
    assert.match(parsed.agent_guardrails.guest_booking_framing_rule, /directly with the host/);
    assert.match(parsed.agent_guardrails.tone_rule, /matches your wishes/);
    assert.match(parsed.agent_guardrails.blocked_claims.join("\n"), /perfect match/);
    assert.match(parsed.agent_guardrails.blocked_claims.join("\n"), /commission percentages/);
    // LS-1: the verified-source line is pinned sv/en guest copy.
    assert.equal(
      parsed.agent_guardrails.verified_source_line.by_locale.sv,
      "Pris och tillgänglighet är verifierade direkt från värdens egen bokningssida.",
    );
    assert.equal(
      parsed.agent_guardrails.verified_source_line.by_locale.en,
      "Price and availability are verified directly from the host's own booking page.",
    );

    // LS-2/3/6: bed firmness per room, comfort claims (tri-state), and stay
    // times ride the offer from the node's own discovery doc.
    const stay = parsed.official_offer_summary.stay_details;
    assert.equal(stay.bed_configuration.bedrooms, 3);
    assert.deepEqual(stay.bed_configuration.rooms[1], {
      label: "Sovrum 3 Loft",
      beds: [{ type: "double", count: 1, mattress_firmness: "firm" }],
    });
    assert.deepEqual(stay.comfort_claims, {
      affirmed: ["blackout_curtains"],
      negated: ["air_conditioning"],
    });
    assert.equal(stay.check_in_time, "16:00");
    assert.equal(stay.check_out_time, "11:00");
    assert.equal(stay.early_checkin_available, false);
    assert.equal(stay.late_checkout_available, false);
    assert.match(parsed.agent_guardrails.stay_details_rule, /mattress_firmness/);
    assert.match(parsed.agent_guardrails.stay_details_rule, /UNKNOWN/);

    // LS-6: the signed refund schedule rides the summary VERBATIM, with the
    // §5.4 class map marking it verifiable (read from the signed payload).
    assert.deepEqual(parsed.official_offer_summary.refund_schedule, [
      { hours_before_checkin: 24, refund_percent: 100 },
    ]);
    assert.match(parsed.agent_guardrails.refund_schedule_rule, /VERBATIM from the SIGNED offer payload/);
    assert.match(parsed.agent_guardrails.refund_schedule_rule, /NEVER re-label/);
    assert.match(parsed.agent_guardrails.verifiability_classes_rule, /WHERE it was read/);
    assert.ok(parsed.agent_guardrails.verifiability.verifiable.includes("refund_schedule"));

    // W1/W5 villkorssymmetrin: signed terms + minimum age relayed verbatim,
    // class "verifiable"; starred claims surface as the host's own curation.
    assert.deepEqual(parsed.official_offer_summary.terms, {
      policy_claims: { affirmed: ["pets_dogs"], negated: ["pets_cats", "smoking_indoor"] },
      service_included: ["breakfast_included", "wifi"],
      service_not_included: ["linens_included"],
    });
    assert.equal(parsed.official_offer_summary.minimum_guest_age, 21);
    assert.ok(parsed.agent_guardrails.verifiability.verifiable.includes("terms"));
    assert.ok(parsed.agent_guardrails.verifiability.verifiable.includes("minimum_guest_age"));
    assert.match(parsed.agent_guardrails.terms_rule, /NEVER a fee/);
    assert.match(parsed.agent_guardrails.terms_rule, /signed beats attested/);
    // Starred: affirmed-only (the starred NEGATED sauna row must not leak),
    // labeled via the same formatter as the amenity row.
    assert.deepEqual(parsed.official_offer_summary.property.starred_amenities, [
      "Hot tub",
      "EV charging",
    ]);
    assert.ok(parsed.agent_guardrails.verifiability.attested.includes("policy_claims"));

    // Backward compatibility: legacy snake_case input (check_in/check_out)
    // is still accepted and resolves to the same verified offer. The wire
    // URL above already asserted snake_case, so the casing translation holds
    // for both input forms.
    const legacy = await executeTool("get_verified_stay_offer", {
      domain: "villaakerlyckan.se",
      check_in: "2026-07-01",
      check_out: "2026-07-08",
      guests: 4,
    }, clients);
    assert.equal(legacy.isError, undefined);
    const legacyParsed = JSON.parse(legacy.content[0].text);
    assert.equal(legacyParsed.verified, true);
    assert.equal(legacyParsed.checkIn, "2026-07-01");
    assert.equal(legacyParsed.checkOut, "2026-07-08");
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
