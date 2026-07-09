import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { formatAmenityLabel } from "./tools-base.js";
import { guestWelcomeByLocale } from "./vrp-trust-copy.js";
import type { ToolResult } from "./tools-base.js";

export const VRP_PROTOCOL = "vacation-rental-protocol";
export const VRP_PROTOCOL_VERSION = "0.1";
export const VRP_JWS_ALG = "EdDSA";
export const VRP_FETCH_TIMEOUT_MS = 8_000;
export const VRP_TOOL_NAMES = [
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|lan|home|test)$/i;
const IP_LIKE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/i;
const OFFICIAL_AGENT_MESSAGE = "I found the official host-domain verified offer for this stay.";
const AGENT_DIRECT_TOTAL_MESSAGE_PREFIX = "Direct host-domain total";
const BLOCKED_AGENT_CLAIMS = [
  "Do not present discounts, savings, promo codes, OTA comparisons, or price reductions in guest-facing copy.",
  "Do not say the stay is bookable unless availability.available is true and agent permission allows quoting.",
  "Do not quote a final total unless price.exact is true in the signed offer.",
  "Do not derive weekday labels from memory; use signed offer breakdown dates or a deterministic date library.",
  "Do not route booking action anywhere except the signed direct booking URL.",
  "Do not call the direct booking URL the guest's own domain, 'your domain', or 'your site'; it is the host's own domain and the guest books directly with the host.",
  "Do not mention commission percentages, platform fees, middlemen, or 'no hidden fees' in guest-facing copy; say instead that booking and payment are made directly with the host.",
  "Do not call the stay a 'perfect match' or promise perfection; say it matches the guest's wishes.",
  "Do not tell the guest something is 'not flagged' or 'not in the data'; if policy_claims marks it negated, relay a clear friendly no — otherwise say there is no verified information about it and suggest asking the host before booking.",
] as const;

/**
 * Policy-domain claim keys surfaced from the node's own tri-state claims
 * ledger (discovery `claims` array) so an agent can answer "can I bring a
 * cat?" with the host's explicit yes/no instead of guessing from a generic
 * pets flag. Mirrors POLICY_NEGATION_CLAIM_KEYS in lib/tools-base.ts —
 * keep in sync.
 */
const POLICY_CLAIM_KEYS = [
  "pets_dogs",
  "pets_cats",
  "smoking_indoor",
  "smoking_outdoor",
] as const;

/**
 * Comfort-detail claim keys guests ask about by name ("mörkläggningsgardiner?",
 * "AC?"). Same tri-state semantics as POLICY_CLAIM_KEYS: affirmed = yes,
 * negated = clear no, absent = unknown. Extend deliberately — signals and
 * offer stay compact by design.
 */
const COMFORT_CLAIM_KEYS = ["blackout_curtains", "air_conditioning"] as const;

/**
 * The verified-source line relayed to the guest after the price. sv/en are
 * pinned copy (approved 2026-07-08); other locales carry the meaning, so the
 * agent translates faithfully rather than relaying English to a non-English
 * guest.
 */
const VERIFIED_SOURCE_LINE_BY_LOCALE: Record<string, string> = {
  sv: "Pris och tillgänglighet är verifierade direkt från värdens egen bokningssida.",
  en: "Price and availability are verified directly from the host's own booking page.",
};

type JsonRecord = Record<string, unknown>;

type VerifiedNode = {
  domain: string;
  discoveryUrl: string;
  jwksUrl: string;
  verifiedStayOfferUrl: string;
  discovery: JsonRecord;
  jwks: JsonRecord;
  signingKey: JsonRecord;
};

export function isVrpToolName(name: string): boolean {
  return (VRP_TOOL_NAMES as readonly string[]).includes(name);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toolOk(value: JsonRecord, meta?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(meta ? { _meta: meta } : {}),
  };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function requirePresentArgs(args: Record<string, unknown>, keys: readonly string[]): void {
  const missing = keys.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
  });
  if (missing.length > 0) throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = stringValue(args[key]);
  if (!value) throw new Error(`Missing required argument(s): ${key}`);
  return value;
}

function requireIntegerArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (value === undefined || value === null) throw new Error(`Missing required argument(s): ${key}`);
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${key} must be an integer >= 1`);
  return Number(value);
}

function validateDateArg(value: string, key: string): void {
  if (!ISO_DATE_RE.test(value)) throw new Error(`${key} must be YYYY-MM-DD`);
}

function normalizeVrpDomain(input: string): string {
  let raw = input.trim().toLowerCase();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    raw = url.hostname;
  }
  raw = raw.replace(/\.$/, "");
  if (!DOMAIN_RE.test(raw)) throw new Error(`Invalid public domain: ${input}`);
  if (PRIVATE_HOST_RE.test(raw) || IP_LIKE_RE.test(raw) || raw.includes(":")) {
    throw new Error(`Refusing to verify non-public host: ${input}`);
  }
  return raw;
}

function sameDomainUrl(value: string | null, domain: string, fallbackPath: string, fieldName: string): string {
  const url = new URL(value ?? fallbackPath, `https://${domain}`);
  if (url.protocol !== "https:") throw new Error(`${fieldName} must be https`);
  const host = normalizeVrpDomain(url.hostname);
  if (host !== domain) throw new Error(`${fieldName} must stay on the verified host domain`);
  return url.toString();
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(VRP_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`VRP fetch timed out for ${url} after ${VRP_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }
  if (!res.ok) throw new Error(`Fetch failed for ${url}: HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

function firstEd25519Key(jwks: JsonRecord): JsonRecord {
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const key = keys.find((candidate) => {
    const record = asRecord(candidate);
    return record?.kty === "OKP" && record?.crv === "Ed25519" && (!record.alg || record.alg === VRP_JWS_ALG);
  });
  const record = asRecord(key);
  if (!record) throw new Error("JWKS does not contain an Ed25519 OKP signing key");
  return record;
}

async function verifyVacationRentalNode(domainInput: string): Promise<VerifiedNode> {
  const domain = normalizeVrpDomain(domainInput);
  const discoveryUrl = `https://${domain}/.well-known/vacation-rental.json`;
  const discovery = asRecord(await fetchJson(discoveryUrl));
  if (!discovery) throw new Error("vacation-rental.json must be a JSON object");

  if (discovery.protocol !== VRP_PROTOCOL) {
    throw new Error(`Unsupported protocol: ${String(discovery.protocol)}`);
  }
  const version = stringValue(discovery.protocol_version) ?? stringValue(discovery.version);
  if (version !== VRP_PROTOCOL_VERSION) {
    throw new Error(`Unsupported VRP version: ${String(version)}`);
  }

  const declaredDomain = normalizeVrpDomain(
    stringValue(discovery.canonical_domain) ?? stringValue(discovery.domain) ?? domain
  );
  if (declaredDomain !== domain) {
    throw new Error(`Discovery canonical_domain mismatch: expected ${domain}, got ${declaredDomain}`);
  }

  const endpoints = asRecord(discovery.endpoints);
  const jwksUrl = sameDomainUrl(
    stringValue(discovery.jwks_uri) ?? stringValue(discovery.jwks_url),
    domain,
    "/.well-known/jwks.json",
    "jwks_uri"
  );
  const verifiedStayOfferUrl = sameDomainUrl(
    stringValue(discovery.verified_stay_offer_endpoint) ??
      stringValue(discovery.verified_stay_offer_url) ??
      stringValue(endpoints?.verified_stay_offer) ??
      stringValue(endpoints?.verified_stay_offer_url),
    domain,
    "/api/verified-stay-offer",
    "verified_stay_offer_endpoint"
  );

  const jwks = asRecord(await fetchJson(jwksUrl));
  if (!jwks) throw new Error("JWKS must be a JSON object");
  const signingKey = firstEd25519Key(jwks);

  return { domain, discoveryUrl, jwksUrl, verifiedStayOfferUrl, discovery, jwks, signingKey };
}

function base64urlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function parseBase64urlJson(value: string): JsonRecord {
  const parsed = JSON.parse(base64urlDecode(value).toString("utf8"));
  const record = asRecord(parsed);
  if (!record) throw new Error("JWS part must decode to a JSON object");
  return record;
}

export function verifyCompactJws(jws: string, jwks: JsonRecord): { header: JsonRecord; payload: JsonRecord; kid: string | null } {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("signed_verified_stay_offer must be compact JWS");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseBase64urlJson(encodedHeader);
  const payload = parseBase64urlJson(encodedPayload);
  if (header.alg !== VRP_JWS_ALG) throw new Error(`Unsupported JWS alg: ${String(header.alg)}`);

  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const kid = stringValue(header.kid);
  const candidates = keys
    .map((candidate) => asRecord(candidate))
    .filter((candidate): candidate is JsonRecord => Boolean(candidate))
    .filter((candidate) => candidate.kty === "OKP" && candidate.crv === "Ed25519")
    .filter((candidate) => !kid || candidate.kid === kid);

  if (candidates.length === 0) throw new Error("No matching Ed25519 key found for JWS kid");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64urlDecode(encodedSignature);

  for (const jwk of candidates) {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" } as never);
    if (cryptoVerify(null, Buffer.from(signingInput), publicKey, signature)) {
      return { header, payload, kid };
    }
  }
  throw new Error("JWS signature verification failed");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stable(value));
}

