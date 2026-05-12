import type { VercelRequest, VercelResponse } from "./_types.js";
import { createRequire } from "module";
import { ANON_TOOLS } from "./mcp.js";
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
 * stay aligned (covers all 11 tools, no extras).
 */
const MANIFEST_SUMMARIES: Record<string, string> = {
  "hemmabo_search_properties":
    "Search available vacation rental properties by region, country, guest count and dates. Returns live availability and pricing.",
  "hemmabo_search_availability":
    "Check whether a specific property is available for given check-in and check-out dates.",
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
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    schema_version: "1.1",
    protocol: "mcp",
    protocol_version: "2025-03-26",
    name: "HemmaBo Federation MCP Server",
    version: pkg.version,
    description:
      "Direct booking infrastructure for vacation rentals. Each host is a sovereign booking node — own domain, 0% commission, payment direct to host via Stripe. Search properties, get quotes, book without aggregator markup. Like Mirai for hotels, but for vacation rentals. From $39/month.",
    mcp_endpoint: "https://hemmabo-mcp-server.vercel.app/mcp",
    transport: ["streamable-http", "stdio"],
    authentication: {
      type: "oauth2",
      flows: {
        clientCredentials: {
          tokenUrl: "https://hemmabo-mcp-server.vercel.app/oauth/token",
          scopes: {
            mcp: "Full access to all MCP tools",
          },
        },
      },
      registration: {
        endpoint: "https://hemmabo-mcp-server.vercel.app/oauth/register",
        description:
          "Register an OAuth client to obtain client_id and client_secret. Use POST /oauth/token with grant_type=client_credentials to get an access token.",
      },
    },
    homepage: "https://hemmabo.com",
    icon: "https://hemmabo-mcp-server.vercel.app/icon.png",
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
        "Search parameters (region, dates, guest count) — not linked to a user identity",
      ],
      data_sharing:
        "HemmaBo never stores guest payment details. Each booking writes to the host's own Supabase project and Stripe account — not a HemmaBo-owned database.",
      external_redirects:
        "Checkout completes via Stripe-hosted pages or the host's own domain. ChatGPT may bounce out for final confirmation.",
      content_safety: "No user-generated content. Property listings are curated by verified hosts.",
    },
    trust: {
      payment: "Stripe (direct to host)",
      commission: "0%",
      data_ownership: "host",
    },
    sample_prompts: [
      "Find a pet-friendly villa in Sweden for 6 guests in July",
      "Show me direct-booking vacation rentals in Skåne for August 2026",
      "What's the price for Villa Åkerlyckan for 4 guests, 5 nights?",
      "Compare these properties on the same dates and book the cheapest one",
    ],
    registry: {
      glama: "https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server",
      smithery: "https://smithery.ai/servers/@hemmabo-se/hemmabo",
      npm: "https://www.npmjs.com/package/hemmabo-mcp-server",
    },
    tools: TOOL_NAMES.map((toolName) => ({
      name: toolName,
      auth: authForTool(toolName),
      description: MANIFEST_SUMMARIES[toolName],
    })),
  });
}
