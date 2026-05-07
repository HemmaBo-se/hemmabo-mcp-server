import type { VercelRequest, VercelResponse } from "./_types.js";

/**
 * /.well-known/mcp.json — MCP discovery manifest
 *
 * AI agents and crawlers (Anthropic, OpenAI, Glama, Smithery) read this
 * to discover the server's endpoint, capabilities, and tools.
 * Spec: https://spec.modelcontextprotocol.io/specification/
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    schema_version: "1.1",
    protocol: "mcp",
    protocol_version: "2025-03-26",
    name: "HemmaBo Federation MCP Server",
    description:
      "Direct booking infrastructure for vacation rentals. Search properties, check availability, get live pricing, and complete Stripe payments — 0% commission. Each property is its own node with live data. Like Mirai for hotels, but for vacation rentals.",
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
    tools: [
      {
        name: "search.properties",
        description:
          "Search available vacation rental properties by region, country, guest count and dates. Returns live availability and pricing.",
      },
      {
        name: "search.availability",
        description:
          "Check whether a specific property is available for given check-in and check-out dates.",
      },
      {
        name: "booking.quote",
        description:
          "Get a detailed live pricing quote: nightly rates, seasonal pricing, federation discount.",
      },
      {
        name: "booking.negotiate",
        description:
          "Lock a price quote for 15 minutes. Returns a quoteId to use in checkout — guarantees the price won't change.",
      },
      {
        name: "booking.checkout",
        description:
          "Create a booking and Stripe payment. Returns a checkout URL (checkout_session) or client_secret (payment_intent) for AI agent payment flows.",
      },
      {
        name: "booking.create",
        description:
          "Create a direct booking without online payment — for invoice or manual payment flows.",
      },
      {
        name: "booking.status",
        description:
          "Get current booking status, dates, price, cancellation policy and refund rules.",
      },
      {
        name: "booking.cancel",
        description:
          "Cancel a booking and trigger a Stripe refund according to the host's cancellation policy.",
      },
      {
        name: "booking.reschedule",
        description:
          "Move a confirmed booking to new dates with automatic repricing.",
      },
      {
        name: "search.similar",
        description:
          "Find vacation rental properties similar to a given property on specific dates — same region, type, and capacity. Returns available alternatives with live pricing.",
      },
      {
        name: "search.compare",
        description:
          "Compare availability and pricing for 2–10 specific properties on the same dates. Returns results sorted by federation price, unavailable properties last.",
      },
    ],
  });
}
