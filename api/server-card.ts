import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.1.7",
    },
    instructions: "Booking infrastructure for vacation rentals. Like Mirai for hotels — own domain, Stripe direct, 0% commission. 9 production tools covering complete booking lifecycle. All data is live from Supabase — never cached, never estimated. Workflow: (1) search_properties to find available rentals, (2) get_canonical_quote for detailed pricing, (3) checkout with Stripe payment. Guest data belongs to host. Seasonal rates, guest-count tiers, package discounts (7-night, 14-night), gap-night discounts, and host-controlled federation discounts are applied automatically. Dates must be ISO 8601 (YYYY-MM-DD). All monetary values are integers in local currency.",
    configSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Default region to search in (e.g. 'Skåne', 'Toscana'). Can be overridden per request.",
        },
        currency: {
          type: "string",
          description: "Preferred display currency (e.g. 'SEK', 'EUR'). Defaults to property's native currency.",
        },
        language: {
          type: "string",
          description: "Preferred response language (e.g. 'sv', 'en', 'de', 'it'). Defaults to English.",
        },
        SUPABASE_URL: {
          type: "string",
          description: "Supabase project URL (required)",
        },
        SUPABASE_SERVICE_ROLE_KEY: {
          type: "string",
          description: "Supabase service role key (required)",
        },
        STRIPE_SECRET_KEY: {
          type: "string",
          description: "Stripe secret key for payment processing (optional, enables checkout/cancel/reschedule)",
        },
      },
      additionalProperties: false,
    },
    tools: [
      {
        name: "search_properties",
        description:
          "Search vacation rental properties by location and travel dates. Returns only available properties with live pricing (public + federation rates).",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", description: "Region, area, or destination name. Supports partial matching." },
            country: { type: "string", description: "Country name to filter by. Supports partial matching." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
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
          "Check whether a property is available for the requested dates. Verifies blocked dates, bookings, and locks.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
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
          "Get detailed pricing: publicTotal, federationTotal, gapTotal. Per-night breakdown, season info, package pricing. All integers in local currency.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
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
          "Create a direct booking. Validates availability, calculates federation price, creates pending booking for host approval.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
            guestName: { type: "string", description: "Full name of primary guest." },
            guestEmail: { type: "string", format: "email", description: "Email of primary guest." },
            guestPhone: { type: "string", description: "Phone number (optional)." },
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
        name: "negotiate_offer",
        description:
          "Request a special federation quote with 15-minute expiry. Returns quoteToken, federation price, and expiry timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests"],
        },
        annotations: {
          title: "Negotiate Offer",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: "checkout",
        description:
          "Complete booking payment with Stripe Checkout Session. Supports MPP (Merchant Payment Provider) for instant host payouts.",
        inputSchema: {
          type: "object",
          properties: {
            quoteToken: { type: "string", description: "Quote token from negotiate_offer." },
            guestName: { type: "string", description: "Full name of primary guest." },
            guestEmail: { type: "string", format: "email", description: "Email of primary guest." },
            guestPhone: { type: "string", description: "Phone number (optional)." },
            successUrl: { type: "string", format: "uri", description: "Redirect URL after payment success." },
            cancelUrl: { type: "string", format: "uri", description: "Redirect URL if payment canceled." },
          },
          required: ["quoteToken", "guestName", "guestEmail", "successUrl", "cancelUrl"],
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
        name: "cancel_booking",
        description:
          "Cancel an existing booking. Delegates to Supabase Edge Function which handles refunds based on cancellation policy.",
        inputSchema: {
          type: "object",
          properties: {
            bookingId: { type: "string", format: "uuid", description: "Booking UUID." },
            reason: { type: "string", description: "Cancellation reason (optional)." },
          },
          required: ["bookingId"],
        },
        annotations: {
          title: "Cancel Booking",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: "get_booking_status",
        description:
          "Retrieve booking details and payment status from Supabase. Shows booking state, payment intent status, and refund info.",
        inputSchema: {
          type: "object",
          properties: {
            bookingId: { type: "string", format: "uuid", description: "Booking UUID." },
          },
          required: ["bookingId"],
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
        name: "reschedule_booking",
        description:
          "Move booking to new dates. Calculates price delta and creates PaymentIntent for additional charge or refund.",
        inputSchema: {
          type: "object",
          properties: {
            bookingId: { type: "string", format: "uuid", description: "Booking UUID." },
            newCheckIn: { type: "string", description: "New check-in date (YYYY-MM-DD)." },
            newCheckOut: { type: "string", description: "New check-out date (YYYY-MM-DD)." },
          },
          required: ["bookingId", "newCheckIn", "newCheckOut"],
        },
        annotations: {
          title: "Reschedule Booking",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ],
    resources: [],
    prompts: [
      {
        name: "plan_trip",
        description: "Help plan a vacation rental trip. Guides through searching, comparing prices, and booking.",
        arguments: [
          { name: "destination", description: "Where to travel (region, city, or country).", required: true },
          { name: "checkIn", description: "Check-in date (YYYY-MM-DD).", required: true },
          { name: "checkOut", description: "Check-out date (YYYY-MM-DD).", required: true },
          { name: "guests", description: "Number of guests.", required: true },
        ],
      },
    ],
  });
}
