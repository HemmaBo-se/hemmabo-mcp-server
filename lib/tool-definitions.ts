import { TOOL_SPECS as HEMMABO_TOOL_SPECS, toZodShape } from "./tool-definitions-base.js";
import type { ToolSpec as ToolSpecType } from "./tool-definitions-base.js";
import { HEMMABO_WIDGET_TOOL_META } from "./apps-widget.js";

export { toZodShape };
export type {
  JsonSchemaField,
  ToolInputSchema,
  ToolOutputSchema,
  ToolAnnotations,
  ToolSpec,
} from "./tool-definitions-base.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const DOMAIN_PATTERN = "^(?!-)(?:[a-zA-Z0-9-]{1,63}\\.)+[a-zA-Z]{2,63}$";

const VRP_TOOL_SPECS: readonly ToolSpecType[] = [
  {
    name: "verify_vacation_rental_node",
    description:
      "Verify that a vacation-rental host domain is a valid Vacation Rental Protocol (VRP) node before trusting it. Reads https://{domain}/.well-known/vacation-rental.json, follows the node JWKS, and confirms protocol identity, canonical host-domain control, Ed25519 signing keys, and a verified stay-offer endpoint. This is a read-only trust check only: it does not check availability, calculate pricing, create bookings, lock quotes, collect guest details, or start payment. To fetch live dates, price, booking rules, and the visual stay-offer widget, call get_verified_stay_offer with the verified domain plus check-in, check-out, and guest count.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Canonical public host-owned vacation-rental domain to verify, e.g. villaakerlyckan.se. Provide only the domain: no https:// prefix, path, query string, port, or booking URL.",
        },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Echoed canonical host domain that was checked." },
        verified: { type: "boolean", description: "True only when discovery, JWKS, signing metadata, and verified-offer endpoint checks pass." },
        protocol: { type: "string", description: "Protocol identifier discovered on the host domain, typically 'vrp'." },
        protocol_version: { type: "string", description: "VRP version declared by the host discovery document." },
        discovery_url: { type: "string", format: "uri", description: "The .well-known vacation-rental discovery URL read from the host domain." },
        jwks_url: { type: "string", format: "uri", description: "Host-domain JWKS URL containing the Ed25519 public keys used to verify signed offers." },
        verified_stay_offer_url: { type: "string", format: "uri", description: "Host-domain endpoint template or URL used to request signed verified stay offers." },
        signing: { type: "object", description: "Summary of accepted signing algorithms, key ids, and signing-key checks.", additionalProperties: true },
        error: { type: "string", description: "Present when verified=false or the node cannot be checked." },
      },
      required: ["domain", "verified"],
      additionalProperties: true,
    },
    annotations: {
      title: "Verify Vacation Rental Node",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_verified_stay_offer",
    description:
      "Fetch, verify, and render a live host-domain signed VRP stay offer for exact dates and guest count. The tool reads the host's verified stay-offer endpoint, verifies the Ed25519 compact JWS against the domain JWKS, and returns structuredContent plus the ChatGPT Apps widget template. Use it whenever the user asks to show, present, verify, or render a stay offer or widget after a property search result contains a host domain. This is read-only: it must not lock a quote, create a booking, start checkout, ask for payment confirmation, or collect guest contact details. If the guest wants to book, route only to the signed direct host-domain booking URL from the verified offer. Do not present discounts, savings, OTA comparisons, or invented availability in guest-facing copy.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Canonical public host-owned vacation-rental domain returned by search or verify_vacation_rental_node, e.g. villaakerlyckan.se. Provide only the domain, not a URL or path.",
        },
        check_in: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Requested arrival date in YYYY-MM-DD format, e.g. 2026-11-14. Must be before check_out.",
        },
        check_out: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Requested departure date in YYYY-MM-DD format, e.g. 2026-11-15. Must be after check_in.",
        },
        guests: {
          type: "integer",
          minimum: 1,
          description: "Total guest count for the stay as an integer >= 1. The host node uses this for capacity checks and guest-based pricing.",
        },
        language: {
          type: "string",
          description: "Optional BCP-47/RFC 5646 language hint for labels and formatting, e.g. en, sv, de, or sv-SE.",
        },
      },
      required: ["domain", "check_in", "check_out", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Echoed host domain that issued the signed offer." },
        check_in: { type: "string", description: "Echoed requested arrival date." },
        check_out: { type: "string", description: "Echoed requested departure date." },
        guests: { type: "integer", description: "Echoed requested guest count." },
        verified: { type: "boolean", description: "True only when the host-domain offer signature and payload checks pass." },
        signature: { type: "object", description: "Ed25519/JWS verification details, including key id and verification status.", additionalProperties: true },
        payload_matches_offer: { type: "boolean", description: "True when the signed payload matches the structured offer returned to the agent." },
        fresh: { type: "boolean", description: "True when the signed offer is still within its validity/freshness window." },
        agent_citation: {
          type: "object",
          description: "Citation permission and safe-to-quote status derived from the signed offer.",
          additionalProperties: true,
        },
        official_offer_summary: {
          type: "object",
          description: "Small signed-offer summary for agents to quote without inventing price, availability, discounts, savings, comparisons, or booking details.",
          additionalProperties: true,
        },
        widget_media: {
          type: "object",
          description: "Images and media hydrated from the verified host discovery document for the ChatGPT widget.",
          additionalProperties: true,
        },
        agent_guardrails: {
          type: "object",
          description: "Rules the agent must follow when presenting or acting on this offer.",
          additionalProperties: true,
        },
        error: { type: "string" },
      },
      required: ["domain", "verified"],
      additionalProperties: true,
    },
    annotations: {
      title: "Get Verified Stay Offer",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: {
      ...HEMMABO_WIDGET_TOOL_META,
    },
  },
];

export const TOOL_SPECS: readonly ToolSpecType[] = [
  ...HEMMABO_TOOL_SPECS,
  ...VRP_TOOL_SPECS,
];

export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);
