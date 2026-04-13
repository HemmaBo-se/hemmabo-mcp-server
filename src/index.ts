/**
 * MCP Server — Federation Protocol
 *
 * Infrastructure for independent hosts. Each property is its own node
 * (source of truth). This server reads real data — never mocks, never guesses.
 *
 * Transport: Streamable HTTP (required for Smithery Gateway)
 * Data: Supabase (property, pricing, availability, bookings)
 *
 * Pricing flow:
 *   Google/website visitor → public_total
 *   Vera AI / federation partner (at booking) → federation_total
 *   Gap night (calendar context) → gap_total
 *
 * The host controls the federation discount via direct_booking_discount.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { z } from "zod";
import { resolveQuote } from "./pricing.js";
import { checkAvailability } from "./availability.js";

// ── Environment ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Graceful degradation: allow server to start without DB for validation/testing
let supabase: SupabaseClient | null = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠ Running without database — tools will return errors until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log("✓ Database connected");
}

// ── MCP Server ─────────────────────────────────────────────────────

/**
 * Server instructions (for documentation):
 * 
 * This MCP server provides real-time vacation rental data for independent property hosts.
 * All data is live from the property's own database — never cached, never estimated.
 *
 * Full booking lifecycle: search_properties (find properties) -> negotiate_offer (binding quote with quoteId)
 * -> checkout (Stripe payment) -> get_booking_status (check details) -> reschedule_booking / cancel_booking (modify or cancel).
 *
 * Legacy shortcut: search_properties -> get_canonical_quote -> create_booking (no payment, pending host approval).
 *
 * Pricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6).
 * Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week)
 * are applied automatically. Federation discount (direct booking rate) is host-controlled.
 *
 * Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).
 */
const server = new McpServer({
  name: "federation-mcp-server",
  version: "3.0.0",
});

// ── Tool: search_properties ────────────────────────────────────────

server.tool(
  "search_properties",
  "Search vacation rental properties by location and travel dates. Returns only properties that are available for the requested period and can accommodate the guest count. Each result includes live pricing with both public rates and federation rates (direct booking discount).",
  {
    region: z.string().optional().describe("Region or destination (e.g. 'Skåne', 'Sweden')"),
    country: z.string().optional().describe("Country (e.g. 'Sweden')"),
    guests: z.number().int().min(1).describe("Number of guests"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
  },
  async ({ region, country, guests, checkIn, checkOut }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    let query = supabase
      .from("properties")
      .select("id, name, domain, region, city, country, max_guests, currency, property_type, direct_booking_discount, cleaning_fee")
      .eq("published", true)
      .gte("max_guests", guests);

    if (region) query = query.ilike("region", `%${region}%`);
    if (country) query = query.ilike("country", `%${country}%`);

    const { data: properties, error } = await query;

    if (error) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.message }) }] };
    }

    const results = [];
    for (const prop of properties ?? []) {
      const avail = await checkAvailability(supabase, prop.id, checkIn, checkOut);
      if (!avail.available) continue;

      const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, guests);
      if ("error" in quote) continue;

      results.push({
        propertyId: prop.id,
        name: prop.name,
        domain: prop.domain,
        region: prop.region,
        city: prop.city,
        country: prop.country,
        maxGuests: prop.max_guests,
        propertyType: prop.property_type,
        currency: quote.currency,
        nights: quote.nights,
        publicTotal: quote.publicTotal,
        federationTotal: quote.federationTotal,
        federationDiscountPercent: quote.federationDiscountPercent,
        packageApplied: quote.packageApplied,
        available: true,
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ checkIn, checkOut, guests, properties: results }, null, 2),
        },
      ],
    };
  }
);

// ── Tool: check_availability ───────────────────────────────────────

server.tool(
  "check_availability",
  "Check whether a specific property is available for the requested date range. Verifies against host-blocked dates, confirmed bookings, and active booking locks. Returns available=true/false with conflict details if unavailable.",
  {
    propertyId: z.string().uuid().describe("Property UUID"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
  },
  async ({ propertyId, checkIn, checkOut }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: get_canonical_quote ──────────────────────────────────────

server.tool(
  "get_canonical_quote",
  "Get a detailed pricing quote for a specific property, date range, and guest count. Returns publicTotal (website rate), federationTotal (direct booking rate with host discount), and gapTotal (gap-night discount if applicable). Includes per-night breakdown, season classification, weekend detection, and package pricing (7-night week, 14-night two-week). All prices are integers in local currency.",
  {
    propertyId: z.string().uuid().describe("Property UUID"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
    guests: z.number().int().min(1).describe("Number of guests"),
  },
  async ({ propertyId, checkIn, checkOut, guests }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(quote, null, 2) }],
    };
  }
);

// ── Tool: create_booking ───────────────────────────────────────────

server.tool(
  "create_booking",
  "Create a new direct booking for a property. Write operation: validates availability, calculates the final federation price (with gap discount if applicable), and creates a pending booking record requiring host approval. Returns booking ID, final price, and confirmation details.",
  {
    propertyId: z.string().uuid().describe("Property UUID"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
    guests: z.number().int().min(1).describe("Number of guests"),
    guestName: z.string().describe("Guest full name"),
    guestEmail: z.string().email().describe("Guest email"),
    guestPhone: z.string().optional().describe("Guest phone number"),
  },
  async ({ propertyId, checkIn, checkOut, guests, guestName, guestEmail, guestPhone }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    // 1. Verify availability
    const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
    if (!avail.available) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not available", ...avail }) }],
      };
    }

    // 2. Get quote (federation price)
    const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
    if ("error" in quote) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(quote) }],
      };
    }

    // Use gap price if applicable, otherwise federation price
    const totalPrice = quote.gapTotal ?? quote.federationTotal;

    // 3. Get property name for the booking record
    const { data: prop } = await supabase
      .from("properties")
      .select("name, host_id")
      .eq("id", propertyId)
      .single();

    // 4. Create booking
    const { data: booking, error: bookErr } = await supabase
      .from("bookings")
      .insert({
        property_id: propertyId,
        host_id: prop?.host_id,
        check_in_date: checkIn,
        check_out_date: checkOut,
        guests_count: guests,
        guest_name: guestName,
        guest_email: guestEmail,
        guest_phone: guestPhone ?? null,
        total_price: totalPrice,
        currency: quote.currency,
        status: "pending",
        property_name_at_booking: prop?.name ?? null,
        host_approval_required: true,
      })
      .select("id, status, created_at")
      .single();

    if (bookErr) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: bookErr.message }) }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              bookingId: booking.id,
              status: booking.status,
              propertyId,
              checkIn,
              checkOut,
              nights: quote.nights,
              guests,
              totalPrice,
              currency: quote.currency,
              priceType: quote.gapTotal ? "gap_night" : (quote.packageApplied ? `package_${quote.packageApplied}` : "federation"),
              packageApplied: quote.packageApplied,
              federationDiscountPercent: quote.federationDiscountPercent,
              gapDiscountPercent: quote.gapDiscountPercent,
              createdAt: booking.created_at,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── HTTP Server (Streamable HTTP Transport) ────────────────────────

