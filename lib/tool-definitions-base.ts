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
 *       server.tool(name, description, toZodShape(inputSchema), handler)
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
 * `server.tool(name, description, shape, handler)`.
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
      "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later.",
  },
  checkOut: {
    type: "string" as const,
    pattern: DATE_PATTERN,
    description:
      "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn.",
  },
  guests: {
    type: "integer" as const,
    minimum: 1,
    description:
      "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied (staircase pricing by guest count).",
  },
  propertyId: {
    type: "string" as const,
    format: "uuid",
    description:
      "Property UUID from hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000').",
  },
  reservationId: {
    type: "string" as const,
    description:
      "Booking UUID from hemmabo_booking_checkout or hemmabo_booking_create (e.g. '550e8400-e29b-41d4-a716-446655440000').",
  },
  guestName: {
    type: "string" as const,
    description: "Full name of primary guest (e.g. 'Anna Svensson').",
  },
  guestEmail: {
    type: "string" as const,
    format: "email",
    description:
      "Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address.",
  },
  guestPhone: {
    type: "string" as const,
    description:
      "Phone with country code (e.g. '+46701234567'). Optional but recommended for check-in coordination.",
  },
} satisfies Record<string, JsonSchemaField>;

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
    federationTotal: { type: "integer", description: "Direct-booking total for AI agents (with host discount), in minor currency units." },
    federationDiscountPercent: { type: "integer", description: "Host-configured federation discount percentage." },
    packageApplied: { type: "string", description: "Package applied (e.g. week or two_weeks), if any." },
    available: { type: "boolean", description: "Always true in search results because unavailable properties are filtered out." },
  },
  required: ["propertyId", "name", "maxGuests", "federationTotal"],
  additionalProperties: true,
};

