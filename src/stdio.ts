/**
 * MCP Server — stdio transport (for Glama, Smithery, and local MCP clients)
 *
 * Same tools as index.ts but over stdin/stdout instead of HTTP.
 * Used by mcp-proxy in Glama's Docker build.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolveQuote } from "./pricing.js";
import { checkAvailability } from "./availability.js";

// ── Environment ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: SupabaseClient | null = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠ Running without database — tools will return errors until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ── MCP Server ─────────────────────────────────────────────────────

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

// ── Start stdio transport ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
