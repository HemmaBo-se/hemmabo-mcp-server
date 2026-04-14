#!/usr/bin/env node
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
import {
  createCheckoutSession,
  retrievePaymentIntent,
  createRefund,
  createPaymentIntent,
} from "./stripe.js";

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

const server = new McpServer(
  {
    name: "hemmabo-mcp-server",
    version: "3.1.7",
    description: "MCP server for vacation rental direct bookings. Search properties, check availability, get real-time pricing quotes, and create bookings through the federation protocol. Supports seasonal pricing, guest-count tiers, weekly and biweekly package discounts, gap-night discounts, and host-controlled federation discounts. All data is live — never cached, never estimated.",
  },
  {
    instructions: "This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.\n\nFull booking lifecycle: hemmabo_search_properties (find properties) -> hemmabo_booking_negotiate (binding quote with quoteId) -> hemmabo_booking_checkout (Stripe payment) -> hemmabo_booking_status (check details) -> hemmabo_booking_reschedule / hemmabo_booking_cancel (modify or cancel).\n\nLegacy shortcut: hemmabo_search_properties -> hemmabo_booking_quote -> hemmabo_booking_create (no payment, pending host approval).\n\nPricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.\n\nDates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).",
  }
);

// ── Tool: hemmabo_search_properties ────────────────────────────────────────

