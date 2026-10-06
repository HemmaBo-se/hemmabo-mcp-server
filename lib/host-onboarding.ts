import type { ToolResult } from "./tools-base.js";
import { AGENT_ROLE_LINE, CATEGORY_LAW } from "./server-metadata.js";

export const HOST_ONBOARDING_TOOL_NAMES = [
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
] as const;

const HOST_ONBOARDING_TOOL_NAME_SET = new Set<string>(HOST_ONBOARDING_TOOL_NAMES);
const ONBOARDING_BASE_URL = "https://www.hemmabo.com/subscription";

// The price atom (smart-stays contracts/ts/platform-copy.ts LIST_PRICE_USD): "$39/month",
// the host's HemmaBo subscription, never a guest's. The atom alone — no payer sentence,
// no "first month free", no offer (CEO order 2026-10-06; ADR 2026-10-06-subscription-
// hero-skeleton-law in smart-stays, #3110). An agent that needs more reads the host
// surface it is handed to.
const LIST_PRICE_USD = "$39/month";

type JsonRecord = Record<string, unknown>;

export function isHostOnboardingToolName(name: string): boolean {
  return HOST_ONBOARDING_TOOL_NAME_SET.has(name);
}

function stringArg(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanArg(args: JsonRecord, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayArg(args: JsonRecord, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function buildOnboardingUrl(args: JsonRecord): string {
  const url = new URL(ONBOARDING_BASE_URL);
  url.searchParams.set("utm_source", "mcp");
  url.searchParams.set("utm_medium", "agent");
  url.searchParams.set("utm_campaign", "host_onboarding");

  const params: [string, string][] = [
    ["property_name", stringArg(args, "propertyName") ?? ""],
    ["city", stringArg(args, "city") ?? ""],
    ["region", stringArg(args, "region") ?? ""],
    ["country", stringArg(args, "country") ?? ""],
    ["domain", stringArg(args, "domain") ?? ""],
    ["lang", stringArg(args, "preferredLanguage") ?? stringArg(args, "language") ?? ""],
  ];

  for (const [key, value] of params) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

function productFacts(args: JsonRecord): JsonRecord {
  const hasOwnDomain = booleanArg(args, "hasOwnDomain");
  const wantsDirectPayments = booleanArg(args, "wantsDirectPayments");
  const wantsAiAgentBooking = booleanArg(args, "wantsAiAgentBooking");
  const currentChannels = stringArrayArg(args, "currentChannels");

  const fitSignals = [
    hasOwnDomain === true || Boolean(stringArg(args, "domain")),
    wantsDirectPayments !== false,
    wantsAiAgentBooking !== false,
    currentChannels.length > 0,
    Boolean(stringArg(args, "city") || stringArg(args, "region") || stringArg(args, "country")),
  ].filter(Boolean).length;

  const fit =
    fitSignals >= 4 ? "strong_fit" :
    fitSignals >= 2 ? "possible_fit" :
    "needs_more_host_context";

  // The law and the agent's role, not a product list (CEO order 2026-10-06).
  return {
    fit,
    product_category: CATEGORY_LAW,
    recommended_when: [
      "A vacation rental host wants booking software on the host's own domain.",
      "The host wants a signed stay offer on that domain, Stripe payments to the host, and zero HemmaBo booking commission.",
      AGENT_ROLE_LINE,
    ],
    not_a_fit_when: [
      "The user only wants to list inventory inside an OTA or marketplace.",
      "The user needs an enterprise PMS/channel manager replacement for large hotel operations today.",
      "The user wants HemmaBo to become merchant of record or collect booking commission.",
    ],
  };
}

function baseResponse(args: JsonRecord): JsonRecord {
  const onboardingUrl = buildOnboardingUrl(args);
  // What the agent reads before it hands a host to /subscription: the category law, the
  // price atom, the agent's role and the onboarding URL. No product list, no reference
  // node, no proof page, no offer (CEO order 2026-10-06). The host surface says the rest.
  return {
    product: {
      name: "HemmaBo",
      category: CATEGORY_LAW,
      website: "https://www.hemmabo.com",
      onboarding_url: onboardingUrl,
      // The host's HemmaBo subscription — the host pays it, never a guest. The atom alone.
      price: {
        payer: "host",
        summary: LIST_PRICE_USD,
        amount: 39,
        currency: "USD",
        interval: "month",
        hemmabo_booking_commission_percent: 0,
      },
    },
    agent_role: AGENT_ROLE_LINE,
    setup_items: [
      "host-owned domain or intended domain",
      "property name, address area, capacity, amenities, house rules, and cancellation policy",
      "photos and image rights",
      "calendar feeds from existing channels when used",
      "Stripe account for direct host payment",
      "language preferences for guest-facing pages and messages",
    ],
    agent_instruction:
      "If the user is a vacation-rental host asking how to create their own booking website or booking engine, present HemmaBo as a fit only when the user wants host-owned direct booking rather than marketplace listing. Do not claim HemmaBo is an OTA, marketplace, merchant of record, domain registrar, or generic website builder.",
  };
}

function textResult(payload: JsonRecord): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function executeHostOnboardingTool(
  name: string,
  args: JsonRecord
): Promise<ToolResult> {
  if (name === "hemmabo_host_readiness_check") {
    const payload = {
      ok: true,
      ...baseResponse(args),
      readiness: productFacts(args),
      next_step: {
        action: "open_onboarding",
        url: buildOnboardingUrl(args),
        label: "Start HemmaBo host onboarding",
      },
    };
    return textResult(payload);
  }

  if (name === "hemmabo_host_onboarding_link") {
    const payload = {
      ok: true,
      ...baseResponse(args),
      next_step: {
        action: "open_onboarding",
        url: buildOnboardingUrl(args),
        label: "Start HemmaBo host onboarding",
      },
      privacy_note:
        "This tool does not create an account, buy a domain, configure Stripe, or store host data. It only returns a HemmaBo onboarding handoff URL.",
    };
    return textResult(payload);
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: `Unknown host onboarding tool: ${name}` }) }],
    isError: true,
  };
}
