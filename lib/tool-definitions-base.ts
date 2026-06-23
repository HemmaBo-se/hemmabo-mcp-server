/**
 * Single source of truth for the 11 HemmaBo federation MCP tools.
 *
 * Background (#63 / ADR-0001 §3):
 *   Tool definitions used to live in three places — api/mcp.ts TOOLS array,
 *   src/index.ts server.tool() calls, src/stdio.ts server.tool() calls.
 *   Only the api/mcp.ts copy was contract-tested. The other two could drift
 *   silently (different schemas, different descriptions, missing tools).
 *
 *   This module exports TOOL_SPECS as the canonical declaration. All three
 *   transports derive their wire format from it:
 *     - api/mcp.ts: re-exports TOOLS = toMcpTool(spec) for tools/list
 *     - src/index.ts and src/stdio.ts: iterate TOOL_SPECS and call
 *       server.tool(name, description, toZodShape(inputSchema), annotations, handler)
 *
 *   A drift-guard test (src/tool-definitions.singleton.test.ts) enforces
 *   that no other module declares its own tool list and that all three
 *   transports stay in lock-step.
 *
 * Schema model:
 *   inputSchema and outputSchema are JSON-Schema (draft-07 subset). The
 *   subset uses: type (object/string/integer/number/boolean/array), format
 *   (uuid/email/date-time/uri), pattern, enum, minimum/maximum, minItems/
 *   maxItems, properties, items, required, additionalProperties. This is
 *   intentionally narrow so toZodShape() can be a tiny pure function.
 */

import { z } from "zod";
// ── JSON-Schema field type (the subset we use) ───────────────────

export interface JsonSchemaField {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  format?: string;
  pattern?: string;
  enum?: readonly string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaField;
  properties?: Record<string, JsonSchemaField>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchemaField;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaField>;
  required?: readonly string[];
  /** Required by #85 — Ajv must reject unknown keys so AI agents see typo'd
   *  field names as field-level errors instead of generic "missing required". */
  additionalProperties: false;
}

export interface ToolOutputSchema {
  type: "object";
  properties: Record<string, JsonSchemaField>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  outputSchema: ToolOutputSchema;
  annotations: ToolAnnotations;
  /** Optional ChatGPT Apps SDK / vendor extensions. */
  _meta?: Record<string, unknown>;
}

// ── JSON-Schema → Zod converter (subset) ─────────────────────────
//
// Only the subset used by TOOL_SPECS is supported. Keep this function in
// sync with the JsonSchemaField shape above.

function fieldToZod(field: JsonSchemaField): z.ZodTypeAny {
  let base: z.ZodTypeAny;

  if (field.enum) {
    base = z.enum(field.enum as [string, ...string[]]);
  } else if (field.type === "string") {
    let s: z.ZodString = z.string();
    if (field.format === "uuid") s = s.uuid();
    else if (field.format === "email") s = s.email();
    else if (field.format === "uri") s = s.url();
    else if (field.format === "date-time") s = s.datetime();
    if (field.pattern) s = s.regex(new RegExp(field.pattern));
    base = s;
  } else if (field.type === "integer") {
    let n: z.ZodNumber = z.number().int();
    if (field.minimum !== undefined) n = n.min(field.minimum);
    if (field.maximum !== undefined) n = n.max(field.maximum);
    base = n;
  } else if (field.type === "number") {
    let n: z.ZodNumber = z.number();
    if (field.minimum !== undefined) n = n.min(field.minimum);
    if (field.maximum !== undefined) n = n.max(field.maximum);
    base = n;
  } else if (field.type === "boolean") {
    base = z.boolean();
  } else if (field.type === "array") {
    if (!field.items) throw new Error("array field missing items");
    let a = z.array(fieldToZod(field.items));
    if (field.minItems !== undefined) a = a.min(field.minItems);
    if (field.maxItems !== undefined) a = a.max(field.maxItems);
    base = a;
  } else if (field.type === "object") {
    base = z.object({}).passthrough();
  } else {
    base = z.unknown();
  }

  if (field.description) base = base.describe(field.description);
  return base;
}

/**
 * Convert a tool input JSON-Schema to a Zod raw shape ready for
 * `server.tool(name, description, shape, annotations, handler)`.
 *
 * Required fields are mandatory; non-required fields are `.optional()`.
 */
export function toZodShape(input: ToolInputSchema): Record<string, z.ZodTypeAny> {
  const required = new Set<string>(input.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(input.properties)) {
    const zodField = fieldToZod(field);
    shape[name] = required.has(name) ? zodField : zodField.optional();
  }
  return shape;
}