server.tool(
  "hemmabo_search_properties",
  "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use hemmabo_search_availability or hemmabo_booking_quote instead. Returns a list of available properties with propertyId, live pricing, and capacity info needed for subsequent tools.",
  {
    region: z.string().optional().describe("Region, area, or destination name to search within. Partial match (e.g. 'Skåne', 'Toscana'). At least one of region or country should be provided."),
    country: z.string().optional().describe("Country name to filter by (e.g. 'Sweden', 'Italy'). Partial match. At least one of region or country should be provided."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines price tier and filters out properties with insufficient capacity."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
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

// ── Tool: hemmabo_search_availability ───────────────────────────────────────

server.tool(
  "hemmabo_search_availability",
  "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from hemmabo_search_properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use hemmabo_search_properties instead. Returns available=true/false with conflict details (blocked dates, existing bookings, active locks) if unavailable.",
  {
    propertyId: z.string().uuid().describe("Property UUID returned by hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
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

// ── Tool: hemmabo_booking_quote ──────────────────────────────────────

server.tool(
  "hemmabo_booking_quote",
  "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns publicTotal (website rate), federationTotal (direct booking discount), gapTotal (gap-night discount if applicable), per-night breakdown, and package pricing. All prices are integers in the property's local currency (e.g. SEK).",
  {
    propertyId: z.string().uuid().describe("Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied (staircase pricing by guest count)."),
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

// ── Tool: hemmabo_booking_create ───────────────────────────────────────────

server.tool(
  "hemmabo_booking_create",
  "Create a direct booking without online payment (legacy flow). Use this tool when the user wants to book without Stripe payment — the booking is created with status 'pending' and requires host approval. Do NOT use for paid bookings — use hemmabo_booking_checkout instead. Do NOT retry on timeout without calling hemmabo_booking_status first to avoid duplicate bookings. Returns bookingId, final price, and confirmation details.",
  {
    propertyId: z.string().uuid().describe("Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4)."),
    guestName: z.string().describe("Full name of primary guest (e.g. 'Anna Svensson')."),
    guestEmail: z.string().email().describe("Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address."),
    guestPhone: z.string().optional().describe("Phone with country code (e.g. '+46701234567'). Optional but recommended for check-in coordination."),
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

// ── Tool: hemmabo_booking_negotiate ──────────────────────────────────────────

server.tool(
  "hemmabo_booking_negotiate",
  "Create a binding price quote that locks the price for 15 minutes. Use this tool before hemmabo_booking_checkout to guarantee the quoted price during payment. Do NOT skip this step if the user wants price certainty — without a quoteId, checkout calculates a fresh price that may differ. Returns quoteId (pass to hemmabo_booking_checkout), public and federation totals, per-night breakdown, and expiry timestamp.",
  {
    propertyId: z.string().uuid().describe("Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied."),
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

// ── Tool: hemmabo_booking_checkout ─────────────────────────────────────────────────

server.tool(
  "hemmabo_booking_checkout",
  "Create a booking with Stripe payment and return a checkout URL. Use this tool when the user is ready to pay — it creates the booking record and generates a Stripe payment page. Do NOT call twice for the same booking — check hemmabo_booking_status first to avoid double charges. Optionally pass quoteId from hemmabo_booking_negotiate to lock the price. Returns reservationId, paymentUrl (Stripe checkout page), and pricing details.",
  {
    propertyId: z.string().uuid().describe("Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: z.string().describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: z.string().describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4)."),
    guestName: z.string().describe("Full name of primary guest (e.g. 'Anna Svensson')."),
    guestEmail: z.string().email().describe("Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address."),
    guestPhone: z.string().optional().describe("Phone with country code (e.g. '+46701234567'). Optional but recommended."),
    quoteId: z.string().optional().describe("Quote ID from hemmabo_booking_negotiate to lock the price. Optional — if omitted, a fresh federation price is calculated at checkout time."),
    paymentMode: z.enum(["checkout_session", "payment_intent"]).optional().describe("'checkout_session' (default): returns Stripe redirect URL. 'payment_intent': returns client_secret for programmatic payment (AI agent MPP flow)."),
    channel: z.enum(["public", "federation"]).optional().describe("'federation' (default): applies direct booking discount. 'public': uses standard website rate."),
  },
  async ({ propertyId, checkIn, checkOut, guests, guestName, guestEmail, guestPhone, quoteId, paymentMode, channel }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    const effectivePaymentMode = paymentMode ?? "checkout_session";
    const effectiveChannel = channel ?? "federation";

    try {
      // Fetch property
      const { data: prop, error: propErr } = await supabase
        .from("properties")
        .select("name, domain, host_id, currency, direct_booking_discount, cleaning_fee")
        .eq("id", propertyId)
        .single();
      if (propErr || !prop) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Property not found" }) }],
        };
      }

      // Check availability
      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Not available", ...avail }) }],
        };
      }

      let totalPrice: number;
      let currency: string;
      let nights: number;

      if (quoteId) {
        // Use locked quote from hemmabo_booking_negotiate
        const { data: snapshot, error: snapErr } = await supabase
          .from("property_quote_snapshots")
          .select("*")
          .eq("id", quoteId)
          .single();
        if (snapErr || !snapshot) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Quote not found" }) }],
          };
        }
        if (new Date(snapshot.valid_until) < new Date()) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Quote expired", quoteId, validUntil: snapshot.valid_until }) }],
          };
        }
        totalPrice = effectiveChannel === "public" ? snapshot.public_total : snapshot.ai_total;
        currency = snapshot.currency;
        nights = snapshot.nights;
      } else {
        // Calculate fresh price
        const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
        if ("error" in quote) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(quote) }],
          };
        }
        totalPrice = effectiveChannel === "public" ? quote.publicTotal : (quote.gapTotal ?? quote.federationTotal);
        currency = quote.currency;
        nights = quote.nights;
      }

      // Create Stripe Checkout Session
      const session = await createCheckoutSession({
        amount: totalPrice,
        currency,
        propertyName: prop.name,
        checkIn,
        checkOut,
        guests,
        guestEmail,
        propertyId,
        bookingId: "pending",
        domain: prop.domain ?? "",
      });

      // Create booking record
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .insert({
          property_id: propertyId,
          host_id: prop.host_id,
          check_in_date: checkIn,
          check_out_date: checkOut,
          guests_count: guests,
          guest_name: guestName,
          guest_email: guestEmail,
          guest_phone: guestPhone ?? null,
          total_price: totalPrice,
          currency,
          status: "pending",
          property_name_at_booking: prop.name,
          stripe_session_id: session.id,
        })
        .select("id, status, created_at, guest_token")
        .single();

      if (bookErr) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: bookErr.message }) }],
        };
      }

      // Build response
      const result: Record<string, unknown> = {
        reservationId: booking.id,
        status: booking.status,
        paymentUrl: session.url,
        propertyId,
        checkIn,
        checkOut,
        nights,
        guests,
        totalPrice,
        currency,
        payment_modes: ["checkout_session", "payment_intent"],
        createdAt: booking.created_at,
      };

      // MPP enrichment: if payment_intent mode, retrieve client_secret
      if (effectivePaymentMode === "payment_intent" && session.payment_intent) {
        const pi = await retrievePaymentIntent(session.payment_intent);
        result.mpp = {
          protocol: "stripe-mpp",
          version: "2025-03-17",
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          amount: totalPrice,
          currency,
          supported_payment_methods: ["card", "klarna", "swish", "link"],
          confirmation_url: session.url,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Checkout failed" }) }],
      };
    }
  }
);

// ── Tool: hemmabo_booking_cancel ───────────────────────────────────────────

