import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.2.0",
    },
    instructions: "Booking infrastructure for vacation rentals. Like Mirai for hotels — own domain, Stripe direct, 0% commission. 11 production tools covering complete booking lifecycle. All data is live from Supabase — never cached, never estimated. Workflow: (1) hemmabo_search_properties to find available rentals, (2) hemmabo_booking_quote for detailed pricing, (3) hemmabo_booking_checkout with Stripe payment. Guest data belongs to host. Seasonal rates, guest-count tiers, package discounts (7-night, 14-night), gap-night discounts, and host-controlled federation discounts are applied automatically. Dates must be ISO 8601 (YYYY-MM-DD). All monetary values are integers in local currency.",
    configSchema: {
      type: "object",
      properties: {
        propertyDomain: {
          type: "string",
          description: "Your vacation rental domain (e.g. villaaakerlyckan.se)",
          default: "",
        },
        language: {
          type: "string",
          description: "Default response language",
          default: "sv",
          enum: ["sv", "en", "de", "fr"],
        },
        currency: {
          type: "string",
          description: "Default currency for pricing",
          default: "SEK",
          enum: ["SEK", "EUR", "USD", "NOK", "DKK"],
        },
      },
      required: [],
    },
    tools: [
      {
        name: "hemmabo_search_properties",
        description:
          "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use hemmabo_search_availability or hemmabo_booking_quote instead. Returns a list of available properties with propertyId, live pricing (public and federation rates), and capacity info needed for subsequent tools.",
        inputSchema: {
          type: "object",
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
          type: "object",
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
        name: "hemmabo_search_similar",
        description:
          "Find vacation rental properties similar to a given property on specific dates. Use this tool after the user has selected a property and wants to see alternatives — same region, same property type, same or larger capacity. Do NOT use for initial search; use hemmabo_search_properties instead. Returns a list of similar available properties with live pricing, excluding the source property.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "UUID of the source property to find alternatives for." },
            checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
            checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
            guests: { type: "integer", minimum: 1, description: "Number of guests. Defaults to source property max_guests if omitted." },
            limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of results. Default 5, max 20." },
          },
          required: ["propertyId", "checkIn", "checkOut"],
        },
        annotations: {
          title: "Find Similar Properties",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "hemmabo_compare_properties",
        description:
          "Compare availability and pricing for 2–10 specific properties on the same dates. Use this tool when the user is deciding between multiple properties and wants price and availability side by side. Do NOT use for discovery — use hemmabo_search_properties first. Returns one entry per propertyId sorted by federation price (cheapest first), unavailable properties last.",
        inputSchema: {
          type: "object",
          properties: {
            propertyIds: { type: "array", items: { type: "string", format: "uuid" }, minItems: 2, maxItems: 10, description: "Array of 2 to 10 property UUIDs to compare." },
            checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
            checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
          },
          required: ["propertyIds", "checkIn", "checkOut", "guests"],
        },
        annotations: {
          title: "Compare Properties",
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
          type: "object",
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
          type: "object",
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
          type: "object",
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
          type: "object",
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
          type: "object",
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
          type: "object",
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
          type: "object",
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
