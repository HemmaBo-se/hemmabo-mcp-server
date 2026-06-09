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

const HOST_ONBOARDING_TOOL_SPECS: readonly ToolSpecType[] = [
  {
    name: "hemmabo_host_readiness_check",
    description:
      "Read-only fit check for vacation-rental hosts who ask an AI agent how to create an own-domain booking website or booking engine. Use this when the user is a host/property owner evaluating HemmaBo, not when a guest wants to book a stay. It explains whether HemmaBo is a fit, what the host gets (booking website, guest Wallet, Stripe Connect direct-to-host payments, calendar/iCal sync, Konversa guest chat in 11 languages, reviews, gap-night and extend-stay flows, AI-agent-readable booking data), what setup inputs are needed, and the safe next step. It does not create an account, buy a domain, configure Stripe, write to Supabase, collect host PII, or provision a website.",
    inputSchema: {
      type: "object",
      properties: {
        propertyName: { type: "string", description: "Optional property or business name the host gave, e.g. Villa Akerlyckan." },
        propertyType: {
          type: "string",
          enum: ["villa", "apartment", "cabin", "cottage", "holiday_home", "bnb", "hotel", "other"],
          description: "Optional property category. HemmaBo is optimized for vacation-rental hosts and independent properties.",
        },
        country: { type: "string", description: "Optional country where the property is located." },
        region: { type: "string", description: "Optional region or area where the property is located." },
        city: { type: "string", description: "Optional city or municipality where the property is located." },
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Optional existing or intended host-owned domain, without https:// or path.",
        },
        currentChannels: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description: "Optional existing places the host uses today, e.g. Airbnb, Booking.com, Vrbo, manual calendar, own website, PMS.",
        },
        hasOwnDomain: { type: "boolean", description: "Whether the host already has or wants to use an own domain." },
        wantsDirectPayments: { type: "boolean", description: "Whether the host wants Stripe payments direct to the host rather than HemmaBo as merchant of record." },
        wantsAiAgentBooking: { type: "boolean", description: "Whether the host wants AI agents to discover, verify, and route bookings to the host-owned domain." },
        preferredLanguage: { type: "string", description: "Optional language hint for onboarding, e.g. sv, en, de." },
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
        propertyName: { type: "string", description: "Optional property or business name to carry into the onboarding URL." },
        country: { type: "string", description: "Optional country where the property is located." },
        region: { type: "string", description: "Optional region or area where the property is located." },
        city: { type: "string", description: "Optional city or municipality where the property is located." },
        domain: {
          type: "string",
          pattern: DOMAIN_PATTERN,
          description: "Optional existing or intended host-owned domain, without https:// or path.",
        },
        language: { type: "string", description: "Optional language hint for onboarding, e.g. sv, en, de." },
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
      "Verify that a vacation-rental host domain is a valid Vacation Rental Protocol (VRP) node before trusting it. Reads https://{domain}/.well-known/vacation-rental.json, follows the node JWKS, and confirms protocol identity, canonical host-domain control, Ed25519 signing keys, and a verified stay-offer endpoint. This is a read-only trust check only: it does not check availability, calculate pricing, create bookings, lock quotes, collect guest details, or start payment. Run it as a silent trust gate: do not narrate the JWKS, protocol, or signing mechanics to the guest. Once verified, go straight to get_verified_stay_offer with the verified domain plus check-in, check-out, and guest count to fetch live dates, price, booking rules, and the visual stay-offer widget; if the domain is not a verified VRP node, tell the guest plainly that you cannot confirm a direct host-domain offer rather than guessing.",
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
      "Fetch, verify, and render a live host-domain signed VRP stay offer for exact dates and guest count. Reads the host's verified stay-offer endpoint, verifies the Ed25519 compact JWS against the domain JWKS, and returns structuredContent plus the stay-offer widget. Call it after a search result contains a host domain, and ALWAYS before quoting a final price or a booking link, so the answer is backed by a fresh signed offer. Chat response: keep it SHORT and lead with the offer card. When the client renders the widget, the guest already sees the property, dates, exact total, and the direct-booking button above your reply, so do NOT restate those in prose (a 'total 5 780 kr, 18-20 Nov, sleeps 4' recap is redundant noise); write one or two sentences of framing plus the single next action: open the signed direct booking URL on the host's own domain. Surface ONE detail only if it genuinely helps the guest decide (e.g. 'exact match for your dates' or 'the total is locked to the signed price'), never a per-field dump. When the client cannot render the widget, give a one-line text summary (name, total, dates) and the direct booking URL. Read-only: it must not lock a quote, create a booking, start checkout, ask for payment confirmation, or collect guest contact details. The signed direct host-domain booking URL is the only booking and payment path, so route there; do not start a HemmaBo checkout, and do not present discounts, savings, OTA comparisons, or invented availability in guest-facing copy. Quote only what the offer's citation permission allows.",
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
  ...HOST_ONBOARDING_TOOL_SPECS,
  ...VRP_TOOL_SPECS,
];

export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);