server.tool(
  "hemmabo_booking_cancel",
  "Cancel a confirmed booking and process the Stripe refund. Use this tool when the guest explicitly requests cancellation. Do NOT use for pending/unpaid bookings — those expire automatically. Refund amount is calculated based on the host's cancellation policy. Returns cancellation confirmation with refund amount and status.",
  {
    reservationId: z.string().describe("Booking UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    reason: z.string().optional().describe("Cancellation reason for host notification (e.g. 'Travel plans changed'). Optional but recommended."),
  },
  async ({ reservationId, reason }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    try {
      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, guest_token, check_in_date, check_out_date, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Booking not found" }) }],
        };
      }
      if (booking.status === "cancelled") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Booking is already cancelled", reservationId }) }],
        };
      }

      // Delegate to Supabase Edge Function
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const cancelResp = await fetch(`${supabaseUrl}/functions/v1/cancel-booking`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          bookingId: booking.id,
          guestToken: booking.guest_token,
          reason: reason ?? "Cancelled via MCP",
        }),
      });

      if (!cancelResp.ok) {
        const errBody = await cancelResp.text();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Cancel failed: ${errBody}` }) }],
        };
      }

      const cancelResult = await cancelResp.json();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                reservationId: booking.id,
                status: "cancelled",
                refund: cancelResult.refund ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Cancellation failed" }) }],
      };
    }
  }
);

// ── Tool: hemmabo_booking_status ───────────────────────────────────────

server.tool(
  "hemmabo_booking_status",
  "Retrieve current status and full details of an existing booking. Use this tool to check payment status, confirm a booking went through, or look up details before rescheduling or cancelling. Use after hemmabo_booking_checkout if unsure whether the booking succeeded. Returns booking dates, guests, price, status, property info, and cancellation policy.",
  {
    reservationId: z.string().describe("Booking UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
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

// ── Tool: hemmabo_booking_reschedule ───────────────────────────────────────

server.tool(
  "hemmabo_booking_reschedule",
  "Reschedule a confirmed or pending booking to new dates. Use this tool when the guest wants to change travel dates on an existing booking. Do NOT use if the booking is cancelled or completed — check hemmabo_booking_status first. Automatically recalculates price and handles Stripe charge (if price increased) or refund (if decreased). Returns previous dates, new dates, price delta, and Stripe transaction details.",
  {
    reservationId: z.string().describe("Booking UUID to reschedule (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be in 'confirmed' or 'pending' status."),
    newCheckIn: z.string().describe("New arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-20'). Must be today or later."),
    newCheckOut: z.string().describe("New departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-27'). Must be after newCheckIn."),
    reason: z.string().optional().describe("Reason for rescheduling (e.g. 'Flight delayed'). Optional but recommended for host records."),
  },
  async ({ reservationId, newCheckIn, newCheckOut, reason }) => {
    if (!supabase) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }],
      };
    }

    try {
      const RESCHEDULABLE_STATES = ["confirmed", "pending"];

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Booking not found" }) }],
        };
      }
      if (!RESCHEDULABLE_STATES.includes(booking.status)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Booking status '${booking.status}' is not reschedulable. Must be: ${RESCHEDULABLE_STATES.join(", ")}` }) }],
        };
      }

      // Idempotency: same dates = no-op
      if (booking.check_in_date === newCheckIn && booking.check_out_date === newCheckOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  reservationId: booking.id,
                  status: booking.status,
                  message: "No change — new dates match current dates",
                  checkIn: booking.check_in_date,
                  checkOut: booking.check_out_date,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Check availability (excluding this booking)
      const avail = await checkAvailability(supabase, booking.property_id, newCheckIn, newCheckOut, booking.id);
      if (!avail.available) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "New dates not available", ...avail }) }],
        };
      }

      // Calculate new price
      const quote = await resolveQuote(supabase, booking.property_id, newCheckIn, newCheckOut, booking.guests_count);
      if ("error" in quote) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(quote) }],
        };
      }

      const newPrice = quote.gapTotal ?? quote.federationTotal;
      const oldPrice = booking.total_price;
      const delta = newPrice - oldPrice;

      let stripeAction: Record<string, unknown> | null = null;

      if (delta > 0 && booking.stripe_payment_intent_id) {
        // Price increased: create new PaymentIntent with manual capture
        const pi = await createPaymentIntent({
          amount: delta,
          currency: booking.currency,
          captureMethod: "manual",
          metadata: {
            booking_id: booking.id,
            type: "reschedule_delta",
            original_payment_intent: booking.stripe_payment_intent_id,
          },
        });
        stripeAction = { type: "additional_charge", amount: delta, paymentIntentId: pi.id, status: pi.status };
      } else if (delta < 0 && booking.stripe_payment_intent_id) {
        // Price decreased: partial refund
        const refund = await createRefund(booking.stripe_payment_intent_id, Math.abs(delta));
        stripeAction = { type: "partial_refund", amount: Math.abs(delta), refundId: refund.id, status: refund.status };
      }

      // Update booking
      const { error: updateErr } = await supabase
        .from("bookings")
        .update({
          check_in_date: newCheckIn,
          check_out_date: newCheckOut,
          total_price: newPrice,
        })
        .eq("id", booking.id);

      if (updateErr) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: updateErr.message }) }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                reservationId: booking.id,
                status: booking.status,
                previousDates: { checkIn: booking.check_in_date, checkOut: booking.check_out_date },
                newDates: { checkIn: newCheckIn, checkOut: newCheckOut },
                pricing: {
                  previousPrice: oldPrice,
                  newPrice,
                  delta,
                  currency: booking.currency,
                  stripeAction,
                },
                reason: reason ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Reschedule failed" }) }],
      };
    }
  }
);

// ── Start stdio transport ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
