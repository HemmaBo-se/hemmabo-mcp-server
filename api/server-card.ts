import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "federation-mcp-server",
      version: "2.0.0",
    },
    tools: [
      {
        name: "search_properties",
        description:
          "Search for available properties by region and guest count. Returns real pricing from each property node.",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", description: "Region or destination" },
            country: { type: "string", description: "Country" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
          },
          required: ["guests", "checkIn", "checkOut"],
        },
      },
      {
        name: "check_availability",
        description:
          "Check if a property is available for given dates. Verifies blocked dates, bookings, and locks.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
          },
          required: ["propertyId", "checkIn", "checkOut"],
        },
      },
      {
        name: "get_canonical_quote",
        description:
          "Get canonical pricing: public_total (website), federation_total (direct booking with host discount), gap_total (calendar-context gap). Host controls the discount.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests"],
        },
      },
      {
        name: "create_booking",
        description:
          "Create a direct booking. Validates availability, calculates federation price, writes to bookings.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", format: "uuid", description: "Property UUID" },
            checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
            guests: { type: "integer", minimum: 1, description: "Number of guests" },
            guestName: { type: "string", description: "Guest full name" },
            guestEmail: { type: "string", format: "email", description: "Guest email" },
            guestPhone: { type: "string", description: "Guest phone (optional)" },
          },
          required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
        },
      },
    ],
    resources: [],
    prompts: [],
  });
}
