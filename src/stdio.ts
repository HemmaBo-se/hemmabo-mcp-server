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

// ── Tool: negotiate_offer ──────────────────────────────────────────

server.tool(
  "negotiate_offer",
  "Create a binding price quote with quoteId. Stores an immutable snapshot in property_quote_snapshots table that expires after 15 minutes. Pass the quoteId to checkout tool to lock the price. This protects both guest and host from price changes during checkout flow.",
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
    if ("error" in quote) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(quote) }],
      };
    }

    // Fetch property domain for snapshot
    const { data: prop } = await supabase.from("properties").select("domain").eq("id", propertyId).single();

    const validUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { data: snapshot, error: snapErr } = await supabase
      .from("property_quote_snapshots")
      .insert({
        property_id: propertyId,
        domain: prop?.domain ?? null,
        stay_start: checkIn,
        stay_end: checkOut,
        nights: quote.nights,
        requested_guests: guests,
        currency: quote.currency,
        source_version: "3.0.0",
        valid_until: validUntil,
        public_total: quote.publicTotal,
        ai_total: quote.federationTotal,
        ai_discount_pct: quote.federationDiscountPercent,
        segments_detail: quote.breakdown.nightlyRates.map((n: any) => ({
          date: n.date,
          rate: n.rate,
          season: n.season,
          dayType: n.dayType,
        })),
        status: "ok",
      })
      .select("id")
      .single();

    if (snapErr) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: snapErr.message }) }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              propertyId,
              checkIn,
              checkOut,
              guests,
              nights: quote.nights,
              currency: quote.currency,
              publicTotal: quote.publicTotal,
              federationTotal: quote.federationTotal,
              federationDiscountPercent: quote.federationDiscountPercent,
              breakdown: quote.breakdown,
              packageApplied: quote.packageApplied,
              gapNight: quote.gapNight,
              gapTotal: quote.gapTotal,
              gapDiscountPercent: quote.gapDiscountPercent,
              quoteId: snapshot.id,
              validUntil,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: checkout ─────────────────────────────────────────────────

server.tool(
  "checkout",
  "Create a booking with Stripe payment. Creates a Stripe Checkout Session (or PaymentIntent for MPP mode) and a booking record. If a quoteId from negotiate_offer is provided, the price is locked to that quote. Supports payment_intent mode for programmatic payment (Machine Payments Protocol). Returns reservationId, paymentUrl, and MPP payment details.",
  {
    propertyId: z.string().uuid().describe("Property UUID"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
    guests: z.number().int().min(1).describe("Number of guests"),
    guestName: z.string().describe("Guest full name"),
    guestEmail: z.string().email().describe("Guest email"),
    guestPhone: z.string().optional().describe("Guest phone number"),
    quoteId: z.string().optional().describe("Quote ID from negotiate_offer (locks price)"),
    paymentMode: z.enum(["checkout_session", "payment_intent"]).optional().describe("Payment mode (default: checkout_session)"),
    channel: z.enum(["public", "federation"]).optional().describe("Pricing channel (default: federation)"),
  },
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "checkout tool requires Stripe configuration - not available in stdio mode. Use HTTP endpoint /mcp or api/mcp.ts instead.",
          }),
        },
      ],
    };
  }
);

// ── Tool: cancel_booking ───────────────────────────────────────────

server.tool(
  "cancel_booking",
  "Cancel a booking. Handles refund calculation based on cancellation policy, processes Stripe refund, updates booking status, and sends email notifications via Supabase Edge Function. Returns updated booking status and refund details.",
  {
    reservationId: z.string().describe("Booking ID (UUID)"),
    reason: z.string().optional().describe("Cancellation reason (optional)"),
  },
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "cancel_booking requires Stripe and Supabase Edge Function - not available in stdio mode. Use HTTP endpoint /mcp or api/mcp.ts instead.",
          }),
        },
      ],
    };
  }
);

// ── Tool: get_booking_status ───────────────────────────────────────

server.tool(
  "get_booking_status",
  "Get booking details, property information, and cancellation policy by reservation ID. Returns full booking info including guest details, property info, pricing, dates, and applicable refund rules. Read-only operation.",
  {
    reservationId: z.string().describe("Booking ID (UUID)"),
  },
  async ({ reservationId }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    // Fetch booking
    const { data: booking, error: bookErr } = await supabase
      .from("bookings")
      .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, guest_name, guest_email, created_at, updated_at")
      .eq("id", reservationId)
      .single();

    if (bookErr || !booking) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Booking not found" }) }],
      };
    }

    // Fetch property
    const { data: prop } = await supabase
      .from("properties")
      .select("name, domain")
      .eq("id", booking.property_id)
      .single();

    // Fetch cancellation policy
    const { data: policy } = await supabase
      .from("host_policies")
      .select("cancellation_tier, refund_rules")
      .eq("property_id", booking.property_id)
      .single();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              reservationId: booking.id,
              status: booking.status,
              propertyId: booking.property_id,
              propertyName: prop?.name ?? null,
              propertyDomain: prop?.domain ?? null,
              checkIn: booking.check_in_date,
              checkOut: booking.check_out_date,
              guests: booking.guests_count,
              totalPrice: booking.total_price,
              currency: booking.currency,
              guestName: booking.guest_name,
              guestEmail: booking.guest_email,
              cancellationPolicy: policy
                ? {
                    tier: policy.cancellation_tier,
                    refundRules: policy.refund_rules,
                  }
                : null,
              createdAt: booking.created_at,
              updatedAt: booking.updated_at,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: reschedule_booking ───────────────────────────────────────

server.tool(
  "reschedule_booking",
  "Reschedule a booking to new dates. Checks availability for new dates, recalculates price, handles Stripe charge (if price increased) or refund (if decreased) for the price delta. Updates booking record with new dates and price. Returns updated booking info and Stripe transaction details.",
  {
    reservationId: z.string().describe("Booking ID (UUID)"),
    newCheckIn: z.string().describe("New check-in date YYYY-MM-DD"),
    newCheckOut: z.string().describe("New check-out date YYYY-MM-DD"),
    reason: z.string().optional().describe("Rescheduling reason (optional)"),
  },
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "reschedule_booking requires Stripe configuration - not available in stdio mode. Use HTTP endpoint /mcp or api/mcp.ts instead.",
          }),
        },
      ],
    };
  }
);

// ── Start stdio transport ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
