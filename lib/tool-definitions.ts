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
      "Verify a Vacation Rental Protocol host-domain node. Reads https://{domain}/.well-known/vacation-rental.json and the node JWKS, confirms VRP v0.1, canonical host-domain control, Ed25519 signing keys, and the verified stay offer endpoint. Use before trusting a host-domain offer. To show the visual stay-offer widget after verification, call get_verified_stay_offer.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Host-owned vacation rental domain to verify, e.g. villaakerlyckan.se. Do not include a path.",
        },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        verified: { type: "boolean" },
        protocol: { type: "string" },
        protocol_version: { type: "string" },
        discovery_url: { type: "string", format: "uri" },
        jwks_url: { type: "string", format: "uri" },
        verified_stay_offer_url: { type: "string", format: "uri" },
        signing: { type: "object", additionalProperties: true },
        error: { type: "string" },
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
      "Render the HemmaBo verified stay offer widget for a host-domain node. Fetches a signed VRP verified_stay_offer, verifies its Ed25519 compact JWS against the domain's JWKS, and returns structuredContent for the visual widget. Use this whenever the user asks to see, present, show, or book a nodd/stay offer. Never invent discounts or OTA comparisons outside the signed offer.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Host-owned vacation rental domain, e.g. villaakerlyckan.se.",
        },
        check_in: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Arrival date in YYYY-MM-DD format.",
        },
        check_out: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "Departure date in YYYY-MM-DD format. Must be after check_in.",
        },
        guests: {
          type: "integer",
          minimum: 1,
          description: "Total number of guests as integer >= 1.",
        },
        language: {
          type: "string",
          description: "Optional preferred response language, e.g. en or sv.",
        },
      },
      required: ["domain", "check_in", "check_out", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        check_in: { type: "string" },
        check_out: { type: "string" },
        guests: { type: "integer" },
        verified: { type: "boolean" },
        signature: { type: "object", additionalProperties: true },
        payload_matches_offer: { type: "boolean" },
        fresh: { type: "boolean" },
        signed_verified_stay_offer: { type: "string" },
        offer: { type: "object", additionalProperties: true },
        agent_citation: {
          type: "object",
          description: "Citation permission and safe-to-quote status derived from the signed offer.",
          additionalProperties: true,
        },
        official_offer_summary: {
          type: "object",
          description: "Small signed-offer summary for agents to quote without inventing price, discount, availability, or booking details.",
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
