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