// ── Shared JSON-Schema fragments ─────────────────────────────────
//
// These are the literal field-level schemas used in multiple tools.
// Defined once here so descriptions cannot drift between tools.

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const F = {
  checkIn: {
    type: "string" as const,
    pattern: DATE_PATTERN,
    description:
      "Arrival date in ISO 8601 calendar format YYYY-MM-DD (e.g. '2026-07-15'). Must be today or later in the property's timezone. Must be strictly before checkOut; together they define the stay length used for pricing and availability.",
  },
  checkOut: {
    type: "string" as const,
    pattern: DATE_PATTERN,
    description:
      "Departure date in ISO 8601 calendar format YYYY-MM-DD (e.g. '2026-07-22'). Must be strictly after checkIn on the same calendar. The guest does not stay the departure night.",
  },
  guests: {
    type: "integer" as const,
    minimum: 1,
    description:
      "Total guest count as a positive integer (e.g. 2, 4, 6). Used for capacity filtering and staircase pricing tiers. Properties with maxGuests below this value are excluded from search results.",
  },
  propertyId: {
    type: "string" as const,
    format: "uuid",
    description:
      "Stable property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000'). Pass the exact UUID string — never a property name, host domain, or booking URL.",
  },
  reservationId: {
    type: "string" as const,
    format: "uuid",
    description:
      "Booking or reservation UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '7c9e6679-7425-40de-944b-e07fc1f90ae7'). Required to look up, cancel, or reschedule the same booking record.",
  },
  guestName: {
    type: "string" as const,
    description:
      "Primary guest full name as plain text (e.g. 'Anna Svensson'). Stored on the booking for host confirmation; use the name the guest provided.",
  },
  guestEmail: {
    type: "string" as const,
    format: "email",
    description:
      "Primary guest email in RFC 5322 format (e.g. 'anna@example.com'). Used for booking confirmation and host contact; must be deliverable.",
  },
  guestPhone: {
    type: "string" as const,
    description:
      "Primary guest phone in E.164 format with country code (e.g. '+46701234567'). Optional; omit when unknown. Recommended for check-in coordination.",
  },
} satisfies Record<string, JsonSchemaField>;

const REGION = {
  type: "string" as const,
  description:
    "Region, area, or destination to search within (e.g. 'Skåne', 'Kävlinge', 'Toscana', 'Bavaria'). Partial case-insensitive match. Provide at least one of region or country; omit only when country alone is sufficient.",
} satisfies JsonSchemaField;

const COUNTRY = {
  type: "string" as const,
  description:
    "Country name to filter by (e.g. 'Sweden', 'Italy', 'Morocco'). Partial case-insensitive match. Provide at least one of region or country; omit when region already narrows the destination.",
} satisfies JsonSchemaField;

// ── Property output object (shared between search tools) ─────────

const PROPERTY_LISTING_ITEM: JsonSchemaField = {
  type: "object",
  properties: {
    propertyId: { type: "string", format: "uuid", description: "Stable UUID. Pass to subsequent tools (availability, quote, checkout)." },
    name: { type: "string", description: "Property display name." },
    domain: { type: "string", description: "Host-owned domain for this property." },
    region: { type: "string", description: "Region or area." },
    city: { type: "string", description: "City or locality." },
    country: { type: "string", description: "Country." },
    maxGuests: { type: "integer", description: "Maximum guest capacity." },
    propertyType: { type: "string", description: "Property type classification." },
    currency: { type: "string", description: "ISO 4217 currency code (e.g. 'SEK', 'EUR')." },
    nights: { type: "integer", description: "Number of nights between check-in and check-out." },
    publicTotal: { type: "integer", description: "Standard website total for the date range, in minor currency units." },
    federationTotal: { type: "integer", description: "Legacy field: direct host-source total, in minor currency units. Do not label this as a HemmaBo platform, federation, OTA, marketplace, comparison, discount, or savings price in user-facing copy." },
    federationDiscountPercent: { type: "integer", description: "Legacy internal field. Do not present this as a guest-facing discount, savings, or comparison." },
    directBookingTotal: { type: "integer", description: "Preferred field for user-facing copy: direct host-source total, in minor currency units." },
    hostSourcePublicTotal: { type: "integer", description: "Preferred field for user-facing copy: public host-source total for the date range, in minor currency units." },
    directBookingDiscountPercent: { type: "integer", description: "Legacy internal field. Do not present this as a guest-facing discount, savings, or comparison." },
    packageApplied: { type: "string", description: "Package applied (e.g. week or two_weeks), if any." },
    available: { type: "boolean", description: "Always true in search results because unavailable properties are filtered out." },
    signals: {
      type: "object",
      description: "Optional. Host-declared canonical discovery flags for matching requests like dog-friendly, hot tub, crib, or hen party. Grouped: amenities / policies / suitability / setting (arrays of canonical English keys, e.g. 'allows_dogs', 'has_hot_tub', 'crib_available', 'bachelorette_party_friendly') plus bestForOccasions / targetAudience. Canonical keys — render them in the user's language. Match signals, not verified guarantees: the signed verified-stay-offer and the property page are authoritative; absence of a flag means 'not detected', not 'no'.",
      additionalProperties: true,
    },
  },
  required: ["propertyId", "name", "maxGuests", "federationTotal"],
  additionalProperties: true,
};

