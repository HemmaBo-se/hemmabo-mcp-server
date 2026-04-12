import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "hemmabo-mcp-server",
  version: "1.0.0",
});

// Mock property data
const MOCK_PROPERTIES = [
  {
    propertyId: "prop-001",
    name: "Seaside Cottage",
    region: "Stockholm Archipelago",
    maxGuests: 6,
    pricePerNight: 1500,
  },
  {
    propertyId: "prop-002",
    name: "Forest Cabin",
    region: "Dalarna",
    maxGuests: 4,
    pricePerNight: 900,
  },
  {
    propertyId: "prop-003",
    name: "Lakeside Villa",
    region: "Värmland",
    maxGuests: 10,
    pricePerNight: 2200,
  },
];

function daysBetween(checkIn: string, checkOut: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(
    1,
    Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / msPerDay
    )
  );
}

// Tool: search_properties
server.tool(
  "search_properties",
  "Search for available vacation rental properties in a region for given dates and guest count.",
  {
    region: z.string().describe("The region or destination to search in"),
    checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
    checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
    guests: z.number().int().min(1).describe("Number of guests"),
  },
  async ({ region, checkIn, checkOut, guests }) => {
    const results = MOCK_PROPERTIES.filter(
      (p) =>
        p.region.toLowerCase().includes(region.toLowerCase()) &&
        p.maxGuests >= guests
    );

    const nights = daysBetween(checkIn, checkOut);

    const properties = results.map((p) => ({
      propertyId: p.propertyId,
      name: p.name,
      region: p.region,
      maxGuests: p.maxGuests,
      nights,
      estimatedTotal: p.pricePerNight * nights,
      currency: "SEK",
      available: true,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ checkIn, checkOut, guests, properties }, null, 2),
        },
      ],
    };
  }
);

// Tool: check_availability
server.tool(
  "check_availability",
  "Check whether a specific property is available for the given dates.",
  {
    propertyId: z.string().describe("The unique property identifier"),
    checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
    checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
  },
  async ({ propertyId, checkIn, checkOut }) => {
    const property = MOCK_PROPERTIES.find((p) => p.propertyId === propertyId);
    const available = property !== undefined;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              propertyId,
              checkIn,
              checkOut,
              available,
              ...(available
                ? { propertyName: property!.name }
                : { reason: "Property not found" }),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: get_canonical_quote
server.tool(
  "get_canonical_quote",
  "Get a canonical pricing quote for a property, returning both the AI partner price (aiTotal) and the public direct price (publicTotal).",
  {
    propertyId: z.string().describe("The unique property identifier"),
    checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
    checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
    guests: z.number().int().min(1).describe("Number of guests"),
  },
  async ({ propertyId, checkIn, checkOut, guests }) => {
    const property = MOCK_PROPERTIES.find((p) => p.propertyId === propertyId);

    if (!property) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Property not found", propertyId }, null, 2),
          },
        ],
      };
    }

    const nights = daysBetween(checkIn, checkOut);
    const baseTotal = property.pricePerNight * nights;
    const cleaningFee = 500;
    const publicTotal = baseTotal + cleaningFee;
    // AI partner price: 5% discount (no commission layer)
    const aiTotal = Math.round(publicTotal * 0.95);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              propertyId,
              propertyName: property.name,
              checkIn,
              checkOut,
              guests,
              nights,
              currency: "SEK",
              breakdown: {
                pricePerNight: property.pricePerNight,
                accommodationTotal: baseTotal,
                cleaningFee,
              },
              publicTotal,
              aiTotal,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: create_booking
server.tool(
  "create_booking",
  "Create a direct booking for a property. Returns a booking confirmation with a unique bookingId.",
  {
    propertyId: z.string().describe("The unique property identifier"),
    checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
    checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
    guests: z.number().int().min(1).describe("Number of guests"),
    guestEmail: z.string().email().describe("Guest's email address"),
  },
  async ({ propertyId, checkIn, checkOut, guests, guestEmail }) => {
    const property = MOCK_PROPERTIES.find((p) => p.propertyId === propertyId);

    if (!property) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Property not found", propertyId }, null, 2),
          },
        ],
      };
    }

    if (guests > property.maxGuests) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: "Too many guests",
                maxGuests: property.maxGuests,
                requested: guests,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const nights = daysBetween(checkIn, checkOut);
    const cleaningFee = 500;
    const totalAmount = property.pricePerNight * nights + cleaningFee;
    const bookingId = `BK-${Date.now()}-${Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0")}`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              bookingId,
              status: "confirmed",
              propertyId,
              propertyName: property.name,
              checkIn,
              checkOut,
              nights,
              guests,
              guestEmail,
              totalAmount,
              currency: "SEK",
              networkId: "hemmabo_verified",
              createdAt: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HemmaBo MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
