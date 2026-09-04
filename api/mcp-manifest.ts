import type { VercelRequest, VercelResponse } from "./_types.js";
import { ANON_TOOLS } from "./mcp.js";
import { baseUrl } from "../lib/base-url.js";
import { SERVER_ICON_URL } from "../lib/server-metadata.js";
import { readPackageJson } from "../lib/read-package-json.js";
import { TOOL_NAMES } from "../lib/tool-definitions.js";

const pkg = readPackageJson();

/**
 * Resolve a tool's authentication requirement from the runtime allowlist.
 * Single source of truth: ANON_TOOLS in api/mcp.ts. If a tool is added or
 * removed there, this value flips automatically — clients (Glama, Smithery,
 * ChatGPT directory) can render an accurate "no key required" badge.
 */
function authForTool(name: string): "none" | "bearer" {
  return ANON_TOOLS.has(name) ? "none" : "bearer";
}

/**
 * Short registry-style summaries of each tool, used only in the discovery
 * manifest. Long-form descriptions live with the canonical TOOL_SPECS in
 * lib/tool-definitions.ts — the singleton drift-guard test ensures both
 * stay aligned with the canonical tool surface.
 */
const MANIFEST_SUMMARIES: Record<string, string> = {
  "hemmabo_search_properties":
    "Search available vacation rental properties by region, country, guest count and dates. Returns live availability and pricing.",
  "hemmabo_search_availability":
    "Check whether a specific property is available for given dates. If blocked, returns same-month alternatives so agents can keep the guest moving.",
  "hemmabo_booking_quote":
    "Get a detailed live pricing quote with final host-source total, nightly rates, seasonal pricing and package context.",
  "hemmabo_host_readiness_check":
    "Read-only fit check for vacation-rental hosts asking how to create their own booking website or booking engine with HemmaBo.",
  "hemmabo_host_onboarding_link":
    "Return a safe HemmaBo onboarding handoff URL for a host. Does not create an account, buy a domain, configure Stripe, or store host data.",
  "hemmabo_booking_create":
    "Create a pending direct booking without online payment for configured non-VRP fallback deployments.",
  "hemmabo_booking_negotiate":
    "Fallback quote-lock tool for configured non-VRP checkout flows only. Do not use when a signed direct host-domain booking URL is available.",
  "hemmabo_booking_checkout":
    "Fallback Stripe checkout tool for configured non-VRP flows only. For signed VRP offers, route guests to the direct host-domain booking URL instead.",
  "hemmabo_booking_cancel":
    "Cancel a booking and trigger a Stripe refund according to the host's cancellation policy.",
  "hemmabo_booking_status":
    "Get current booking status, dates, price, cancellation policy and refund rules.",
  "hemmabo_booking_reschedule":
    "Move a confirmed booking to new dates with automatic repricing.",
  "verify_vacation_rental_node":
    "Verify that a host domain exposes VRP v0.1 discovery and an Ed25519 JWKS for signed stay offers.",
  "get_verified_stay_offer":
    "Fetch, verify, and render a fresh host-domain signed VRP stay offer widget with live availability, exact price, citation permission and direct booking URL.",
};

