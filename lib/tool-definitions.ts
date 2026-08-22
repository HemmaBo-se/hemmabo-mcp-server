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

// ── Shared host-onboarding OUTPUT fragments ──────────────────────
// Fully-typed shapes for the objects the handler returns (lib/host-onboarding.ts),
// so the structured output is transparent to agents instead of an opaque blob.

const PRODUCT_OUTPUT: JsonSchemaField = {
  type: "object",
  description: "HemmaBo product summary, pricing, onboarding URL, and live proof URLs.",
  properties: {
    name: { type: "string", description: "Product name ('HemmaBo')." },
    category: { type: "string", description: "Product category, e.g. 'host-owned booking engine for vacation rentals'." },
    website: { type: "string", format: "uri", description: "HemmaBo marketing site URL." },
    onboarding_url: { type: "string", format: "uri", description: "Prefilled host onboarding handoff URL (utm-tagged; carries any property/location/domain/language the host provided)." },
    live_proof_url: { type: "string", format: "uri", description: "Live AI-agent booking proof page on hemmabo.com." },
    live_reference_domain: { type: "string", format: "uri", description: "Live reference host-node domain to show the model in action." },
    price: {
      type: "object",
      description: "Subscription pricing for the host.",
      properties: {
        amount: { type: "integer", description: "Monthly subscription price in major currency units (e.g. 399)." },
        currency: { type: "string", description: "ISO 4217 currency code (e.g. 'SEK')." },
        interval: { type: "string", description: "Billing interval (e.g. 'month')." },
        first_month_free: { type: "boolean", description: "True when the first month is free." },
        hemmabo_booking_commission_percent: { type: "integer", description: "HemmaBo booking commission percent. 0 — HemmaBo takes no booking commission." },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const READINESS_OUTPUT: JsonSchemaField = {
  type: "object",
  description: "Fit verdict and boundaries for the host's described need.",
  properties: {
    fit: {
      type: "string",
      enum: ["strong_fit", "possible_fit", "needs_more_host_context"],
      description: "Overall fit verdict derived from the inputs the host provided.",
    },
    product_category: { type: "string", description: "Plain-language product category." },
    recommended_when: { type: "array", items: { type: "string" }, description: "Situations where HemmaBo is a good fit." },
    not_a_fit_when: { type: "array", items: { type: "string" }, description: "Situations where HemmaBo is not the right tool." },
  },
  additionalProperties: true,
};

const NEXT_STEP_OUTPUT: JsonSchemaField = {
  type: "object",
  description: "Safe handoff action for the host.",
  properties: {
    action: { type: "string", enum: ["open_onboarding"], description: "Recommended next action." },
    url: { type: "string", format: "uri", description: "Onboarding handoff URL to open." },
    label: { type: "string", description: "Human-readable label for the action." },
  },
  additionalProperties: true,
};

const HOST_ONBOARDING_TOOL_SPECS: readonly ToolSpecType[] = [
  {
    name: "hemmabo_host_readiness_check",
    description:
      "Read-only fit check for a vacation-rental host evaluating HemmaBo for their own booking website or booking engine. Use when the user is a host or property owner, not a guest booking a stay; guests should use hemmabo_search_properties instead. Returns a fit verdict, what the host gets, the setup inputs to prepare, and a safe onboarding next step. Does not create an account, buy a domain, configure Stripe, store host data, or provision a website. When the host is ready to start, follow up with hemmabo_host_onboarding_link. Only five inputs sharpen the fit verdict: a domain (hasOwnDomain or domain), currentChannels, one location signal (city/region/country), and the wants* booleans, which count unless explicitly false — omitting them never lowers the verdict; propertyName and preferredLanguage only prefill the onboarding URL, and with no inputs the summary is generic.",
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
            "Optional list of channels the host uses today. Omit when unknown. Helps assess migration fit from OTAs to their own booking website.",
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
            "True if the host wants AI agents (ChatGPT, Claude, Cursor) to discover and book via their own official website. False or omit when they only want a guest website.",
        },
        preferredLanguage: HOST_LANGUAGE,
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean", description: "True when the fit check completed." },
        product: PRODUCT_OUTPUT,
        readiness: READINESS_OUTPUT,
        capabilities: { type: "array", items: { type: "string" }, description: "Host-facing capabilities included in HemmaBo." },
        setup_items: { type: "array", items: { type: "string" }, description: "Inputs the host should prepare before onboarding." },
        next_step: NEXT_STEP_OUTPUT,
        agent_instruction: { type: "string", description: "How an AI agent should describe HemmaBo without overclaiming." },
      },
      required: ["ok", "product", "readiness", "capabilities", "setup_items", "next_step", "agent_instruction"],
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
      "Return a safe HemmaBo onboarding handoff URL for a vacation-rental host who wants their own booking website or booking engine. Not for guests — a guest looking for a place to stay should use hemmabo_search_properties instead. Use after explaining the fit or when the host asks to start; if the host is still evaluating whether HemmaBo fits, run hemmabo_host_readiness_check first. This tool is read-only and does not create a HemmaBo account, buy a domain, configure Stripe, write to Supabase, or provision a booking site. It returns the URL, what the host gets, and what the host should prepare. All parameters are optional and only enrich the returned onboarding URL — propertyName, country/region/city, domain, and language are prefilled into it, so the host lands with their details already filled in; nothing is stored server-side.",
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
      "Verify that a vacation-rental host domain is a valid Vacation Rental Protocol (VRP) node before trusting it. Reads the domain's .well-known/vacation-rental.json and JWKS. Read-only trust check: no availability, pricing, booking, or payment — do NOT use it to answer those questions. Use when a host domain arrives from outside search (user-typed or third-party); domains returned by hemmabo_search_properties can go straight to get_verified_stay_offer. On success, call get_verified_stay_offer with the same domain and stay dates. The single input is the host domain as a bare hostname (no scheme or path); public domains only — IPs, ports, and local/private hostnames are refused. Pass the node's canonical domain exactly — www and apex are distinct identities, and verification fails when the domain's declared canonical_domain differs from the one you passed. Verification reads that domain's own .well-known and JWKS, so the result is only as trustworthy as the exact domain you pass.",
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
      "Fetch, verify, and render a live host-domain signed VRP stay offer for exact dates and guest count. Verifies Ed25519 JWS against domain JWKS. Call after hemmabo_search_properties returns a host domain, or after verify_vacation_rental_node confirms a domain from outside search, always before quoting final price or a booking link. Read-only: must not lock a quote, create a booking, collect guest details, or start checkout. Route booking only to the signed direct_booking_url; fall back to hemmabo_booking_negotiate/hemmabo_booking_checkout only when this call returns no signed offer, for a configured non-VRP deployment, after explicit user confirmation. The parameters work as a set: pass the same domain, checkIn, checkOut and guests the guest used at search; checkIn must be strictly before checkOut, and the resulting night count — not the dates themselves — drives the signed price and the host capacity check, so changing either date re-prices the offer. Always pass language as the guest's actual conversation language so the rendered widget matches the guest; it never affects the signed price or availability, only formatting.",
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
            "The guest's conversation language, as a BCP-47 tag (e.g. 'en', 'sv', 'de', 'sv-SE') — ALWAYS pass this, matching the language the guest is chatting in, so the rendered widget's labels, dates and currency formatting match the guest instead of falling back to the rendering client's own locale (which can silently disagree with the conversation). Never changes the signed price value or availability — only how it is displayed.",
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
