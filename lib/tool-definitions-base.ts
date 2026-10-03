/**
 * Single source of truth for the 2 HemmaBo federation MCP tools.
 *
 * Background (#63 / ADR-0001 §3):
 *   Tool definitions used to live in three places — api/mcp.ts TOOLS array,
 *   src/index.ts server.tool() calls, src/stdio.ts server.tool() calls.
 *   Only the api/mcp.ts copy was contract-tested. The other two could drift
 *   silently (different schemas, different descriptions, missing tools).
 *
 *   This module exports TOOL_SPECS as the canonical declaration. The MCP
 *   transport derives its wire format from it:
 *     - api/mcp.ts: re-exports TOOLS = toMcpTool(spec) for tools/list
 *
 *   A drift-guard test (src/tool-definitions.singleton.test.ts) enforces
 *   that no other module declares its own tool list and that api/mcp.ts
 *   stays in lock-step with TOOL_SPECS.
 *
 * Schema model:
 *   inputSchema and outputSchema are JSON-Schema (draft-07 subset). The
 *   subset uses: type (object/string/integer/number/boolean/array, or a
 *   [type, "null"] list for a nullable output field), format
 *   (uuid/email/date-time/uri), pattern, enum, minimum/maximum, minItems/
 *   maxItems, properties, items, required, additionalProperties. This is
 *   intentionally narrow so toZodShape() can be a tiny pure function.
 */

import { z } from "zod";
// ── JSON-Schema field type (the subset we use) ───────────────────

export type JsonSchemaType = "object" | "string" | "integer" | "number" | "boolean" | "array" | "null";

export interface JsonSchemaField {
  /** One type, or a type list for a nullable output field (e.g. ["string", "null"]). */
  type?: JsonSchemaType | readonly JsonSchemaType[];
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
} satisfies Record<string, JsonSchemaField>;

const REGION = {
  type: "string" as const,
  description:
    "Region, area, or destination to search within (e.g. 'Skåne', 'Kävlinge', 'Toscana', 'Bavaria'). Partial case-insensitive match against region, city, and country. Optional — omit both region and country and the search spans every published property.",
} satisfies JsonSchemaField;

const COUNTRY = {
  type: "string" as const,
  description:
    "Country name to filter by (e.g. 'Sweden', 'Italy', 'Morocco'). Partial case-insensitive match against the country field. Optional — omit both region and country and the search spans every published property.",
} satisfies JsonSchemaField;

// ── Property output object (shared between search tools) ─────────

const PROPERTY_LISTING_ITEM: JsonSchemaField = {
  type: "object",
  properties: {
    propertyId: { type: "string", format: "uuid", description: "Stable UUID. Pass to subsequent tools (availability)." },
    name: { type: "string", description: "Property display name." },
    domain: { type: "string", description: "Host-owned domain for this property." },
    booking_url: { type: ["string", "null"], format: "uri", description: "The host's own booking URL: https:// plus the host-owned domain. Null when the property has no domain." },
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
      description: "Optional. Host-declared canonical discovery flags for matching requests like dog-friendly, hot tub, crib, or hen party. Grouped: amenities / policies / suitability / setting (arrays of canonical English keys, e.g. 'allows_dogs', 'has_hot_tub', 'crib_available', 'bachelorette_party_friendly') plus bestForOccasions / targetAudience, plus policies_negated: the host's EXPLICIT NOs from the claims ledger (e.g. 'pets_cats' there means cats are not allowed — relay as a clear, friendly no). Canonical keys — render them in the user's language. Match signals, not verified guarantees: the signed verified-stay-offer and the property page are authoritative; absence of a flag from both the affirmed groups and policies_negated means UNKNOWN, not 'no' — recommend asking the host.",
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
      "Search available vacation rental properties by location and travel dates. Use when the user wants to find or browse places to stay. Discovery only — call get_verified_stay_offer with the host domain and same dates before the final answer so the client can render the verified stay offer widget; never quote a final price or booking link from search alone. Do NOT use when the user already has a propertyId or host domain. Returns propertyId, host domain, live availability, host-source pricing, and capacity. Parameters combine as one filter with guests and the checkIn/checkOut range (checkIn strictly before checkOut): region matches broadly against region, city, and country names, while country matches the country field alone — omit both and the search spans every published property. Capacity misses are excluded; date-unavailable matches return separately in unavailableMatches with up to three alternative windows. Booking and payment happen only on the host's own domain, at the signed direct_booking_url; this server has no booking, checkout, or payment step.",
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
      "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from hemmabo_search_properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use hemmabo_search_properties instead. Read-only, open to anonymous callers (no Bearer token), and rate-limited: checking availability never places a hold or reserves dates. Returns available=true/false with conflict details and, when unavailable, the host node's own next available window (alternativeDates, at most one entry — the same window the node's /api/availability reports, never a platform-invented date); a stale inbound calendar sync blocks an available answer (fails closed with calendar_freshness) instead of guessing. Omit guests to check dates only; pass it to price the alternative windows and to gate capacity — counts above the property's maximum return available=false (guests_exceed_max) with no alternatives. Stays shorter than the host's effective minimum nights return available=false with reasonCode min_nights_violation — extend the stay rather than shifting dates. The verdict always matches the host node's own availability API. Booking and payment happen only on the host's own domain, at the signed direct_booking_url; this server has no booking, checkout, or payment step.",
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
          description: "The host node's own next available window (at most one) to offer when the requested dates are unavailable — identical to the node's /api/availability nextAvailable. Empty when the node offers none.",
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
        calendar_freshness: {
          type: "object",
          description:
            "Incoming OTA calendar-sync freshness at answer time. The same object is embedded in the error payload when a stale calendar blocks the call — declared here so agents can treat it as a first-class field in both outcomes.",
          additionalProperties: true,
        },
        channel_mirror: {
          type: "object",
          description:
            "Outbound channel-manager mirror heartbeat for the host's mapped external channel (status: current|stale|partial|error|not_connected). Informational only — it never affects `available`; the host node is the source of truth for these dates.",
          additionalProperties: true,
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
];

// ── Convenience exports ──────────────────────────────────────────

/** The 2 HemmaBo federation canonical tool names in declaration order. */
export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);