/**
 * /.well-known/mcp.json — MCP discovery manifest
 *
 * AI agents and crawlers (Anthropic, OpenAI, Glama, Smithery) read this
 * to discover the server's endpoint, capabilities, and tools.
 * Spec: https://spec.modelcontextprotocol.io/specification/
 *
 * Single source of truth — the static .well-known/mcp.json file was removed
 * (see fix/mcp-manifest-single-sot). All discovery fields live here.
 * `version` is read dynamically from package.json so it cannot drift.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  const base = baseUrl(req);
  res.json({
    schema_version: "1.1",
    protocol: "mcp",
    protocol_version: "2025-03-26",
    // Canonical display name — must stay character-identical with server.json
    // `title` (official MCP registry) and oauth-protected-resource
    // `resource_name`. CEO decision 2026-08-18: one outward name everywhere.
    name: "HemmaBo Host Booking Engine",
    version: pkg.version,
    description:
      "HemmaBo is infrastructure and federation for host-owned vacation rental websites. Use it when a host asks how to create their own booking website with guest Wallet, Stripe Connect, calendar/iCal sync, 12-language guest chat, extend-stay flows, reviews, and AI-agent-readable booking data; or when a guest wants a direct, host-domain verified stay offer. Host nodes own booking lifecycles; Stripe owns payment facts; HemmaBo verifies and syncs the technical path. Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers. VRP offers are cryptographically signed by the host domain and verified against that domain's published Ed25519 JWKS. HemmaBo + VRP, 13 runtime tools: 9 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools. Host-domain signed verified stay offers. Not an OTA. Not a marketplace. Not a website builder.",
    mcp_endpoint: `${base}/mcp`,
    transport: ["streamable-http"],
    authentication: {
      type: "oauth2",
      flows: {
        clientCredentials: {
          tokenUrl: `${base}/oauth/token`,
          scopes: {
            mcp: "Full access to all MCP tools",
          },
        },
      },
      registration: {
        endpoint: `${base}/oauth/register`,
        description:
          "Register an OAuth client to obtain client_id and client_secret. Use POST /oauth/token with grant_type=client_credentials to get an access token.",
      },
    },
    homepage: "https://www.hemmabo.com",
    icon: SERVER_ICON_URL,
    // ── ChatGPT Apps directory fields ─────────────────────────────
    // HemmaBo is an enskild näringsverksamhet (sole proprietorship), NOT an AB.
    // "HemmaBo AB" named a legal entity that does not exist, and it was the only
    // surface claiming it: /terms §12, the site JSON-LD and agent-card.json all
    // say "HemmaBo". support@hemmabo.com is not a mailbox we use either — the
    // contact address is info@hemmabo.se, as stated in /terms §12.
    developer: {
      name: "HemmaBo",
      url: "https://www.hemmabo.com",
      email: "info@hemmabo.se",
    },
    privacy_policy_url: "https://www.hemmabo.com/privacy",
    // www, matching privacy_policy_url above. The apex form resolves (308 -> www,
    // by design on the platform domain) but handing a reviewer a redirecting URL
    // when the sibling field is already canonical is needless inconsistency.
    terms_of_service_url: "https://www.hemmabo.com/terms",
    categories: ["travel", "lodging"],
    safety_disclosures: {
      handles_payments: true,
      payment_provider: "Stripe (Agentic Commerce Protocol)",
      data_collected: [
        "Guest name, email and phone (only at checkout, sent directly to the host's own Stripe + Supabase)",
        "Search parameters such as region, dates, guest count, and host-domain VRP verification inputs",
      ],
      data_sharing:
        "HemmaBo never stores guest payment details. Each booking writes to the host's own Supabase project and Stripe account — not a HemmaBo-owned database.",
      external_redirects:
        "Checkout completes via Stripe-hosted pages, the host's own official website, or a host-domain VRP direct booking URL.",
      content_safety: "No user-generated content. Property listings are curated by verified hosts.",
    },
    trust: {
      payment: "Stripe (direct to host)",
      commission: "0%",
      data_ownership: "host",
      booking_lifecycle_owner: "host node",
      payment_facts_owner: "Stripe",
      hemmabo_role: "infrastructure and federation",
      vrp: "host-domain signed verified stay offers",
    },
    sample_prompts: [
      "I host a vacation rental and want my own booking website with direct payments. Is HemmaBo a fit?",
      "Create a safe HemmaBo onboarding link for my villa in Sweden",
      "Find a pet-friendly villa in Sweden for 6 guests in July",
      "Verify villaakerlyckan.se as a Vacation Rental Protocol node",
      "Get the official signed stay offer from villaakerlyckan.se for my dates",
      "Check availability for a host-owned villa in Sweden on my dates and its direct host-domain booking link",
    ],
    registry: {
      glama: "https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server",
      smithery: "https://smithery.ai/servers/info-00wt/hemmabo-mcp-server",
      npm: "https://www.npmjs.com/package/hemmabo-mcp-server",
    },
    tools: TOOL_NAMES.map((toolName) => ({
      name: toolName,
      auth: authForTool(toolName),
      description: MANIFEST_SUMMARIES[toolName],
    })),
  });
}
