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

// ╔══════════════════════════════════════════════════════════════════╗
// ║ SYNC WARNING: Tool logic is duplicated in src/index.ts          ║
// ║ (MCP SDK + stdio transport). If you change a tool handler here, ║
// ║ you MUST make the same change in src/index.ts — and vice versa. ║
// ║                                                                ║
// ║ Shared logic lives in lib/ (pricing.ts, availability.ts) and   ║
// ║ src/stripe.ts — always prefer editing shared files.            ║
// ╚══════════════════════════════════════════════════════════════════╝

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
      "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use hemmabo_search_availability or hemmabo_booking_quote instead. Returns a list of available properties with propertyId, live pricing (public and federation rates), and capacity info needed for subsequent tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string", description: "Region, area, or destination name to search within. Partial match (e.g. 'Skane', 'Toscana', 'Bavaria'). At least one of region or country should be provided." },
        country: { type: "string", description: "Country name to filter by (e.g. 'Sweden', 'Italy'). Partial match. At least one of region or country should be provided." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines price tier and filters out properties with insufficient capacity." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
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
      "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from hemmabo_search_properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use hemmabo_search_properties instead. Returns available=true/false with conflict details (blocked dates, existing bookings, active locks) if unavailable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID returned by hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
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
      "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns publicTotal (website rate), federationTotal (direct booking discount), gapTotal (gap-night discount if applicable), per-night breakdown, and package pricing. All prices are integers in the property's local currency (e.g. SEK).",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied (staircase pricing by guest count)." },
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
      "Create a direct booking without online payment (legacy flow). Use this tool when the user wants to book without Stripe payment — the booking is created with status 'pending' and requires host approval. Do NOT use for paid bookings — use hemmabo_booking_checkout instead. Do NOT retry on timeout without calling hemmabo_booking_status first to avoid duplicate bookings. Returns bookingId, final price, and confirmation details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: { type: "string", description: "Full name of primary guest (e.g. 'Anna Svensson')." },
        guestEmail: { type: "string", format: "email", description: "Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address." },
        guestPhone: { type: "string", description: "Phone with country code (e.g. '+46701234567'). Optional but recommended for check-in coordination." },
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
      "Create a binding price quote that locks the price for 15 minutes. Use this tool before hemmabo_booking_checkout to guarantee the quoted price during payment. Do NOT skip this step if the user wants price certainty — without a quoteId, checkout calculates a fresh price that may differ. Returns quoteId (pass to hemmabo_booking_checkout), public and federation totals, per-night breakdown, and expiry timestamp.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied." },
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
      "Create a booking with Stripe payment and return a checkout URL. Use this tool when the user is ready to pay — it creates the booking record and generates a Stripe payment page. Do NOT call twice for the same booking — check hemmabo_booking_status first to avoid double charges. Optionally pass quoteId from hemmabo_booking_negotiate to lock the price. Returns reservationId, paymentUrl (Stripe checkout page), and pricing details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: { type: "string", description: "Full name of primary guest (e.g. 'Anna Svensson')." },
        guestEmail: { type: "string", format: "email", description: "Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address." },
        guestPhone: { type: "string", description: "Phone with country code (e.g. '+46701234567'). Optional but recommended." },
        quoteId: { type: "string", description: "Quote ID from hemmabo_booking_negotiate to lock the price. Optional — if omitted, a fresh federation price is calculated at checkout time." },
        paymentMode: { type: "string", enum: ["checkout_session", "payment_intent"], description: "'checkout_session' (default): returns Stripe redirect URL. 'payment_intent': returns client_secret for programmatic payment (AI agent MPP flow)." },
        channel: { type: "string", enum: ["public", "federation"], description: "'federation' (default): applies direct booking discount. 'public': uses standard website rate." },
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
      "Cancel a confirmed booking and process the Stripe refund. Use this tool when the guest explicitly requests cancellation. Do NOT use for pending/unpaid bookings — those expire automatically. Refund amount is calculated based on the host's cancellation policy. Returns cancellation confirmation with refund amount and status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        reason: { type: "string", description: "Cancellation reason for host notification (e.g. 'Travel plans changed'). Optional but recommended." },
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
      "Retrieve current status and full details of an existing booking. Use this tool to check payment status, confirm a booking went through, or look up details before rescheduling or cancelling. Use after hemmabo_booking_checkout if unsure whether the booking succeeded. Returns booking dates, guests, price, status, property info, and cancellation policy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
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
      "Reschedule a confirmed or pending booking to new dates. Use this tool when the guest wants to change travel dates on an existing booking. Do NOT use if the booking is cancelled or completed — check hemmabo_booking_status first. Automatically recalculates price and handles Stripe charge (if price increased) or refund (if decreased). Returns previous dates, new dates, price delta, and Stripe transaction details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID to reschedule (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be in 'confirmed' or 'pending' status." },
        newCheckIn: { type: "string", description: "New arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-20'). Must be today or later." },
        newCheckOut: { type: "string", description: "New departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-27'). Must be after newCheckIn." },
        reason: { type: "string", description: "Reason for rescheduling (e.g. 'Flight delayed'). Optional but recommended for host records." },
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
            resources: { listChanged: false },
          },
          serverInfo: {
            name: "federation-mcp-server",
            version: "3.1.16",
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

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };

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
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: "3.1.16" });
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