// ── TOOL_SPECS ───────────────────────────────────────────────────

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "hemmabo_search_properties",
    description:
      "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use hemmabo_search_availability or hemmabo_booking_quote instead. Returns a list of available properties with propertyId, live pricing (public and federation rates), and capacity info needed for subsequent tools.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Region, area, or destination name to search within. Partial match (e.g. 'Skane', 'Toscana', 'Bavaria'). At least one of region or country should be provided." },
        country: { type: "string", description: "Country name to filter by (e.g. 'Sweden', 'Italy'). Partial match. At least one of region or country should be provided." },
        guests: { ...F.guests, description: "Total number of guests as integer >= 1 (e.g. 4). Determines price tier and filters out properties with insufficient capacity." },
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
          description: "Available properties matching the search criteria, with live federation pricing.",
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
    _meta: {
      // ChatGPT Apps SDK: bind this tool's output to the property-card widget.
      "openai/outputTemplate": "ui://hemmabo/property-card",
    },
  },
  {
    name: "hemmabo_search_availability",
    description:
      "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from hemmabo_search_properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use hemmabo_search_properties instead. Returns available=true/false with conflict details and same-month alternative date windows when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: { ...F.propertyId, description: "Property UUID returned by hemmabo_search_properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: { ...F.guests, description: "Optional guest count. When provided, alternative date windows include live pricing." },
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
        propertyId: { ...F.propertyId, description: "UUID of the source property to find alternatives for." },
        checkIn: { ...F.checkIn, description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
        checkOut: { ...F.checkOut, description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { ...F.guests, description: "Number of guests. Defaults to source property's max_guests." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max results. Default 5, max 20." },
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
          description: "Similar available properties (same region, same type, same/larger capacity), sorted by federation price.",
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
      "Compare availability and pricing for 2–10 specific properties on the same dates. Use this tool when the user is deciding between multiple properties and wants to see price and availability side by side. Do NOT use for discovery — use hemmabo_search_properties first. Returns one entry per propertyId, sorted by federation price (cheapest first), with unavailable properties last.",
    inputSchema: {
      type: "object",
      properties: {
        propertyIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 2,
          maxItems: 10,
          description: "Array of 2 to 10 property UUIDs to compare side by side.",
        },
        checkIn: { ...F.checkIn, description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
        checkOut: { ...F.checkOut, description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { ...F.guests, description: "Total number of guests as integer >= 1." },
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
          description: "One entry per requested propertyId, sorted by federation price (cheapest first), unavailable last.",
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
              federationTotal: { type: "integer", description: "Direct-booking total. Absent if unavailable." },
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
      "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns publicTotal (website rate), federationTotal (direct booking discount), gapTotal (gap-night discount if applicable), per-night breakdown, and package pricing. All prices are integers in the property's local currency (e.g. SEK).",
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
        federationTotal: { type: "integer", description: "Direct-booking total (host-controlled discount applied)." },
        federationDiscountPercent: { type: "integer", description: "Host-configured federation discount percentage." },
        packageApplied: { type: "string", description: "Applied package, if any." },
        gapNight: { type: "boolean", description: "True when the stay qualifies as a gap fill." },
        gapTotal: { type: "integer", description: "Gap-night discounted total when applicable; otherwise null." },
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
      "Create a direct booking without online payment (legacy flow). Use this tool when the user wants to book without Stripe payment — the booking is created with status 'pending' and requires host approval. Do NOT use for paid bookings — use hemmabo_booking_checkout instead. Do NOT retry on timeout without calling hemmabo_booking_status first to avoid duplicate bookings. Returns bookingId, final price, and confirmation details.",
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
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"], description: "Host-node booking status. 'completed' is a legacy/protocol compatibility output only, not a status this tool writes." },
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
      "Create a binding price quote that locks the price for 15 minutes. Use this tool before hemmabo_booking_checkout to guarantee the quoted price during payment. Do NOT skip this step if the user wants price certainty — without a quoteId, checkout calculates a fresh price that may differ. Returns quoteId (pass to hemmabo_booking_checkout), public and federation totals, per-night breakdown, and expiry timestamp.",
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
      title: "Negotiate Offer",
      readOnlyHint: false,
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
        propertyId: F.propertyId,
        checkIn: F.checkIn,
        checkOut: F.checkOut,
        guests: { ...F.guests, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: F.guestName,
        guestEmail: F.guestEmail,
        guestPhone: { ...F.guestPhone, description: "Phone with country code (e.g. '+46701234567'). Optional but recommended." },
        quoteId: { type: "string", description: "Quote ID from hemmabo_booking_negotiate to lock the price. Optional — if omitted, a fresh federation price is calculated at checkout time." },
        paymentMode: { type: "string", enum: ["checkout_session", "payment_intent"], description: "'checkout_session' (default): returns Stripe redirect URL. 'payment_intent': returns client_secret for programmatic payment (AI agent MPP flow)." },
        channel: { type: "string", enum: ["public", "federation"], description: "'federation' (default): applies direct booking discount. 'public': uses standard website rate." },
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
      "Cancel a confirmed booking and process the Stripe refund. Use this tool when the guest explicitly requests cancellation. Do NOT use for pending/unpaid bookings — those expire automatically. Refund amount is calculated based on the host's cancellation policy. Returns cancellation confirmation with refund amount and status.",
    inputSchema: {
      type: "object",
      properties: {
        reservationId: F.reservationId,
        reason: { type: "string", description: "Cancellation reason for host notification (e.g. 'Travel plans changed'). Optional but recommended." },
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
      "Retrieve current status and full details of an existing booking. Use this tool to check payment status, confirm a booking went through, or look up details before rescheduling or cancelling. Use after hemmabo_booking_checkout if unsure whether the booking succeeded. Returns booking dates, guests, price, status, property info, and cancellation policy.",
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
        reservationId: { type: "string", format: "uuid" },
        propertyId: { type: "string", format: "uuid" },
        propertyName: { type: "string" },
        propertyDomain: { type: "string" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        guests: { type: "integer" },
        guestName: { type: "string" },
        guestEmail: { type: "string" },
        currency: { type: "string" },
        totalPrice: { type: "integer", description: "Total amount in minor currency units." },
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"], description: "Host-node booking status. 'completed' is a legacy/protocol compatibility output only, not the active lifecycle truth." },
        cancellationPolicy: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
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
      "Reschedule a confirmed or pending booking to new dates. Use this tool when the guest wants to change travel dates on an existing booking. Do NOT use if the booking is cancelled, or if a legacy/protocol client reports completed — check hemmabo_booking_status first. Automatically recalculates price and handles Stripe charge (if price increased) or refund (if decreased). Returns previous dates, new dates, price delta, and Stripe transaction details.",
    inputSchema: {
      type: "object",
      properties: {
        reservationId: { ...F.reservationId, description: "Booking UUID to reschedule (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be in 'confirmed' or 'pending' status." },
        newCheckIn: { ...F.checkIn, description: "New arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-20'). Must be today or later." },
        newCheckOut: { ...F.checkOut, description: "New departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-27'). Must be after newCheckIn." },
        reason: { type: "string", description: "Reason for rescheduling (e.g. 'Flight delayed'). Optional but recommended for host records." },
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
