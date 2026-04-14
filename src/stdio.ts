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
    instructions: "This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.\n\nFull booking lifecycle: hemmabo.search.properties (find properties) -> hemmabo.booking.negotiate (binding quote with quoteId) -> hemmabo.booking.checkout (Stripe payment) -> hemmabo.booking.status (check details) -> hemmabo.booking.reschedule / hemmabo.booking.cancel (modify or cancel).\n\nLegacy shortcut: hemmabo.search.properties -> hemmabo.booking.quote -> hemmabo.booking.create (no payment, pending host approval).\n\nPricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.\n\nDates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).",
  }
);

// ── Tool: hemmabo.search.properties ────────────────────────────────────────

server.tool(
  "hemmabo.search.properties",
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

// ── Tool: hemmabo.search.properties.availability ───────────────────────────────────────

server.tool(
  "hemmabo.search.properties.availability",
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

// ── Tool: hemmabo.booking.quote ──────────────────────────────────────

server.tool(
  "hemmabo.booking.quote",
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

// ── Tool: hemmabo.booking.create ───────────────────────────────────────────

server.tool(
  "hemmabo.booking.create",
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

// ── Tool: hemmabo.booking.negotiate ──────────────────────────────────────────

server.tool(
  "hemmabo.booking.negotiate",
  "Create a binding price quote with a unique quote identifier that expires after 15 minutes. The quoted price is stored as an immutable snapshot so it cannot change during checkout. Pass the quote identifier to the hemmabo.booking.checkout tool to lock the price. This protects both guest and host from price fluctuations between browsing and completing payment.",
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

// ── Tool: hemmabo.booking.checkout ─────────────────────────────────────────────────

server.tool(
  "hemmabo.booking.checkout",
  "Create a booking with secure online payment via Stripe. Generates a hosted payment page where the guest can pay by card, Klarna, Swish, or other supported methods. If a quote identifier from hemmabo.booking.negotiate is provided, the price is locked to that quote. Also supports programmatic payment for AI agents that can confirm payment directly. Returns booking ID and payment URL.",
  {
    propertyId: z.string().uuid().describe("Property UUID"),
    checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
    checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
    guests: z.number().int().min(1).describe("Number of guests"),
    guestName: z.string().describe("Guest full name"),
    guestEmail: z.string().email().describe("Guest email"),
    guestPhone: z.string().optional().describe("Guest phone number"),
    quoteId: z.string().optional().describe("Quote ID from hemmabo.booking.negotiate (locks price)"),
    paymentMode: z.enum(["checkout_session", "payment_intent"]).optional().describe("Payment mode (default: checkout_session)"),
    channel: z.enum(["public", "federation"]).optional().describe("Pricing channel (default: federation)"),
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
        // Use locked quote from hemmabo.booking.negotiate
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

// ── Tool: hemmabo.booking.cancel ───────────────────────────────────────────

server.tool(
  "hemmabo.booking.cancel",
  "Cancel an existing booking. Calculates the refund amount based on the host's cancellation policy, processes the refund through Stripe, updates the booking status to cancelled, and sends email notifications to both guest and host. Returns the updated booking status and refund details including amount and reason.",
  {
    reservationId: z.string().describe("Booking ID (UUID)"),
    reason: z.string().optional().describe("Cancellation reason (optional)"),
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

// ── Tool: hemmabo.booking.status ───────────────────────────────────────

server.tool(
  "hemmabo.booking.status",
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

// ── Tool: hemmabo.booking.reschedule ───────────────────────────────────────

server.tool(
  "hemmabo.booking.reschedule",
  "Reschedule a booking to new dates. Checks availability for new dates, recalculates price, handles Stripe charge (if price increased) or refund (if decreased) for the price delta. Updates booking record with new dates and price. Returns updated booking info and Stripe transaction details.",
  {
    reservationId: z.string().describe("Booking ID (UUID)"),
    newCheckIn: z.string().describe("New check-in date YYYY-MM-DD"),
    newCheckOut: z.string().describe("New check-out date YYYY-MM-DD"),
    reason: z.string().optional().describe("Rescheduling reason (optional)"),
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
