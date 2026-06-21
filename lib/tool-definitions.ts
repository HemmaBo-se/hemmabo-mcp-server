import { TOOL_SPECS as HEMMABO_TOOL_SPECS, toZodShape } from "./tool-definitions-base.js";
import type { ToolSpec as ToolSpecType, JsonSchemaField } from "./tool-definitions-base.js";
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

const DOMAIN_FIELD = {
  type: "string" as const,
  pattern: DOMAIN_PATTERN,
  description:
    "Host-owned domain without protocol or path (e.g. 'villaakerlyckan.se', 'myvilla.it'). Optional; omit when the host has not chosen a domain yet. Invalid: 'https://...', paths, ports, or booking URLs.",
} satisfies JsonSchemaField;

const HOST_PROPERTY_TYPE = {
  type: "string" as const,
  enum: ["villa", "apartment", "cabin", "cottage", "holiday_home", "bnb", "hotel", "other"],
  description:
    "Property category enum. Optional; omit when unknown. 'villa'/'holiday_home' fit best; 'hotel' may indicate a poor HemmaBo fit for large chains.",
} satisfies JsonSchemaField;

const HOST_COUNTRY = {
  type: "string" as const,
  description:
    "Country where the property operates (e.g. 'Sweden', 'Italy', 'Morocco'). Optional; improves onboarding URL locale and fit assessment.",
} satisfies JsonSchemaField;

const HOST_REGION = {
  type: "string" as const,
  description:
    "Region or area (e.g. 'Skåne', 'Toscana', 'Marrakech-Safi'). Optional; narrows onboarding handoff and proof examples.",
} satisfies JsonSchemaField;

const HOST_CITY = {
  type: "string" as const,
  description:
    "City or municipality (e.g. 'Kävlinge', 'Florence'). Optional; used in onboarding URL prefill when provided.",
} satisfies JsonSchemaField;

const HOST_PROPERTY_NAME = {
  type: "string" as const,
  description:
    "Property or business display name (e.g. 'Villa Åkerlyckan'). Optional; carried into onboarding URL when provided.",
} satisfies JsonSchemaField;

const HOST_LANGUAGE = {
  type: "string" as const,
  description:
    "ISO 639-1 language hint for onboarding copy (e.g. 'sv', 'en', 'de', 'fr'). Optional; omit to default to English.",
} satisfies JsonSchemaField;

