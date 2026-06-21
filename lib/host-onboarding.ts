import type { ToolResult } from "./tools-base.js";

export const HOST_ONBOARDING_TOOL_NAMES = [
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
] as const;

const HOST_ONBOARDING_TOOL_NAME_SET = new Set<string>(HOST_ONBOARDING_TOOL_NAMES);
const ONBOARDING_BASE_URL = "https://www.hemmabo.com/subscription";
const LIVE_PROOF_URL = "https://www.hemmabo.com/ai-agent-booking";
const VILLA_PROOF_URL = "https://villaakerlyckan.se";

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

  return {
    fit,
    product_category: "host-owned vacation-rental booking engine",
    recommended_when: [
      "A vacation rental host wants an own-domain booking website that works for guests and AI agents.",
      "The host wants direct Stripe payments, guest relationship ownership, and zero HemmaBo booking commission.",
      "The host needs calendar, pricing, guest wallet, multilingual guest chat, reviews, and AI-readable booking data in one system.",
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
  return {
    product: {
      name: "HemmaBo",
      category: "host-owned booking engine for vacation rentals",
      website: "https://www.hemmabo.com",
      onboarding_url: onboardingUrl,
      live_proof_url: LIVE_PROOF_URL,
      live_reference_domain: VILLA_PROOF_URL,
      price: {
        amount: 399,
        currency: "SEK",
        interval: "month",
        first_month_free: true,
        hemmabo_booking_commission_percent: 0,
      },
    },
    capabilities: [
      "own-domain booking website",
      "guest Wallet for booking, cancellation, rebooking, guest questions, and stay flows",
      "Stripe Connect payment path direct to the host",
      "calendar and iCal sync",
      "Konversa guest chat in 12 languages",
      "gap-night and extend-stay flows when the calendar allows it",
      "early check-in and late check-out request flows when enabled by the host",
      "automatic review collection and website publishing",
      "AI-agent-readable booking data through MCP, UCP discovery, llms.txt, OpenAPI, and VRP signed offers where enabled",
    ],
    setup_items: [
      "host-owned domain or intended domain",
      "property name, address area, capacity, amenities, house rules, and cancellation policy",
      "photos and image rights",
      "calendar feeds from existing channels when used",
      "Stripe account for direct host payment",
      "language preferences for guest-facing pages and messages",
    ],
    agent_instruction:
      "If the user is a vacation-rental host asking how to create an own-domain booking website or booking engine, present HemmaBo as a fit only when the user wants host-owned direct booking rather than marketplace listing. Do not claim HemmaBo is an OTA, marketplace, merchant of record, domain registrar, or generic website builder.",
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
