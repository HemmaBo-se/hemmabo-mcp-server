import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { ToolResult } from "./tools-base.js";

export const VRP_PROTOCOL = "vacation-rental-protocol";
export const VRP_PROTOCOL_VERSION = "0.1";
export const VRP_JWS_ALG = "EdDSA";
export const VRP_TOOL_NAMES = [
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|lan|home|test)$/i;
const IP_LIKE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/i;
const OFFICIAL_AGENT_MESSAGE = "I found the official host-domain verified offer for this stay.";

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

function toolOk(value: JsonRecord): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
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
  const jws =
    stringValue(value.signed_verified_stay_offer) ??
    stringValue(value.verified_stay_offer_jws) ??
    stringValue(value.jws);
  if (!jws) throw new Error("Offer response did not include signed_verified_stay_offer");
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
  requirePresentArgs(args, ["domain", "check_in", "check_out", "guests"]);
  const domain = requireStringArg(args, "domain");
  const checkIn = requireStringArg(args, "check_in");
  const checkOut = requireStringArg(args, "check_out");
  const guests = requireIntegerArg(args, "guests");
  validateDateArg(checkIn, "check_in");
  validateDateArg(checkOut, "check_out");
  if (checkOut <= checkIn) throw new Error("check_out must be after check_in");

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

  const mayQuote = mayQuoteOfficialOffer(offer, response);
  return toolOk({
    domain: node.domain,
    check_in: checkIn,
    check_out: checkOut,
    guests,
    verified: true,
    signature: {
      alg: VRP_JWS_ALG,
      kid: verified.kid,
      verified: true,
    },
    payload_matches_offer: true,
    fresh: true,
    signed_verified_stay_offer: signedOffer,
    offer,
    agent_citation: {
      may_quote_as_official_direct_offer: mayQuote,
      agent_message: mayQuote ? OFFICIAL_AGENT_MESSAGE : null,
    },
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