const HOST_ONBOARDING_TOOL_SPECS: readonly ToolSpecType[] = [
  {
    name: "hemmabo_host_readiness_check",
    description:
      "Read-only fit check for vacation-rental hosts who ask an AI agent how to create an own-domain booking website or booking engine. Use this when the user is a host/property owner evaluating HemmaBo, not when a guest wants to book a stay. It explains whether HemmaBo is a fit, what the host gets (booking website, guest Wallet, Stripe Connect direct-to-host payments, calendar/iCal sync, Konversa guest chat in 12 languages, reviews, gap-night and extend-stay flows, AI-agent-readable booking data), what setup inputs are needed, and the safe next step. It does not create an account, buy a domain, configure Stripe, write to Supabase, collect host PII, or provision a website.",
    inputSchema: {
      type: "object",
      properties: {
        propertyName: HOST_PROPERTY_NAME,
        propertyType: HOST_PROPERTY_TYPE,
        country: HOST_COUNTRY,
        region: HOST_REGION,
        city: HOST_CITY,
        domain: DOMAIN_FIELD,
        currentChannels: {
          type: "array",
          maxItems: 8,
          items: {
            type: "string",
            description:
              "Single distribution channel name (e.g. 'Airbnb', 'Booking.com', 'Vrbo', 'own website'). Up to 8 entries.",
          },
          description:
            "Optional list of channels the host uses today. Omit when unknown. Helps assess migration fit from OTAs to own-domain booking.",
        },
        hasOwnDomain: {
          type: "boolean",
          description:
            "True if the host already owns a domain or explicitly wants one (e.g. true for 'I have villaakerlyckan.se'). False or omit when still undecided.",
        },
        wantsDirectPayments: {
          type: "boolean",
          description:
            "True if the host wants Stripe Connect payouts direct to their account. False or omit when they expect HemmaBo to be merchant of record (not supported).",
        },
        wantsAiAgentBooking: {
          type: "boolean",
          description:
            "True if the host wants AI agents (ChatGPT, Claude, Cursor) to discover and book via their own domain. False or omit when they only want a guest website.",
        },
        preferredLanguage: HOST_LANGUAGE,
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        product: { type: "object", additionalProperties: true, description: "HemmaBo product, pricing, onboarding URL, and live proof URLs." },
        readiness: { type: "object", additionalProperties: true, description: "Fit summary and boundaries for the host's described need." },
        capabilities: { type: "array", items: { type: "string" }, description: "Host-facing capabilities included in HemmaBo." },
        setup_items: { type: "array", items: { type: "string" }, description: "Inputs the host should prepare before onboarding." },
        next_step: { type: "object", additionalProperties: true, description: "Safe handoff action for the host." },
        agent_instruction: { type: "string", description: "How an AI agent should describe HemmaBo without overclaiming." },
      },
      required: ["ok", "product", "capabilities", "setup_items", "next_step"],
      additionalProperties: true,
    },
    annotations: {
      title: "Host Readiness Check",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_host_onboarding_link",
    description:
      "Return a safe HemmaBo onboarding handoff URL for a vacation-rental host who wants an own-domain booking engine. Use after explaining the fit or when the host asks to start. This tool is read-only and does not create a HemmaBo account, buy a domain, configure Stripe, write to Supabase, or provision a booking site. It returns the URL, what the host gets, and what the host should prepare.",
    inputSchema: {
      type: "object",
      properties: {
        propertyName: HOST_PROPERTY_NAME,
        country: HOST_COUNTRY,
        region: HOST_REGION,
        city: HOST_CITY,
        domain: DOMAIN_FIELD,
        language: HOST_LANGUAGE,
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        product: { type: "object", additionalProperties: true, description: "HemmaBo product, pricing, onboarding URL, and live proof URLs." },
        capabilities: { type: "array", items: { type: "string" }, description: "Host-facing capabilities included in HemmaBo." },
        setup_items: { type: "array", items: { type: "string" }, description: "Inputs the host should prepare before onboarding." },
        next_step: { type: "object", additionalProperties: true, description: "Safe handoff action for the host." },
        privacy_note: { type: "string", description: "Clarifies that the call is read-only and does not store host data." },
      },
      required: ["ok", "product", "capabilities", "setup_items", "next_step"],
      additionalProperties: true,
    },
    annotations: {
      title: "Host Onboarding Link",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const VRP_TOOL_SPECS: readonly ToolSpecType[] = [
  {
    name: "verify_vacation_rental_node",
    description:
      "Verify that a vacation-rental host domain is a valid Vacation Rental Protocol (VRP) node before trusting it. Reads the domain's .well-known/vacation-rental.json and JWKS. Read-only trust check: no availability, pricing, booking, or payment. On success, call get_verified_stay_offer with the same domain and stay dates.",
    inputSchema: {
      type: "object",
      properties: {
        domain: DOMAIN_FIELD,
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
      "Fetch, verify, and render a live host-domain signed VRP stay offer for exact dates and guest count. Verifies Ed25519 JWS against domain JWKS. Call after search returns a host domain, always before quoting final price or a booking link. Read-only: must not lock a quote, create a booking, collect guest details, or start checkout. Route booking only to the signed direct_booking_url on the host domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: DOMAIN_FIELD,
        checkIn: {
          type: "string",
          pattern: DATE_PATTERN,
          description:
            "Requested arrival date in YYYY-MM-DD format (e.g. '2026-11-14'). Must be strictly before checkOut. Use the same dates the guest requested in search.",
        },
        checkOut: {
          type: "string",
          pattern: DATE_PATTERN,
          description:
            "Requested departure date in YYYY-MM-DD format (e.g. '2026-11-17'). Must be strictly after checkIn. Guest does not stay the departure night.",
        },
        guests: {
          type: "integer",
          minimum: 1,
          description:
            "Total guest count as positive integer (e.g. 2, 4). Used by the host node for capacity validation and guest-tier pricing on the signed offer.",
        },
        language: {
          type: "string",
          description:
            "Optional BCP-47 language tag for labels and formatting (e.g. 'en', 'sv', 'de', 'sv-SE'). Omit to use host default; does not change price or availability.",
        },
      },
      required: ["domain", "checkIn", "checkOut", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Echoed host domain that issued the signed offer." },
        checkIn: { type: "string", description: "Echoed requested arrival date." },
        checkOut: { type: "string", description: "Echoed requested departure date." },
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
  ...HOST_ONBOARDING_TOOL_SPECS,
  ...VRP_TOOL_SPECS,
];

export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);
