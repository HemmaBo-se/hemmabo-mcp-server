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
          "Search vacation rental properties by location and travel dates. Returns only properties that are available for the requested period and can accommodate the guest count. Each result includes live pricing with both public rates (what OTA/website visitors see) and federation rates (direct booking discount). Use region or country to filter by location. Guests parameter determines which price tier applies. Results are sorted by relevance.",
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
          "Check whether a specific property is available for the requested date range. Verifies against three sources: host-blocked dates, confirmed bookings, and active booking locks (temporary holds during checkout). Returns available=true/false with conflict details if unavailable. Call this before create_booking to confirm availability, or use it to check multiple date ranges for the same property.",
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
          "Get a detailed pricing quote for a specific property, date range, and guest count. Returns three price points: (1) publicTotal — the rate shown on public websites, (2) federationTotal — the direct booking rate with the host's configured discount applied, (3) gapTotal — an additional discount if the dates fill a gap between existing bookings. Also returns per-night breakdown, season classification, weekend detection, and any package pricing (7-night week or 14-night two-week discounts). All prices are integers in the property's local currency. The host controls all discount percentages.",
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
          "Create a new direct booking for a property. This is a write operation that: (1) validates the property is still available for the requested dates, (2) calculates the final federation price (with gap discount if applicable), (3) creates a pending booking record that requires host approval. Returns the booking ID, final price, and confirmation details. The booking status starts as 'pending' until the host approves. Guest contact details are required for the host to follow up.",
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
          "Create a binding price quote with a unique quote identifier that expires after 15 minutes. The quoted price is stored as an immutable snapshot so it cannot change during checkout. Pass the quote identifier to the checkout tool to lock the price. This protects both guest and host from price fluctuations between browsing and completing payment. Returns public and federation totals, per-night breakdown, package info, and the quote identifier.",
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
          "Create a booking with secure online payment via Stripe. Generates a hosted payment page where the guest can pay by card, Klarna, Swish, or other supported methods. If a quote identifier from negotiate_offer is provided, the price is locked to that quote. Also supports programmatic payment for AI agents that can confirm payment directly. Returns booking ID, payment URL, and payment details.",
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
          "Cancel an existing booking. Calculates the refund amount based on the host's cancellation policy, processes the refund through Stripe, updates the booking status to cancelled, and sends email notifications to both guest and host. Returns the updated booking status and refund details including amount, percentage, and reason.",
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
          "Get the current status and details of a booking. Returns booking information (dates, guests, price, status), property details (name, domain), and the applicable cancellation policy (tier and refund rules). Use this to check on a booking after creation or before attempting a reschedule or cancellation.",
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
          "Reschedule a booking to new dates. Validates that the booking is in a reschedulable state (confirmed or pending), checks availability for the new dates (excluding the current booking from conflict detection), recalculates the price, and handles the Stripe charge or refund for any price difference. If the new price is higher, an additional charge is created. If lower, a partial refund is issued. Returns previous and new dates, pricing details, and any payment action taken.",
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