function extractSignedOffer(value: JsonRecord): string {
  const signature = asRecord(value.signature);
  const jws =
    stringValue(value.signed_verified_stay_offer) ??
    stringValue(value.verified_stay_offer_jws) ??
    stringValue(value.jws) ??
    stringValue(signature?.jws);
  if (!jws) throw new Error("Offer response did not include signature.jws or signed_verified_stay_offer");
  return jws;
}

function extractOfferPayload(payload: JsonRecord): JsonRecord {
  return asRecord(payload.offer) ?? payload;
}

function validUntilFrom(offer: JsonRecord, response: JsonRecord): string | null {
  return stringValue(offer.valid_until) ?? stringValue(response.valid_until);
}

function mayQuoteOfficialOffer(offer: JsonRecord, response: JsonRecord): boolean {
  const permission = asRecord(offer.agent_permission) ?? asRecord(response.agent_permission);
  return permission?.may_quote_as_official_direct_offer === true;
}

function availabilityRecordFrom(offer: JsonRecord, response: JsonRecord): JsonRecord | null {
  return asRecord(offer.availability) ?? asRecord(response.availability);
}

function priceRecordFrom(offer: JsonRecord, response: JsonRecord): JsonRecord | null {
  return asRecord(offer.price) ?? asRecord(response.price);
}

function bookingRecordFrom(offer: JsonRecord, response: JsonRecord): JsonRecord | null {
  return asRecord(offer.booking) ?? asRecord(response.booking);
}

function offerAvailable(offer: JsonRecord, response: JsonRecord): boolean {
  const availability = availabilityRecordFrom(offer, response);
  const signedBoolean = booleanValue(availability?.available);
  if (signedBoolean !== null) return signedBoolean;
  const legacy = stringValue(offer.availability) ?? stringValue(response.availability);
  return legacy === "available";
}

function availabilityReason(offer: JsonRecord, response: JsonRecord): string | null {
  const availability = availabilityRecordFrom(offer, response);
  return stringValue(availability?.reason);
}

function exactPrice(offer: JsonRecord, response: JsonRecord): boolean {
  const price = priceRecordFrom(offer, response);
  // Defense in depth: a signed `reconciliation` block that explicitly fails to
  // reconcile (Σ breakdown + Σ adjustments !== total) can never back an exact
  // quote, regardless of what `exact` claims. Absent/legacy offers (no
  // reconciliation) fall through to the signed `exact` flag unchanged.
  const reconciliation = asRecord(price?.reconciliation);
  if (reconciliation && booleanValue(reconciliation.matches_quoted_total) === false) {
    return false;
  }
  const signedExact = booleanValue(price?.exact) ?? booleanValue(price?.price_is_exact);
  if (signedExact !== null) return signedExact;
  return (
    numberValue(price?.total) !== null ||
    numberValue(price?.public_total) !== null ||
    numberValue(price?.agent_total) !== null ||
    numberValue(offer.total_price) !== null
  );
}

function priceSummary(offer: JsonRecord, response: JsonRecord): JsonRecord {
  const price = priceRecordFrom(offer, response);
  const publicTotal =
    numberValue(price?.public_total) ??
    numberValue(price?.total) ??
    numberValue(offer.total_price);
  const agentTotal = numberValue(price?.agent_total);
  // P5: `total` is the channel-resolved total the agent quotes — agent_total
  // when present, then the signed `total`, then public_total. Mirrors the
  // signed payload's `total` and the widget's agent_total-first preference, so
  // payload, widget, required_phrase and this summary all agree on one meaning.
  const resolvedTotal =
    agentTotal ?? numberValue(price?.total) ?? publicTotal;
  return {
    currency: stringValue(price?.currency) ?? stringValue(offer.currency) ?? null,
    total: resolvedTotal,
    public_total: publicTotal,
    agent_total: agentTotal,
    exact: exactPrice(offer, response),
    no_add_on_fees: booleanValue(price?.no_add_on_fees),
    package_applied: price?.package_applied ?? null,
    breakdown: Array.isArray(price?.breakdown) ? price.breakdown : null,
    // Pass through the signed neutral adjustment lines + reconciliation block
    // so an agent/verifier sees that Σ breakdown + Σ adjustments === total.
    adjustments: Array.isArray(price?.adjustments) ? price.adjustments : null,
    reconciliation: asRecord(price?.reconciliation) ?? null,
  };
}