// ── TOOL_SPECS ───────────────────────────────────────────────────

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "hemmabo_search_properties",
    description:
      "Search available vacation rental properties by location and travel dates. Use when the user wants to find or browse places to stay. Discovery only — call get_verified_stay_offer with the host domain and same dates before the final answer so the client can render the verified stay offer widget; never quote a final price or booking link from search alone. Do NOT use when the user already has a propertyId or host domain. Returns propertyId, host domain, live availability, host-source pricing, and capacity.",
    inputSchema: {
      type: "object",
      properties: {
        region: REGION,
        country: COUNTRY,
        guests: F.guests,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
      },
      required: ["guests", "checkIn", "checkOut"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        checkIn: { type: "string", description: "Echoed check-in date (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Echoed check-out date (YYYY-MM-DD)." },
        guests: { type: "integer", description: "Echoed guest count." },
        properties: {
          type: "array",
          description: "Available properties matching the search criteria, with live host-source pricing.",
          items: PROPERTY_LISTING_ITEM,
        },
        error: { type: "string", description: "Present only when isError=true." },
      },
      additionalProperties: true,
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
      "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from hemmabo_search_properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use hemmabo_search_properties instead. Returns available=true/false with conflict details and same-month alternative date windows when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: {
          ...F.guests,
          description:
            "Optional guest count (e.g. 4). Omit when only checking date availability without pricing. When provided, alternative date windows in the response include live host-source totals for that guest count.",
        },
      },
      required: ["propertyId", "checkIn", "checkOut"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        available: { type: "boolean", description: "True if the property is bookable for the entire range." },
        reason: { type: "string", description: "Reason when available=false." },
        alternativeDates: {
          type: "array",
          description: "Nearby same-month date windows to offer when the requested dates are unavailable.",
          items: {
            type: "object",
            properties: {
              checkIn: { type: "string" },
              checkOut: { type: "string" },
              available: { type: "boolean" },
              currency: { type: "string" },
              publicTotal: { type: "number" },
              federationTotal: { type: "number" },
              federationDiscountPercent: { type: "number" },
            },
            additionalProperties: true,
          },
        },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["available"],
      additionalProperties: true,
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
      "Find vacation rental properties similar to a given property on specific dates. Use this tool after the user has selected a property (via hemmabo_search_properties) and wants to see alternatives — same region, same property type, same or larger capacity. Do NOT use for the initial search; use hemmabo_search_properties instead. Returns a list of similar available properties with live pricing, excluding the source property.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: {
          ...F.guests,
          description:
            "Optional guest count (e.g. 4). Omit to use the source property's maxGuests for matching and pricing. When provided, filters alternatives that cannot accommodate this count.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description:
            "Maximum number of similar properties to return (integer 1–20). Omit to use server default 5. Increase when the guest wants more alternatives.",
        },
      },
      required: ["propertyId", "checkIn", "checkOut"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        sourcePropertyId: { type: "string", format: "uuid", description: "The property similar listings were found for." },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        guests: { type: "integer", description: "Effective guest count used for matching and pricing." },
        count: { type: "integer", description: "Number of similar properties returned." },
        similarProperties: {
          type: "array",
          description: "Similar available properties (same region, same type, same/larger capacity), sorted by direct host-source total.",
          items: {
            type: "object",
            properties: {
              propertyId: { type: "string", format: "uuid" },
              name: { type: "string" },
              domain: { type: "string" },
              region: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              maxGuests: { type: "integer" },
              propertyType: { type: "string" },
              currency: { type: "string" },
              nights: { type: "integer" },
              publicTotal: { type: "integer" },
              federationTotal: { type: "integer" },
              federationDiscountPercent: { type: "integer" },
              packageApplied: { type: "string" },
              available: { type: "boolean" },
            },
            required: ["propertyId", "federationTotal"],
            additionalProperties: true,
          },
        },
        error: { type: "string", description: "Present only when isError=true." },
      },
      additionalProperties: true,
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
      "Compare availability and pricing for 2-10 specific properties on the same dates. Use this tool when the user is deciding between multiple properties and wants to see price and availability side by side. Do NOT use for discovery - use hemmabo_search_properties first. Returns one entry per propertyId, sorted by direct host-source total (cheapest first), with unavailable properties last. Do not present discounts or savings in guest-facing copy.",
    inputSchema: {
      type: "object",
      properties: {
        propertyIds: {
          type: "array",
          items: {
            type: "string",
            format: "uuid",
            description:
              "Single property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000'). Repeat one entry per property to compare.",
          },
          minItems: 2,
          maxItems: 10,
          description:
            "Ordered list of 2–10 property UUIDs to compare on the same dates. All IDs must come from hemmabo_search_properties; do not pass host domains, names, or booking URLs.",
        },
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: F.guests,
      },
      required: ["propertyIds", "checkIn", "checkOut", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        guests: { type: "integer" },
        count: { type: "integer", description: "Number of compared properties returned." },
        comparison: {
          type: "array",
          description: "One entry per requested propertyId, sorted by direct host-source total (cheapest first), unavailable last.",
          items: {
            type: "object",
            properties: {
              propertyId: { type: "string", format: "uuid" },
              name: { type: "string" },
              domain: { type: "string" },
              region: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              maxGuests: { type: "integer" },
              propertyType: { type: "string" },
              available: { type: "boolean" },
              currency: { type: "string" },
              nights: { type: "integer" },
              publicTotal: { type: "integer", description: "Standard website total. Absent if unavailable." },
              federationTotal: { type: "integer", description: "Legacy field: direct host-source total. Absent if unavailable." },
              gapTotal: { type: "integer" },
              federationDiscountPercent: { type: "integer" },
              packageApplied: { type: "string" },
              reason: { type: "object", description: "Availability reason object when unavailable." },
              error: { type: "string", description: "Error detail for this property when present." },
            },
            required: ["propertyId", "available"],
            additionalProperties: true,
          },
        },
        error: { type: "string", description: "Present only when isError=true." },
      },
      additionalProperties: true,
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
      "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns the final host-source total for the booking flow, per-night breakdown, and package pricing context. All prices are integers in the property's local currency (e.g. SEK).",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: F.guests,
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        guests: { type: "integer" },
        nights: { type: "integer", description: "Number of nights in the range." },
        currency: { type: "string", description: "ISO 4217 currency code." },
        publicTotal: { type: "integer", description: "Website rate total in minor currency units." },
        federationTotal: { type: "integer", description: "Legacy field: direct host-source total. Prefer directBookingTotal in user-facing copy." },
        directBookingTotal: { type: "integer", description: "Preferred user-facing field: direct host-source total." },
        hostSourcePublicTotal: { type: "integer", description: "Preferred user-facing field: public host-source total." },
        federationDiscountPercent: { type: "integer", description: "Legacy internal field. Do not present this as a guest-facing discount, savings, or comparison." },
        directBookingDiscountPercent: { type: "integer", description: "Legacy internal field. Do not present this as a guest-facing discount, savings, or comparison." },
        packageApplied: { type: "string", description: "Applied package, if any." },
        gapNight: { type: "boolean", description: "True when the stay qualifies as a gap fill." },
    gapTotal: { type: "integer", description: "Gap-night adjusted total when applicable; otherwise null." },
        gapDiscountPercent: { type: "integer", description: "Gap-night discount percentage when applied." },
        breakdown: {
          type: "object",
          description: "Detailed pricing breakdown.",
          additionalProperties: true,
        },
        error: { type: "string", description: "Present only when isError=true." },
      },
      additionalProperties: true,
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
      "Create a pending direct booking without online payment for configured non-VRP fallback deployments. Use only after explicit user confirmation, with a propertyId from search, and only when no signed VRP direct_booking_url is available. For signed VRP offers, route to the signed host-domain URL instead. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Writes a pending booking server-side; not idempotent — check hemmabo_booking_status before retrying on timeout. Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: F.guests,
        guestName: F.guestName,
        guestEmail: F.guestEmail,
        guestPhone: F.guestPhone,
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string", format: "uuid", description: "Persistent booking UUID. Use for status/cancel/reschedule." },
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        nights: { type: "integer" },
        guests: { type: "integer" },
        currency: { type: "string" },
        totalPrice: { type: "integer", description: "Final price written to the booking." },
        priceType: { type: "string", description: "Pricing mode used (federation/gap_night/package_*)." },
        packageApplied: { type: "string" },
        federationDiscountPercent: { type: "integer" },
        gapDiscountPercent: { type: "integer" },
        createdAt: { type: "string", format: "date-time" },
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"], description: "Host-node booking status. 'completed' is a protocol compatibility output only, not a status this tool writes." },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["bookingId", "status"],
      additionalProperties: true,
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
      "Create a binding price quote that locks the price for 15 minutes for configured non-VRP fallback checkout deployments. Use only when no signed direct_booking_url is available and the user explicitly asks to lock a price. Never use this for search, availability, VRP offers, rendering a stay-offer widget, or verified-offer display — use get_verified_stay_offer instead. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Writes a short-lived quote snapshot server-side. Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: { ...F.guests, description: "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        quoteId: { type: "string", description: "Snapshot ID. Pass to hemmabo_booking_checkout to lock this price." },
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        guests: { type: "integer" },
        nights: { type: "integer" },
        currency: { type: "string" },
        publicTotal: { type: "integer" },
        federationTotal: { type: "integer" },
        federationDiscountPercent: { type: "integer" },
        breakdown: { type: "object", additionalProperties: true },
        packageApplied: { type: "string" },
        gapNight: { type: "boolean" },
        gapTotal: { type: "integer" },
        gapDiscountPercent: { type: "integer" },
        validUntil: { type: "string", format: "date-time", description: "Quote expiry (ISO 8601). Typically 15 minutes after creation." },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["quoteId", "validUntil", "federationTotal"],
      additionalProperties: true,
    },
    annotations: {
      title: "Lock Price Quote",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "hemmabo_booking_checkout",
    description:
      "Create a fallback non-VRP booking and return a host-configured Stripe checkout URL. Use only after explicit user confirmation when no signed VRP direct_booking_url is available. When get_verified_stay_offer returns a signed direct_booking_url, route the guest there instead. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Creates a pending booking and Stripe session server-side; not idempotent — check hemmabo_booking_status before retrying. Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: { ...F.guests, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: F.guestName,
        guestEmail: F.guestEmail,
        guestPhone: F.guestPhone,
        quoteId: {
          type: "string",
          description:
            "Quote ID string from hemmabo_booking_negotiate (e.g. 'q_abc123'). Optional — omit to calculate a fresh host-source price at checkout. Provide when the guest locked a price within the 15-minute quote window.",
        },
        paymentMode: {
          type: "string",
          enum: ["checkout_session", "payment_intent"],
          description:
            "Stripe payment flow. 'checkout_session' (default): returns a browser redirect URL. 'payment_intent': returns client_secret for embedded/agentic payment integrations. Omit to use checkout_session.",
        },
        channel: {
          type: "string",
          enum: ["public", "federation"],
          description:
            "Pricing channel selector. 'federation' (default for agent flows): direct host-source total. 'public': standard website rate without agent channel pricing. Omit to use federation.",
        },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        reservationId: { type: "string", format: "uuid", description: "Booking UUID. Use for subsequent status/cancel/reschedule calls." },
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        nights: { type: "integer" },
        guests: { type: "integer" },
        currency: { type: "string" },
        totalPrice: { type: "integer", description: "Final total charged (or to be charged), in minor currency units." },
        paymentUrl: { type: "string", format: "uri", description: "Stripe Checkout redirect URL." },
        payment_modes: { type: "array", items: { type: "string" }, description: "Supported payment modes." },
        createdAt: { type: "string", format: "date-time" },
        mpp: { type: "object", additionalProperties: true, description: "Present when paymentMode='payment_intent'." },
        status: { type: "string", description: "Booking status (typically 'pending' until payment succeeds)." },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["reservationId", "totalPrice", "currency"],
      additionalProperties: true,
    },
    annotations: {
      title: "Checkout",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "hemmabo_booking_cancel",
    description:
      "Cancel a confirmed booking and process the Stripe refund per host cancellation policy. Use when the guest explicitly requests cancellation. Do not use for pending/unpaid bookings — those expire automatically. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Destructive and idempotent: cancelling an already-cancelled booking returns the same status. Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        reservationId: F.reservationId,
        reason: {
          type: "string",
          description:
            "Human-readable cancellation reason for the host (e.g. 'Travel plans changed', 'Flight cancelled'). Optional; omit when the guest did not give a reason.",
        },
      },
      required: ["reservationId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        reservationId: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["cancelled"], description: "Final booking status after cancellation." },
        refund: { type: "object", description: "Refund payload returned by cancel-booking edge function, when present.", additionalProperties: true },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["reservationId", "status"],
      additionalProperties: true,
    },
    annotations: {
      title: "Cancel Booking",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "hemmabo_booking_status",
    description:
      "Retrieve current status and full details of an existing booking by reservationId. Use to confirm checkout/create succeeded or before cancel/reschedule. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Read-only against the database but returns guest PII (name, email). Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        reservationId: F.reservationId,
      },
      required: ["reservationId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        reservationId: { type: "string", format: "uuid", description: "Echoed booking or reservation UUID." },
        propertyId: { type: "string", format: "uuid", description: "Property UUID associated with the booking." },
        propertyName: { type: "string", description: "Display name of the booked property." },
        propertyDomain: { type: "string", description: "Host-owned domain associated with the property." },
        checkIn: { type: "string", description: "Booked arrival date." },
        checkOut: { type: "string", description: "Booked departure date." },
        guests: { type: "integer", description: "Booked guest count." },
        guestName: { type: "string", description: "Primary guest name stored on the booking." },
        guestEmail: { type: "string", description: "Primary guest email stored on the booking." },
        currency: { type: "string", description: "ISO 4217 currency code for the booking total." },
        totalPrice: { type: "integer", description: "Total amount in minor currency units." },
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"], description: "Host-node booking status. 'completed' is a protocol compatibility output only, not the active lifecycle truth." },
        cancellationPolicy: { type: "object", description: "Host cancellation-policy details applicable to this booking.", additionalProperties: true },
        createdAt: { type: "string", format: "date-time", description: "Booking creation timestamp." },
        updatedAt: { type: "string", format: "date-time", description: "Last update timestamp for the booking record." },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["reservationId", "status"],
      additionalProperties: true,
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
      "Reschedule a confirmed or pending booking to new dates with automatic repricing and Stripe charge/refund. Use when the guest wants to change dates on an existing booking. Do not use if cancelled or if a protocol compatibility client reports completed — check hemmabo_booking_status first. Requires Authorization: Bearer token (MCP_API_KEY or OAuth). Destructive write that may charge or refund via Stripe. Rate-limited per token.",
    inputSchema: {
      type: "object",
      properties: {
        reservationId: F.reservationId,
        newCheckIn: {
          ...F.checkIn,
          description:
            "New arrival date in YYYY-MM-DD format (e.g. '2026-08-01'). Must be today or later. Must be strictly before newCheckOut.",
        },
        newCheckOut: {
          ...F.checkOut,
          description:
            "New departure date in YYYY-MM-DD format (e.g. '2026-08-08'). Must be strictly after newCheckIn.",
        },
        reason: {
          type: "string",
          description:
            "Human-readable reschedule reason for host records (e.g. 'Flight delayed', 'Extended conference'). Optional; omit when not provided by the guest.",
        },
      },
      required: ["reservationId", "newCheckIn", "newCheckOut"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        reservationId: { type: "string", format: "uuid" },
        previousDates: { type: "object", properties: { checkIn: { type: "string" }, checkOut: { type: "string" } }, additionalProperties: true },
        newDates: { type: "object", properties: { checkIn: { type: "string" }, checkOut: { type: "string" } }, additionalProperties: true },
        pricing: {
          type: "object",
          properties: {
            previousPrice: { type: "integer" },
            newPrice: { type: "integer" },
            delta: { type: "integer" },
            currency: { type: "string" },
            stripeAction: { type: "object", additionalProperties: true },
          },
          additionalProperties: true,
        },
        reason: { type: "string" },
        status: { type: "string", description: "Booking status after reschedule." },
        error: { type: "string", description: "Present only when isError=true." },
      },
      required: ["reservationId", "status"],
      additionalProperties: true,
    },
    annotations: {
      title: "Reschedule Booking",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

// ── Convenience exports ──────────────────────────────────────────

/** All 11 HemmaBo federation canonical tool names in declaration order. */
export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);
