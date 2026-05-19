import type { VercelRequest, VercelResponse } from "./_types.js";
import { createRequire } from "module";
import { ANON_TOOLS } from "./mcp.js";
import { baseUrl } from "../lib/base-url.js";
import { TOOL_NAMES } from "../lib/tool-definitions.js";

// Read package.json at module load — single source of truth for `version`.
// createRequire works under Node16 ESM where JSON import attributes are not
// available; the file is bundled by Vercel into the function deployment.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

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
  "hemmabo_search_similar":
    "Find vacation rental properties similar to a given property on specific dates — same region, type, and capacity. Returns available alternatives with live pricing.",
  "hemmabo_compare_properties":
    "Compare availability and pricing for 2–10 specific properties on the same dates. Returns results sorted by federation price, unavailable properties last.",
  "hemmabo_booking_quote":
    "Get a detailed live pricing quote: nightly rates, seasonal pricing, federation discount.",
  "hemmabo_booking_create":
    "Create a direct booking without online payment — for invoice or manual payment flows.",
  "hemmabo_booking_negotiate":
    "Lock a price quote for 15 minutes. Returns a quoteId to use in checkout — guarantees the price won't change.",
  "hemmabo_booking_checkout":
    "Create a booking and Stripe payment. Returns a checkout URL (checkout_session) or client_secret (payment_intent) for AI agent payment flows.",
  "hemmabo_booking_cancel":
    "Cancel a booking and trigger a Stripe refund according to the host's cancellation policy.",
  "hemmabo_booking_status":
    "Get current booking status, dates, price, cancellation policy and refund rules.",
  "hemmabo_booking_reschedule":
    "Move a confirmed booking to new dates with automatic repricing.",
  "verify_vacation_rental_node":
    "Verify that a host domain exposes VRP v0.1 discovery and an Ed25519 JWKS for signed stay offers.",
  "get_verified_stay_offer":
    "Fetch and verify a fresh host-domain signed VRP stay offer with live availability, exact price, citation permission and direct booking URL.",
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
    name: "HemmaBo Federation MCP Server",
    version: pkg.version,
    description:
      "HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer. Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers. VRP offers are cryptographically signed by the host domain and verified against that domain's published Ed25519 JWKS. HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.",
    mcp_endpoint: `${base}/mcp`,
    transport: ["streamable-http", "stdio"],
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
    homepage: "https://hemmabo.com",
    icon: `${base}/icon.png`,
    // ── ChatGPT Apps directory fields ─────────────────────────────
    developer: {
      name: "HemmaBo AB",
      url: "https://hemmabo.com",
      email: "support@hemmabo.com",
    },
    privacy_policy_url: "https://hemmabo.com/privacy",
    terms_of_service_url: "https://hemmabo.com/terms",
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
        "Checkout completes via Stripe-hosted pages, the host's own domain, or a host-domain VRP direct booking URL.",
      content_safety: "No user-generated content. Property listings are curated by verified hosts.",
    },
    trust: {
      payment: "Stripe (direct to host)",
      commission: "0%",
      data_ownership: "host",
      vrp: "host-domain signed verified stay offers",
    },
    sample_prompts: [
      "Find a pet-friendly villa in Sweden for 6 guests in July",
      "Verify villaakerlyckan.se as a Vacation Rental Protocol node",
      "Get the official signed stay offer from villaakerlyckan.se for my dates",
      "Compare these properties on the same dates and book the cheapest one",
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