function propertySummary(offer: JsonRecord): JsonRecord {
  const property = asRecord(offer.property) ?? {};
  return {
    id: stringValue(property.id),
    name: stringValue(property.name),
    domain:
      stringValue(property.domain) ??
      stringValue(offer.canonical_domain) ??
      stringValue(offer.node_id),
    city: stringValue(property.city),
    region: stringValue(property.region),
    country: stringValue(property.country),
  };
}

/**
 * Pass through the signed `source_authority` block (host-verified direct source,
 * 0% commission, payment to host) so MCP-using agents SEE the node's verified
 * direct-source identity — not just the raw-offer readers. Own facts only; never
 * an OTA comparison.
 */
function sourceAuthoritySummary(offer: JsonRecord): JsonRecord | null {
  const sa = asRecord(offer.source_authority);
  if (!sa) return null;
  return {
    model: stringValue(sa.model),
    is_official_source_for_property: booleanValue(sa.is_official_source_for_property),
    intermediary: stringValue(sa.intermediary),
    payment_recipient: stringValue(sa.payment_recipient),
    booking_model: stringValue(sa.booking_model),
    booking_commission_pct: numberValue(sa.booking_commission_pct),
  };
}

export function amenitiesFromDiscovery(discovery: JsonRecord): string[] {
  const raw = Array.isArray(discovery.amenities) ? discovery.amenities : [];
  const labels: string[] = [];
  for (const item of raw) {
    const s = stringValue(item);
    if (!s) continue;
    // The node file emits CANONICAL snake_case tokens (one format since
    // smart-stays #2073). Display-format them — the old "skip anything with
    // an underscore" filter silently dropped hot_tub/ev_charging from the
    // widget and the agent-visible amenity list, which made agents narrate
    // a signals-vs-offer discrepancy to guests.
    const label = formatAmenityLabel(s);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 4) break;
  }
  return labels;
}

