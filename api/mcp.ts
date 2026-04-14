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
import {
  createCheckoutSession,
  retrievePaymentIntent,
  createRefund,
  createPaymentIntent,
} from "../src/stripe.js";

// ── Server-level instructions for AI agents ──────────────────────
const SERVER_INSTRUCTIONS = `This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.

Full booking lifecycle: hemmabo_search_properties (find properties) -> hemmabo_booking_negotiate (binding quote with quoteId) -> hemmabo_booking_checkout (Stripe payment) -> hemmabo_booking_status (check details) -> hemmabo_booking_reschedule / hemmabo_booking_cancel (modify or cancel).

Legacy shortcut: hemmabo_search_properties -> hemmabo_booking_quote -> hemmabo_booking_create (no payment, pending host approval).

Pricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;

// ── Config schema (all fields optional — Smithery "Optional config" requirement) ──
const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    region: {
      type: "string",
      description: "Default region to search in (e.g. 'Skane', 'Toscana'). Can be overridden per request.",
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
    name: "hemmabo_search_properties",
    description:
      "Search vacation rental properties by location and travel dates. Returns only properties that are available for the requested period and can accommodate the guest count. Each result includes live pricing with both public rates (what OTA/website visitors see) and federation rates (direct booking discount). Use region or country to filter by location. Guests parameter determines which price tier applies. Results are sorted by relevance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string", description: "Region, area, or destination name to search within. Supports partial matching (e.g. 'Skane', 'Toscana', 'Bavaria')." },
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
    name: "hemmabo_search_availability",
    description:
      "Check whether a specific property is available for the requested date range. Verifies against three sources: host-blocked dates, confirmed bookings, and active booking locks (temporary holds during checkout). Returns available=true/false with conflict details if unavailable. Call this before hemmabo_booking_create to confirm availability, or use it to check multiple date ranges for the same property.",
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
    name: "hemmabo_booking_quote",
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
    name: "hemmabo_booking_create",
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
  {
    name: "hemmabo_booking_negotiate",
    description:
      "Create a binding price quote with a unique quote identifier that expires after 15 minutes. The quoted price is stored as an immutable snapshot so it cannot change during checkout. Pass the quote identifier to the hemmabo_booking_checkout tool to lock the price. This protects both guest and host from price fluctuations between browsing and completing payment. Returns public and federation totals, per-night breakdown, package info, and the quote identifier.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to quote." },
        checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests. Determines which price tier is applied." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
    },
    annotations: {
      title: "Negotiate Offer",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_booking_checkout",
    description:
      "Create a booking with secure online payment via Stripe. Generates a hosted payment page where the guest can pay by card, Klarna, Swish, or other supported methods. If a quote identifier from hemmabo_booking_negotiate is provided, the price is locked to that quote. Also supports programmatic payment for AI agents that can confirm payment directly. Returns booking ID, payment URL, and payment details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to book." },
        checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests staying." },
        guestName: { type: "string", description: "Full legal name of the primary guest." },
        guestEmail: { type: "string", format: "email", description: "Email address of the primary guest." },
        guestPhone: { type: "string", description: "Phone number of the primary guest (optional)." },
        quoteId: { type: "string", description: "Quote ID from hemmabo_booking_negotiate. Locks the price to the snapshot. Optional — if omitted, a fresh federation price is calculated." },
        paymentMode: { type: "string", enum: ["checkout_session", "payment_intent"], description: "Payment mode. 'checkout_session' (default) returns a Stripe redirect URL. 'payment_intent' returns a client_secret for programmatic payment (MPP)." },
        channel: { type: "string", enum: ["public", "federation"], description: "Pricing channel. 'federation' (default) applies the direct booking discount. 'public' uses the standard rate." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
    },
    annotations: {
      title: "Checkout",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_booking_cancel",
    description:
      "Cancel an existing booking. Calculates the refund amount based on the host's cancellation policy, processes the refund through Stripe, updates the booking status to cancelled, and sends email notifications to both guest and host. Returns the updated booking status and refund details including amount, percentage, and reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "The booking ID (UUID) to cancel." },
        reason: { type: "string", description: "Reason for cancellation (optional). Stored for host records." },
      },
      required: ["reservationId"],
    },
    annotations: {
      title: "Cancel Booking",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_booking_status",
    description:
      "Get the current status and details of a booking. Returns booking information (dates, guests, price, status), property details (name, domain), and the applicable cancellation policy (tier and refund rules). Use this to check on a booking after creation or before attempting a reschedule or cancellation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "The booking ID (UUID) to look up." },
      },
      required: ["reservationId"],
    },
    annotations: {
      title: "Get Booking Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_booking_reschedule",
    description:
      "Reschedule a booking to new dates. Validates that the booking is in a reschedulable state (confirmed or pending), checks availability for the new dates (excluding the current booking from conflict detection), recalculates the price, and handles the Stripe charge/refund for any price delta. If the new price is higher, a new PaymentIntent with manual capture is created. If lower, a partial refund is issued on the original PaymentIntent. Returns previous and new dates, pricing details, and any Stripe action taken.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "The booking ID (UUID) to reschedule." },
        newCheckIn: { type: "string", description: "New check-in date in ISO 8601 format (YYYY-MM-DD)." },
        newCheckOut: { type: "string", description: "New check-out date in ISO 8601 format (YYYY-MM-DD). Must be after newCheckIn." },
        reason: { type: "string", description: "Reason for rescheduling (optional). Stored for host records." },
      },
      required: ["reservationId", "newCheckIn", "newCheckOut"],
    },
    annotations: {
      title: "Reschedule Booking",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

// ── Prompts ──────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: "plan_trip",
    description: "Help plan a vacation rental trip. Guides the agent through the full booking lifecycle: searching properties, getting a binding quote, completing payment via Stripe checkout, and managing the booking (status checks, rescheduling, cancellation). Provide destination, dates, and guest count to get started.",
    arguments: [
      {
        name: "destination",
        description: "Where the guest wants to travel (region, city, or country). Example: 'Skane', 'Sweden', 'Toscana'.",
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
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please: (1) search for available properties, (2) show pricing with both public and direct booking rates, (3) create a binding quote with hemmabo_booking_negotiate, (4) proceed to hemmabo_booking_checkout with Stripe payment, and (5) confirm the booking status. If I need to change dates later, use hemmabo_booking_reschedule. If I need to cancel, use hemmabo_booking_cancel.`,
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
    case "hemmabo_search_properties": {
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

    case "hemmabo_search_availability": {
      const { propertyId, checkIn, checkOut } = args as { propertyId: string; checkIn: string; checkOut: string };
      const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "hemmabo_booking_quote": {
      const { propertyId, checkIn, checkOut, guests } = args as { propertyId: string; checkIn: string; checkOut: string; guests: number };
      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      return { content: [{ type: "text", text: JSON.stringify(quote, null, 2) }] };
    }

    case "hemmabo_booking_create": {
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

    case "hemmabo_booking_negotiate": {
      const { propertyId, checkIn, checkOut, guests } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
      };

      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }] };

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
          segments_detail: quote.breakdown.nightlyRates.map(n => ({
            date: n.date,
            rate: n.rate,
            season: n.season,
            dayType: n.dayType,
          })),
          status: "ok",
        })
        .select("id")
        .single();

      if (snapErr) return { content: [{ type: "text", text: JSON.stringify({ error: snapErr.message }) }] };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
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
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_checkout": {
      const {
        propertyId, checkIn, checkOut, guests, guestName, guestEmail,
        guestPhone, quoteId, paymentMode, channel,
      } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
        guestName: string; guestEmail: string; guestPhone?: string;
        quoteId?: string; paymentMode?: string; channel?: string;
      };

      const effectivePaymentMode = paymentMode ?? "checkout_session";
      const effectiveChannel = channel ?? "federation";

      // Fetch property
      const { data: prop, error: propErr } = await supabase
        .from("properties")
        .select("name, domain, host_id, currency, direct_booking_discount, cleaning_fee")
        .eq("id", propertyId)
        .single();
      if (propErr || !prop) return { content: [{ type: "text", text: JSON.stringify({ error: "Property not found" }) }] };

      // Check availability
      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...avail }) }] };

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
        if (snapErr || !snapshot) return { content: [{ type: "text", text: JSON.stringify({ error: "Quote not found" }) }] };
        if (new Date(snapshot.valid_until) < new Date()) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Quote expired", quoteId, validUntil: snapshot.valid_until }) }] };
        }
        totalPrice = effectiveChannel === "public" ? snapshot.public_total : snapshot.ai_total;
        currency = snapshot.currency;
        nights = snapshot.nights;
      } else {
        // Calculate fresh price
        const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
        if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }] };
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

      if (bookErr) return { content: [{ type: "text", text: JSON.stringify({ error: bookErr.message }) }] };

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

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "hemmabo_booking_cancel": {
      const { reservationId, reason } = args as { reservationId: string; reason?: string };

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, guest_token, check_in_date, check_out_date, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }] };
      if (booking.status === "cancelled") return { content: [{ type: "text", text: JSON.stringify({ error: "Booking is already cancelled", reservationId }) }] };

      // Delegate to Supabase Edge Function
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const cancelResp = await fetch(`${supabaseUrl}/functions/v1/cancel-booking`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          bookingId: booking.id,
          guestToken: booking.guest_token,
          reason: reason ?? "Cancelled via MCP",
        }),
      });

      if (!cancelResp.ok) {
        const errBody = await cancelResp.text();
        return { content: [{ type: "text", text: JSON.stringify({ error: `Cancel failed: ${errBody}` }) }] };
      }

      const cancelResult = await cancelResp.json();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId: booking.id,
            status: "cancelled",
            refund: cancelResult.refund ?? null,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_status": {
      const { reservationId } = args as { reservationId: string };

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, guest_name, guest_email, created_at, updated_at")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }] };

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
        content: [{
          type: "text",
          text: JSON.stringify({
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
            cancellationPolicy: policy ? {
              tier: policy.cancellation_tier,
              refundRules: policy.refund_rules,
            } : null,
            createdAt: booking.created_at,
            updatedAt: booking.updated_at,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_reschedule": {
      const { reservationId, newCheckIn, newCheckOut, reason } = args as {
        reservationId: string; newCheckIn: string; newCheckOut: string; reason?: string;
      };

      const RESCHEDULABLE_STATES = ["confirmed", "pending"];

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }] };
      if (!RESCHEDULABLE_STATES.includes(booking.status)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Booking status '${booking.status}' is not reschedulable. Must be: ${RESCHEDULABLE_STATES.join(", ")}` }) }] };
      }

      // Idempotency: same dates = no-op
      if (booking.check_in_date === newCheckIn && booking.check_out_date === newCheckOut) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reservationId: booking.id,
              status: booking.status,
              message: "No change — new dates match current dates",
              checkIn: booking.check_in_date,
              checkOut: booking.check_out_date,
            }, null, 2),
          }],
        };
      }

      // Check availability (excluding this booking)
      const avail = await checkAvailability(supabase, booking.property_id, newCheckIn, newCheckOut, booking.id);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "New dates not available", ...avail }) }] };

      // Calculate new price
      const quote = await resolveQuote(supabase, booking.property_id, newCheckIn, newCheckOut, booking.guests_count);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }] };

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

      if (updateErr) return { content: [{ type: "text", text: JSON.stringify({ error: updateErr.message }) }] };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
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
          serverInfo: {
            name: "federation-mcp-server",
            version: "3.1.8",
            description: "MCP server for vacation rental direct bookings. Search properties, check availability, get real-time pricing quotes, and create bookings through the federation protocol. Supports seasonal pricing, guest-count tiers, weekly and biweekly package discounts, gap-night discounts, and host-controlled federation discounts. All data is live — never cached, never estimated.",
          },
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
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: "3.1.8" });
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
