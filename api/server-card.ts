import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "federation-mcp-server",
      version: "2.2.0",
    },
    instructions: "This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated. Workflow: (1) search_properties to find available rentals, (2) get_canonical_quote for detailed pricing, (3) create_booking to finalize. Use check_availability for date-specific checks. Pricing tiers scale by guest count (staircase model). Seasonal rates, weekend premiums (Fri+Sat only), and package discounts (7-night, 14-night) are applied automatically. Dates must be ISO 8601 (YYYY-MM-DD). All monetary values are integers in the property's local currency.",
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    tools: [
      {
        name: "search_properties",
        description:
          "Search vacation rental properties by location and travel dates. Returns only properties that are available for the requested period and can accommodate the guest count. Each result includes live pricing with both public rates and federation rates (direct booking discount). Use region or country to filter by location.",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", description: "Region, area, or destination name. Supports partial matching (e.g. 'Skåne', 'Toscana')." },
            country: { type: "string", description: "Country name to filter by (e.g. 'Sweden', 'Italy'). Supports partial matching." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests. Determines price tier and filters out too-small properties." },
            checkIn: { type: "string", description: "Check-in date in ISO 8601 format (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date in ISO 8601 format (YYYY-MM-DD)." },
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
          "Check whether a specific property is available for the requested date range. Verifies against host-blocked dates, confirmed bookings, and active booking locks. Returns available=true/false with conflict details.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property." },
            checkIn: { type: "string", description: "Desired check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Desired check-out date (YYYY-MM-DD)." },
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
          "Get a detailed pricing quote for a property, date range, and guest count. Returns publicTotal (website rate), federationTotal (direct booking rate with host discount), and gapTotal (gap-night discount if applicable). Includes per-night breakdown, season info, weekend detection, and package pricing (7/14-night). All prices are integers in local currency.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests. Determines staircase price tier." },
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
          "Create a new direct booking. Write operation: validates availability, calculates federation price (with gap discount if applicable), creates a pending booking requiring host approval. Returns booking ID, final price, and confirmation details.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "The unique identifier (UUID) of the property to book." },
            checkIn: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
            checkOut: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
            guests: { type: "integer", minimum: 1, description: "Total number of guests." },
            guestName: { type: "string", description: "Full name of the primary guest." },
            guestEmail: { type: "string", format: "email", description: "Email of the primary guest." },
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
    ],
    resources: [],
    prompts: [],
  });
}