function logoFromDiscovery(discovery: JsonRecord): string | null {
  const media = asRecord(discovery.media);
  const candidate =
    stringValue(media?.logo) ?? stringValue(discovery.logo_url) ?? stringValue(discovery.logo);
  if (!candidate) return null;
  try {
    if (new URL(candidate).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return candidate;
}

function mediaImagesFromDiscovery(discovery: JsonRecord): JsonRecord[] {
  const media = asRecord(discovery.media);
  const images = Array.isArray(media?.images) ? media.images : [];
  const collected: JsonRecord[] = [];
  for (const item of images) {
    const record = asRecord(item);
    const url = stringValue(record?.url) ?? (typeof item === "string" ? stringValue(item) : null);
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    collected.push({
      url,
      alt: stringValue(record?.alt),
      category: stringValue(record?.category),
    });
    if (collected.length >= 8) break;
  }
  return collected;
}

/**
 * Extract the host's explicit yes/no answers for a whitelisted set of keys
 * from the node's tri-state claims ledger (discovery `claims`:
 * [{claim, state}, …]). A key absent from both lists is UNKNOWN (the host
 * never answered), which the agent must not turn into either a yes or a no.
 */
function claimsFromDiscovery(
  discovery: JsonRecord,
  keys: readonly string[],
): JsonRecord | null {
  const claims = Array.isArray(discovery.claims) ? discovery.claims : [];
  if (claims.length === 0) return null;
  const affirmed: string[] = [];
  const negated: string[] = [];
  for (const item of claims) {
    const record = asRecord(item);
    const key = stringValue(record?.claim);
    if (!key || !keys.includes(key)) continue;
    const state = stringValue(record?.state);
    if (state === "affirmed") affirmed.push(key);
    else if (state === "negated") negated.push(key);
  }
  if (affirmed.length === 0 && negated.length === 0) return null;
  return { affirmed, negated };
}

function policyClaimsFromDiscovery(discovery: JsonRecord): JsonRecord | null {
  return claimsFromDiscovery(discovery, POLICY_CLAIM_KEYS);
}

/**
 * Extract rules.refund_schedule from the VERIFIED offer payload — the
 * signed source, never the discovery document (vrp-spec §5.4: the class of
 * a value follows WHERE it was read; only the signed payload is
 * "verifiable"). Rows are passed through verbatim after a defensive shape
 * check; anything malformed degrades to null (unknown), never to a guess.
 */
function refundScheduleFromOffer(offer: JsonRecord): unknown {
  const rules = asRecord(offer.rules);
  const schedule = rules?.refund_schedule;
  if (schedule === null || schedule === undefined) return null;
  if (!Array.isArray(schedule)) return null;
  for (const item of schedule) {
    const row = asRecord(item);
    if (!row) return null;
    if (typeof row.hours_before_checkin !== "number" || typeof row.refund_percent !== "number") {
      return null;
    }
  }
  return schedule;
}

/**
 * LS-2/3/6: bed configuration, comfort claims, and stay times from the node's
 * own discovery document — the long-tail answers guests actually ask about
 * ("are the beds firm?", "blackout curtains?", "when is check-in?"). All read
 * from the already-fetched discovery doc; no extra I/O. Every sub-block is
 * optional: a node that has not declared it emits nothing (unknown ≠ no).
 */
function stayDetailsFromDiscovery(discovery: JsonRecord): JsonRecord | null {
  const out: JsonRecord = {};

  const capacity = asRecord(discovery.capacity);
  const beds = asRecord(capacity?.beds);
  const roomsRaw = Array.isArray(beds?.rooms) ? beds.rooms : [];
  const rooms: JsonRecord[] = [];
  for (const item of roomsRaw) {
    const room = asRecord(item);
    if (!room) continue;
    const label = stringValue(room.label);
    const bedList = Array.isArray(room.beds) ? room.beds : [];
    const cleanBeds: JsonRecord[] = [];
    for (const bedItem of bedList) {
      const bed = asRecord(bedItem);
      if (!bed) continue;
      const type = stringValue(bed.type);
      if (!type) continue;
      const clean: JsonRecord = { type };
      const count = numberValue(bed.count);
      if (count !== null) clean.count = count;
      const firmness = stringValue(bed.firmness);
      if (firmness) clean.mattress_firmness = firmness;
      cleanBeds.push(clean);
    }
    if (!label && cleanBeds.length === 0) continue;
    rooms.push({ label, beds: cleanBeds });
  }
  if (rooms.length > 0) {
    const bedConfiguration: JsonRecord = { rooms };
    const bedroomCount = numberValue(capacity?.bedrooms);
    if (bedroomCount !== null) bedConfiguration.bedrooms = bedroomCount;
    out.bed_configuration = bedConfiguration;
  }

  const comfort = claimsFromDiscovery(discovery, COMFORT_CLAIM_KEYS);
  if (comfort) out.comfort_claims = comfort;

  const availability = asRecord(discovery.availability);
  const checkInTime = stringValue(availability?.check_in_time);
  const checkOutTime = stringValue(availability?.check_out_time);
  if (checkInTime) out.check_in_time = checkInTime;
  if (checkOutTime) out.check_out_time = checkOutTime;

  const policies = asRecord(discovery.policies);
  const earlyCheckin = booleanValue(policies?.allow_early_checkin);
  if (earlyCheckin !== null) out.early_checkin_available = earlyCheckin;
  const lateCheckout = booleanValue(policies?.allow_late_checkout);
  if (lateCheckout !== null) out.late_checkout_available = lateCheckout;

  return Object.keys(out).length > 0 ? out : null;
}

function formatMoney(amount: unknown, currency: unknown): string | null {
  const numeric = numberValue(amount);
  if (numeric === null) return null;
  const currencyCode = stringValue(currency);
  return currencyCode ? `${numeric} ${currencyCode}` : String(numeric);
}

function officialAgentMessage(price: JsonRecord, safeToQuote: boolean): string | null {
  if (!safeToQuote) return null;
  const agentTotal = formatMoney(price.agent_total, price.currency);
  if (!agentTotal) return OFFICIAL_AGENT_MESSAGE;
  return `${OFFICIAL_AGENT_MESSAGE} ${AGENT_DIRECT_TOTAL_MESSAGE_PREFIX}: ${agentTotal}.`;
}

function directBookingUrlFrom(offer: JsonRecord, response: JsonRecord): string | null {
  const booking = bookingRecordFrom(offer, response);
  return (
    stringValue(booking?.direct_booking_url) ??
    stringValue(booking?.booking_url) ??
    stringValue(offer.direct_booking_url) ??
    stringValue(offer.booking_url) ??
    stringValue(response.direct_booking_url) ??
    stringValue(response.booking_url)
  );
}

function quoteBlockedReason(mayQuote: boolean, available: boolean, priceExact: boolean, directBookingUrl: string | null): string | null {
  if (!mayQuote) return "agent_permission_denied";
  if (!available) return "not_available";
  if (!priceExact) return "price_not_exact";
  if (!directBookingUrl) return "direct_booking_url_missing";
  return null;
}

function buildAgentQuoteView(
  offer: JsonRecord,
  response: JsonRecord,
  validUntil: string | null,
  discovery: JsonRecord,
): JsonRecord {
  const mayQuote = mayQuoteOfficialOffer(offer, response);
  const available = offerAvailable(offer, response);
  const price = priceSummary(offer, response);
  const directBookingUrl = directBookingUrlFrom(offer, response);
  const priceExact = price.exact === true;
  const safeToQuote = mayQuote && available && priceExact && Boolean(directBookingUrl);
  const blockedReason = quoteBlockedReason(mayQuote, available, priceExact, directBookingUrl);
  const agentMessage = officialAgentMessage(price, safeToQuote);
  const widgetImages = mediaImagesFromDiscovery(discovery);
  const summaryProperty = propertySummary(offer);
  if (widgetImages.length) summaryProperty.images = widgetImages;
  const widgetLogo = logoFromDiscovery(discovery);
  if (widgetLogo) summaryProperty.logo_url = widgetLogo;
  const discoveryRegion =
    stringValue(asRecord(discovery.location)?.region) ?? stringValue(discovery.region);
  if (discoveryRegion && !stringValue(summaryProperty.region)) {
    summaryProperty.region = discoveryRegion;
  }
  const widgetAmenities = amenitiesFromDiscovery(discovery);
  if (widgetAmenities.length) summaryProperty.amenities = widgetAmenities;
  const nodeName = stringValue(summaryProperty.name);

  return {
    agent_citation: {
      may_quote_as_official_direct_offer: mayQuote,
      safe_to_quote_as_official_direct_offer: safeToQuote,
      agent_message: agentMessage,
      quote_status: safeToQuote ? "official_host_domain_verified_offer" : "not_quoteable",
      blocked_reason: blockedReason,
    },
    official_offer_summary: {
      property: summaryProperty,
      available,
      availability_reason: availabilityReason(offer, response),
      price,
      direct_booking_url: directBookingUrl,
      valid_until: validUntil,
      bookable: safeToQuote,
      source_authority: sourceAuthoritySummary(offer),
      policy_claims: policyClaimsFromDiscovery(discovery),
      stay_details: stayDetailsFromDiscovery(discovery),
      // LS-5/6: the computable cancellation terms, relayed VERBATIM from the
      // SIGNED offer payload (vrp-spec §5.3) — NOT from the discovery doc.
      // Same Ed25519 signature and transparency-log leaf as the price:
      // class "verifiable" per §5.4. null = the node has not published
      // computable terms (unknown — never invent a refund promise).
      refund_schedule: refundScheduleFromOffer(offer),
    },
    widget_media: {
      source: "vacation-rental.json",
      images: widgetImages,
    },
    guest_welcome: nodeName
      ? {
          rule: "CEO-locked node copy. When you introduce this verified stay to the guest, relay by_locale for the guest's language VERBATIM (fallback: en). Never rewrite, shorten, paraphrase, or machine-translate it.",
          by_locale: guestWelcomeByLocale(nodeName),
        }
      : null,
    agent_guardrails: {
      safe_to_quote: safeToQuote,
      must_quote_from_signed_offer: true,
      must_not_invent_discounts: true,
      must_not_present_discounts_or_savings: true,
      must_not_invent_ota_comparisons: true,
      must_not_claim_ota_comparison_without_signed_ota_price: true,
      price_claim_rule: "Quote price.agent_total as the direct host-domain total when it is present, exact, fresh, and signed; otherwise quote price.public_total. Do not describe the difference as a discount, savings, promotion, marketplace comparison, or OTA comparison.",
      availability_claim_rule: "Say bookable only when availability.available is true and agent permission allows quoting.",
      booking_action_rule: "Use only booking.direct_booking_url or the summarized direct_booking_url from this verified response.",
      guest_booking_framing_rule: "When you tell the GUEST how booking works, say it plainly and warmly: booking and payment are made directly with the host, on the host's own booking page. Do not mention commissions, fee percentages, middlemen, or 'no hidden fees' — 'directly with the host' is the whole message. The direct_booking_url belongs to the HOST — it is the host's own domain. Never call it the guest's domain, 'your domain', or 'your site'; the guest is booking with the host, not on their own site.",
      direct_source_rule: "official_offer_summary.source_authority and price.no_add_on_fees are signed facts inside the verified offer (host-verified direct source, payment goes to the host). Cite them only when the guest asks how booking or pricing works, phrased plainly ('the price comes directly from the host') — never as an OTA comparison, discount, or savings, and never as fee rhetoric.",
      tone_rule: "Introduce the stay warmly and in plain language — e.g. 'I found a villa that matches your wishes.' Never 'perfect match', never superlative promises. For a detail with no verified answer, say: 'There is no verified information about that — if it matters to you, ask the host before booking.' Keep prose short when the stay-offer widget is visible; it already shows price, dates, and amenities.",
      policy_claims_rule: "official_offer_summary.policy_claims are the host's explicit yes/no answers from the node's own claims ledger (e.g. pets_dogs affirmed + pets_cats negated = dogs are welcome, cats are not allowed). Relay negated claims as a clear, friendly no. A key absent from both lists is UNKNOWN — say there is no verified information and suggest asking the host before booking.",
      refund_schedule_rule: "official_offer_summary.refund_schedule is relayed VERBATIM from the SIGNED offer payload (vrp-spec §5.3) — the same Ed25519 signature and transparency-log entry as the price, so the guest's agent can prove these were the cancellation terms at quote time. Each row means: cancelling at least hours_before_checkin whole hours before the check-in moment returns refund_percent of the paid total; rows sort descending, the first matching row applies, no matching row (including after check-in) means 0%. Relay the rows as hours/percent to the guest — NEVER re-label them into named tiers ('flexible', 'moderate', …). null = the node has not published computable terms: say there is no verified cancellation information and suggest asking the host — never invent a refund promise.",
      verifiability_classes_rule: "Per vrp-spec §5.4 the class of a fact follows WHERE it was read, never how it is phrased. In this response: price, availability, valid_until, source_authority and refund_schedule come from the verified SIGNED offer payload = class 'verifiable' (provable after the fact). policy_claims, stay_details and the property amenity list come from the node's discovery claims = class 'attested' (the host's explicit statement, not purchase-bound). Review data, when present, is 'reputational'. NEVER present a lower class with higher-class language — an attested amenity is not 'verified', and 'verified'-sounding wording on unsigned data is a class violation.",
      verifiability: {
        verifiable: ["price", "availability", "valid_until", "source_authority", "refund_schedule"],
        attested: ["policy_claims", "stay_details", "property.amenities"],
      },
      stay_details_rule: "official_offer_summary.stay_details carries the node's own long-tail answers: bed_configuration lists each bedroom with bed type and mattress_firmness (so 'are the beds firm?' gets a precise, warm answer per room — e.g. 'Sovrum 3 Loft has a firm mattress; the other rooms are medium and soft'); comfort_claims follows the same yes/no/unknown semantics as policy_claims (e.g. blackout_curtains affirmed = yes); check_in_time / check_out_time are the host's stated times; early_checkin_available / late_checkout_available say whether the host offers flexible times — mention them only when the guest asks, and phrase a false plainly and kindly ('the host does not offer early check-in'). Anything missing from stay_details is UNKNOWN — never guess.",
      verified_source_line: {
        rule: "After quoting the price, relay this line in the guest's language. sv/en are pinned copy — relay VERBATIM; for other locales translate the meaning faithfully.",
        by_locale: VERIFIED_SOURCE_LINE_BY_LOCALE,
      },
      required_phrase_when_safe: agentMessage,
      blocked_claims: [...BLOCKED_AGENT_CLAIMS],
    },
  };
}

/**
 * Turn the node's own `host_alternatives` (returned when the requested dates
 * are blocked) into a one-line, actionable next step so an agent never hits a
 * wall. The agent re-calls get_verified_stay_offer for the chosen window to get
 * a signed, bookable offer. Node's own dates only — never a comparison.
 */
function buildAgentNextStep(hostAlternatives: JsonRecord | null): string | null {
  if (!hostAlternatives) return null;
  const shorten = asRecord(hostAlternatives.shorten_to);
  const next = asRecord(hostAlternatives.next_available);
  const options: string[] = [];
  if (shorten) {
    options.push(
      `shorten to ${stringValue(shorten.check_in)}–${stringValue(shorten.check_out)} (${numberValue(shorten.nights)} nights)`,
    );
  }
  if (next) {
    options.push(`next open window ${stringValue(next.check_in)}–${stringValue(next.check_out)}`);
  }
  if (options.length === 0) return null;
  return `Requested dates are not bookable. The host's own open options: ${options.join("; ")}. Re-call get_verified_stay_offer for the chosen window to get a signed, bookable offer.`;
}

async function runVerifyNode(args: Record<string, unknown>): Promise<ToolResult> {
  requirePresentArgs(args, ["domain"]);
  const domain = requireStringArg(args, "domain");
  const node = await verifyVacationRentalNode(domain);
  return toolOk({
    domain: node.domain,
    verified: true,
    protocol: VRP_PROTOCOL,
    protocol_version: VRP_PROTOCOL_VERSION,
    discovery_url: node.discoveryUrl,
    jwks_url: node.jwksUrl,
    verified_stay_offer_url: node.verifiedStayOfferUrl,
    signing: {
      alg: VRP_JWS_ALG,
      kty: node.signingKey.kty,
      crv: node.signingKey.crv,
      kid: node.signingKey.kid ?? null,
    },
  });
}

async function runGetVerifiedStayOffer(args: Record<string, unknown>): Promise<ToolResult> {
  // Date params are camelCase (checkIn/checkOut), consistent with every other
  // tool. Legacy snake_case input is mapped to camelCase centrally in
  // executeTool (lib/tools.ts, normalizeDateAliases) before this handler runs.
  // The VRP wire contract below stays snake_case (the host offer endpoint's
  // query params).
  requirePresentArgs(args, ["domain", "checkIn", "checkOut", "guests"]);
  const domain = requireStringArg(args, "domain");
  const checkIn = requireStringArg(args, "checkIn");
  const checkOut = requireStringArg(args, "checkOut");
  const guests = requireIntegerArg(args, "guests");
  validateDateArg(checkIn, "checkIn");
  validateDateArg(checkOut, "checkOut");
  if (checkOut <= checkIn) throw new Error("checkOut must be after checkIn");

  const node = await verifyVacationRentalNode(domain);
  const offerUrl = new URL(node.verifiedStayOfferUrl);
  offerUrl.searchParams.set("check_in", checkIn);
  offerUrl.searchParams.set("check_out", checkOut);
  offerUrl.searchParams.set("guests", String(guests));
  const language = stringValue(args.language);
  if (language) offerUrl.searchParams.set("language", language);

  const response = asRecord(await fetchJson(offerUrl.toString()));
  if (!response) throw new Error("Offer response must be a JSON object");
  const signedOffer = extractSignedOffer(response);
  const verified = verifyCompactJws(signedOffer, node.jwks);
  const offer = extractOfferPayload(verified.payload);
  const responseOffer = asRecord(response.offer);
  const payloadMatchesOffer = responseOffer ? stableStringify(responseOffer) === stableStringify(offer) : true;
  if (!payloadMatchesOffer) throw new Error("Signed payload does not match returned offer");

  const validUntil = validUntilFrom(offer, response);
  const fresh = Boolean(validUntil && Date.parse(validUntil) > Date.now());
  if (!fresh) throw new Error("verified_stay_offer is expired or missing valid_until");

  const quoteView = buildAgentQuoteView(offer, response, validUntil, node.discovery);
  const hostAlternatives = asRecord(response.host_alternatives);
  const agentNextStep = buildAgentNextStep(hostAlternatives);
  return toolOk({
    domain: node.domain,
    checkIn,
    checkOut,
    guests,
    verified: true,
    signature: {
      alg: VRP_JWS_ALG,
      kid: verified.kid,
      verified: true,
    },
    payload_matches_offer: true,
    fresh: true,
    ...quoteView,
    ...(hostAlternatives ? { host_alternatives: hostAlternatives } : {}),
    ...(agentNextStep ? { agent_next_step: agentNextStep } : {}),
  }, {
    signed_verified_stay_offer: signedOffer,
    offer,
  });
}

export async function executeVrpTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "verify_vacation_rental_node":
        return await runVerifyNode(args);
      case "get_verified_stay_offer":
        return await runGetVerifiedStayOffer(args);
      default:
        return toolError(`Unknown VRP tool: ${name}`);
    }
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}
