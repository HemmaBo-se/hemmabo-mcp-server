/**
 * Federation MCP Server — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All pricing/availability logic lives in lib/ — single source of truth.
 * This file only handles JSON-RPC transport + tool dispatch.
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call, prompts/list, prompts/get)
 *   GET  /mcp  — transport info
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { resolveQuote } from "../lib/pricing.js";
import { checkAvailability } from "../lib/availability.js";

// ── Server-level instructions for AI agents ──────────────────────
const SERVER_INSTRUCTIONS = `This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.

Workflow: (1) search_properties to find available rentals, (2) get_canonical_quote for detailed pricing, (3) create_booking to finalize. Use check_availability for date-specific checks.

Pricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;

// ── Config schema (all fields optional — Smithery "Optional config" requirement) ──
const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    region: {
      type: "string",
      description: "Default region to search in (e.g. 'Skåne', 'Toscana'). Can be overridden per request.",
    },
    currency: {
      type: "string",
      description: "Preferred display currency (e.g. 'SEK', 'EUR'). Defaults to the property's native currency.",
    },
    language: {
      type: "string",
      description: "Preferred response language (e.g. 'sv', 'en', 'de', 'it'). Defaults to English.",
    },
  },
  additionalProperties: false,
};

// ── Tools ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_properties",
    description:
      "Search vacation rental properties by location and travel dates. Returns only properties that are available for the requested period and can accommodate the guest count. Each result includes live pricing with both public rates (what OTA/website visitors see) and federation rates (direct booking discount). Use region or country to filter by location. Guests parameter determines which price tier applies. Results are sorted by relevance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string", description: "Region, area, or destination name to search within. Supports partial matching (e.g. 'Skåne', 'Toscana', 'Bavaria')." },
        country: { type: "string", description: "Country name to filter by (e.g. 'Sweden', 'Italy', 'Germany'). Supports partial matching." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests. Determines which price tier is used and filters out properties that are too small." },
        checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
        checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
      },
      required: ["guests", "checkIn", "checkOut"],
    },
    annotations: {
      title: "Search Properties",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "check_availability",
    description:
      "Check whether a specific property is available for the requested date range. Verifies against three sources: host-blocked dates, confirmed bookings, and active booking locks (temporary holds during checkout). Returns available=true/false with conflict details if unavailable. Call this before create_booking to confirm availability, or use it to check multiple date ranges for the same property.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to check." },
        checkIn: { type: "string", description: "Desired check-in date in ISO 8601 format (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Desired check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
      },
      required: ["propertyId", "checkIn", "checkOut"],
    },
    annotations: {
      title: "Check Availability",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_canonical_quote",
    description:
      "Get a detailed pricing quote for a specific property, date range, and guest count. Returns three price points: (1) publicTotal — the rate shown on public websites, (2) federationTotal — the direct booking rate with the host's configured discount applied, (3) gapTotal — an additional discount if the dates fill a gap between existing bookings. Also returns per-night breakdown, season classification, weekend detection, and any package pricing (7-night week or 14-night two-week discounts). All prices are integers in the property's local currency. The host controls all discount percentages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to quote." },
        checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests. Determines which price tier is applied (staircase pricing by guest count)." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
    },
    annotations: {
      title: "Get Pricing Quote",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "create_booking",
    description:
      "Create a new direct booking for a property. This is a write operation that: (1) validates the property is still available for the requested dates, (2) calculates the final federation price (with gap discount if applicable), (3) creates a pending booking record that requires host approval. Returns the booking ID, final price, and confirmation details. The booking status starts as 'pending' until the host approves. Guest contact details are required for the host to follow up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to book." },
        checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests staying." },
        guestName: { type: "string", description: "Full legal name of the primary guest making the booking." },
        guestEmail: { type: "string", format: "email", description: "Email address of the primary guest. Used for booking confirmation and host communication." },
        guestPhone: { type: "string", description: "Phone number of the primary guest (optional). Useful for check-in coordination." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
    },
    annotations: {
      title: "Create Booking",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

// ── Prompts ──────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: "plan_trip",
    description: "Help plan a vacation rental trip. Guides the agent through searching properties, comparing prices for different dates, and creating a booking. Provide destination, dates, and guest count to get started.",
    arguments: [
      {
        name: "destination",
        description: "Where the guest wants to travel (region, city, or country). Example: 'Skåne', 'Sweden', 'Toscana'.",
        required: true,
      },
      {
        name: "checkIn",
        description: "Desired check-in date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "checkOut",
        description: "Desired check-out date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "guests",
        description: "Number of guests (integer, minimum 1).",
        required: true,
      },
    ],
  },
];

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === "plan_trip") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please search for available properties, show me pricing options with both public and direct booking rates, and help me book the best match.`,
          },
        },
      ],
    };
  }
  return null;
}

// ── Tool execution ───────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[] }> {
  const supabase = getSupabase();

  switch (name) {
    case "search_properties": {
      const { region, country, guests, checkIn, checkOut } = args as {
        region?: string; country?: string; guests: number; checkIn: string; checkOut: string;
      };

      let query = supabase
        .from("properties")
        .select("id, name, domain, region, city, country, max_guests, currency, property_type, direct_booking_discount, cleaning_fee")
        .eq("published", true)
        .gte("max_guests", guests);

      if (region) query = query.ilike("region", `%${region}%`);
      if (country) query = query.ilike("country", `%${country}%`);

      const { data: properties, error } = await query;
      if (error) return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };

      const results = [];
      for (const prop of properties ?? []) {
        const avail = await checkAvailability(supabase, prop.id, checkIn, checkOut);
        if (!avail.available) continue;
        const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, guests);
        if ("error" in quote) continue;
        results.push({
          propertyId: prop.id, name: prop.name, domain: prop.domain,
          region: prop.region, city: prop.city, country: prop.country,
          maxGuests: prop.max_guests, propertyType: prop.property_type,
          currency: quote.currency, nights: quote.nights,
          publicTotal: quote.publicTotal, federationTotal: quote.federationTotal,
          federationDiscountPercent: quote.federationDiscountPercent,
          packageApplied: quote.packageApplied, available: true,
        });
      }

      return { content: [{ type: "text", text: JSON.stringify({ checkIn, checkOut, guests, properties: results }, null, 2) }] };
    }

    case "check_availability": {
      const { propertyId, checkIn, checkOut } = args as { propertyId: string; checkIn: string; checkOut: string };
      const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "get_canonical_quote": {
      const { propertyId, checkIn, checkOut, guests } = args as { propertyId: string; checkIn: string; checkOut: string; guests: number };
      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      return { content: [{ type: "text", text: JSON.stringify(quote, null, 2) }] };
    }

    case "create_booking": {
      const { propertyId, checkIn, checkOut, guests, guestName, guestEmail, guestPhone } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
        guestName: string; guestEmail: string; guestPhone?: string;
      };

      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...avail }) }] };

      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }] };

      const totalPrice = quote.gapTotal ?? quote.federationTotal;
      const { data: prop } = await supabase.from("properties").select("name, host_id").eq("id", propertyId).single();

      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .insert({
          property_id: propertyId, host_id: prop?.host_id,
          check_in_date: checkIn, check_out_date: checkOut,
          guests_count: guests, guest_name: guestName,
          guest_email: guestEmail, guest_phone: guestPhone ?? null,
          total_price: totalPrice, currency: quote.currency,
          status: "pending", property_name_at_booking: prop?.name ?? null,
          host_approval_required: true,
        })
        .select("id, status, created_at")
        .single();

      if (bookErr) return { content: [{ type: "text", text: JSON.stringify({ error: bookErr.message }) }] };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            bookingId: booking.id, status: booking.status, propertyId,
            checkIn, checkOut, nights: quote.nights, guests, totalPrice,
            currency: quote.currency,
            priceType: quote.gapTotal ? "gap_night" : (quote.packageApplied ? `package_${quote.packageApplied}` : "federation"),
            packageApplied: quote.packageApplied,
            federationDiscountPercent: quote.federationDiscountPercent,
            gapDiscountPercent: quote.gapDiscountPercent, createdAt: booking.created_at,
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] };
  }
}

// ── JSON-RPC handler ─────────────────────────────────────────────

async function handleJsonRpc(
  msg: { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> }
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "federation-mcp-server", version: "2.2.0" },
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (params as { name: string })?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      try {
        const result = await executeTool(toolName, toolArgs);
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal error";
        return { jsonrpc: "2.0", id, error: { code: -32603, message } };
      }
    }

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "prompts/get": {
      const promptName = (params as { name: string })?.name;
      const promptArgs = (params as { arguments?: Record<string, string> })?.arguments ?? {};
      const result = getPromptMessages(promptName, promptArgs);
      if (!result) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
      }
      return { jsonrpc: "2.0", id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: "2.2.0" });
  if (req.method === "DELETE") return res.status(202).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = [];
      for (const msg of body) {
        const result = await handleJsonRpc(msg);
        if (result !== null) results.push(result);
      }
      if (results.length === 0) return res.status(202).end();
      return res.json(results);
    }

    const result = await handleJsonRpc(body);
    if (result === null) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("MCP handler error:", message);
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
  }
}