const app = express();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "3.0.0" });
});

// MCP endpoint
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Static server card for Smithery discovery
app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    serverInfo: {
      name: "federation-mcp-server",
      version: "3.0.0",
    },
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    tools: [
      {
        name: "search_properties",
        description:
          "Search for available properties by region and guest count. Returns real pricing from each property node.",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", description: "Region or destination" },
            country: { type: "string", description: "Country" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
          },
          required: ["guests", "checkIn", "checkOut"],
        },
      },
      {
        name: "check_availability",
        description:
          "Check if a property is available for given dates. Verifies blocked dates, bookings, and locks.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
          },
          required: ["propertyId", "checkIn", "checkOut"],
        },
      },
      {
        name: "get_canonical_quote",
        description:
          "Get canonical pricing: public_total (website), federation_total (direct booking with host discount), gap_total (calendar-context gap). Supports week and two-week package pricing. Host controls the discount.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests"],
        },
      },
      {
        name: "create_booking",
        description:
          "Create a direct booking. Validates availability, calculates federation price, writes to bookings.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
            guestName: { type: "string", description: "Guest full name" },
            guestEmail: { type: "string", format: "email", description: "Guest email" },
            guestPhone: { type: "string", description: "Guest phone (optional)" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
        },
      },
      {
        name: "negotiate_offer",
        description:
          "Create a binding price quote with quoteId. Stores snapshot in property_quote_snapshots. Quote expires after 15 minutes.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests"],
        },
      },
      {
        name: "checkout",
        description:
          "Create a booking with Stripe payment. Supports MPP (payment_intent mode). Optionally locks price via quoteId from negotiate_offer.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
            guestName: { type: "string", description: "Guest full name" },
            guestEmail: { type: "string", format: "email", description: "Guest email" },
            guestPhone: { type: "string", description: "Guest phone (optional)" },
            quoteId: { type: "string", description: "Quote ID from negotiate_offer (optional)" },
            paymentMode: { type: "string", enum: ["checkout_session", "payment_intent"], description: "Payment mode (default: checkout_session)" },
            channel: { type: "string", enum: ["public", "federation"], description: "Pricing channel (default: federation)" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
        },
      },
      {
        name: "cancel_booking",
        description:
          "Cancel a booking. Delegates to Supabase Edge Function for refund calculation, Stripe refund, and notifications.",
        inputSchema: {
          type: "object",
          properties: {
            reservationId: { type: "string", description: "Booking ID (UUID)" },
            reason: { type: "string", description: "Cancellation reason (optional)" },
          },
          required: ["reservationId"],
        },
      },
      {
        name: "get_booking_status",
        description:
          "Get booking details, property info, and cancellation policy by reservation ID.",
        inputSchema: {
          type: "object",
          properties: {
            reservationId: { type: "string", description: "Booking ID (UUID)" },
          },
          required: ["reservationId"],
        },
      },
      {
        name: "reschedule_booking",
        description:
          "Reschedule a booking to new dates. Checks availability, recalculates price, handles Stripe charge/refund for price delta.",
        inputSchema: {
          type: "object",
          properties: {
            reservationId: { type: "string", description: "Booking ID (UUID)" },
            newCheckIn: { type: "string", description: "New check-in date YYYY-MM-DD" },
            newCheckOut: { type: "string", description: "New check-out date YYYY-MM-DD" },
            reason: { type: "string", description: "Rescheduling reason (optional)" },
          },
          required: ["reservationId", "newCheckIn", "newCheckOut"],
        },
      },
    ],
    resources: [],
    prompts: [],
  });
});

app.listen(PORT, () => {
  console.log(`Federation MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Server card:  http://0.0.0.0:${PORT}/.well-known/mcp/server-card.json`);
});
