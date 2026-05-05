/**
 * Federation MCP Server — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All pricing/availability logic lives in lib/ — single source of truth.
 * This file only handles JSON-RPC transport + tool dispatch.
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call, prompts/list, prompts/get)
 *   GET  /mcp  — transport info
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { executeTool } from "../lib/tools.js";
import { validateApiKey } from "../src/auth.js";

// ── Structured logging ───────────────────────────────────────────

const REDACT_KEYS = ["stripe_token", "spt_token", "card_number", "email", "phone", "guest_name"];

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) =>
      REDACT_KEYS.some((r) => k.toLowerCase().includes(r)) ? [k, "[redacted]"] : [k, v]
    )
  );
}

// Tool execution is shared via lib/tools.ts (single source of truth for all
// 11 tools, used by api/mcp.ts, src/stdio.ts, and src/index.ts).

// ── Server-level instructions for AI agents ──────────────────────
export const SERVER_INSTRUCTIONS = `This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.

Full booking lifecycle: search.properties (find properties) -> booking.negotiate (binding quote with quoteId) -> booking.checkout (Stripe payment) -> booking.status (check details) -> booking.reschedule / booking.cancel (modify or cancel).

Legacy shortcut: search.properties -> booking.quote -> booking.create (no payment, pending host approval).

Pricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;

// ── Config schema (all fields optional — Smithery "Optional config" requirement) ──
export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    propertyDomain: {
      type: "string",
      description: "Your vacation rental domain (e.g. 'villaakerlyckan.se'). Optional — used when connecting to a specific host node.",
    },
    region: {
      type: "string",
      description: "Default region to search in (e.g. 'Skane', 'Toscana'). Can be overridden per request.",
    },
    currency: {
      type: "string",
      description: "Preferred display currency (ISO 4217, e.g. 'EUR', 'SEK', 'USD'). Defaults to the property's native currency.",
    },
    language: {
      type: "string",
      description: "Preferred response language (ISO 639-1 code, e.g. 'en', 'sv', 'de', 'it', 'fr', 'es'). Defaults to English.",
    },
  },
  additionalProperties: false,
};

// ── Tools ────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "search.properties",
    description:
      "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use search.availability or booking.quote instead. Returns a list of available properties with propertyId, live pricing (public and federation rates), and capacity info needed for subsequent tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string", description: "Region, area, or destination name to search within. Partial match (e.g. 'Skane', 'Toscana', 'Bavaria'). At least one of region or country should be provided." },
        country: { type: "string", description: "Country name to filter by (e.g. 'Sweden', 'Italy'). Partial match. At least one of region or country should be provided." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines price tier and filters out properties with insufficient capacity." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
      },
      required: ["guests", "checkIn", "checkOut"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        checkIn: { type: "string", description: "Echoed check-in date (YYYY-MM-DD)." },
        checkOut: { type: "string", description: "Echoed check-out date (YYYY-MM-DD)." },
        guests: { type: "integer", description: "Echoed guest count." },
        properties: {
          type: "array",
          description: "Available properties matching the search criteria, with live federation pricing.",
          items: {
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
          },
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
    name: "search.availability",
    description:
      "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from search.properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use search.properties instead. Returns available=true/false with conflict details (blocked dates, existing bookings, active locks) if unavailable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID returned by search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
      },
      required: ["propertyId", "checkIn", "checkOut"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        available: { type: "boolean", description: "True if the property is bookable for the entire range." },
        reason: { type: "string", description: "Reason when available=false." },
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
    name: "search.similar",
    description:
      "Find vacation rental properties similar to a given property on specific dates. Use this tool after the user has selected a property (via search.properties) and wants to see alternatives — same region, same property type, same or larger capacity. Do NOT use for the initial search; use search.properties instead. Returns a list of similar available properties with live pricing, excluding the source property.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "UUID of the source property to find alternatives for." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Number of guests. Defaults to source property's max_guests." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max results. Default 5, max 20." },
      },
      required: ["propertyId", "checkIn", "checkOut"],
    },
    outputSchema: {
      type: "object" as const,
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
    name: "search.compare",
    description:
      "Compare availability and pricing for 2–10 specific properties on the same dates. Use this tool when the user is deciding between multiple properties and wants to see price and availability side by side. Do NOT use for discovery — use search.properties first. Returns one entry per propertyId, sorted by federation price (cheapest first), with unavailable properties last.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 2,
          maxItems: 10,
          description: "Array of 2 to 10 property UUIDs to compare side by side.",
        },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1." },
      },
      required: ["propertyIds", "checkIn", "checkOut", "guests"],
    },
    outputSchema: {
      type: "object" as const,
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
    name: "booking.quote",
    description:
      "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns publicTotal (website rate), federationTotal (direct booking discount), gapTotal (gap-night discount if applicable), per-night breakdown, and package pricing. All prices are integers in the property's local currency (e.g. SEK).",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied (staircase pricing by guest count)." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
    },
    outputSchema: {
      type: "object" as const,
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
    name: "booking.create",
    description:
      "Create a direct booking without online payment (legacy flow). Use this tool when the user wants to book without Stripe payment — the booking is created with status 'pending' and requires host approval. Do NOT use for paid bookings — use booking.checkout instead. Do NOT retry on timeout without calling booking.status first to avoid duplicate bookings. Returns bookingId, final price, and confirmation details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: { type: "string", description: "Full name of primary guest (e.g. 'Anna Svensson')." },
        guestEmail: { type: "string", format: "email", description: "Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address." },
        guestPhone: { type: "string", description: "Phone with country code (e.g. '+46701234567'). Optional but recommended for check-in coordination." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
    },
    outputSchema: {
      type: "object" as const,
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
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"], description: "Booking status — typically 'pending' until host approves." },
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
    name: "booking.negotiate",
    description:
      "Create a binding price quote that locks the price for 15 minutes. Use this tool before booking.checkout to guarantee the quoted price during payment. Do NOT skip this step if the user wants price certainty — without a quoteId, checkout calculates a fresh price that may differ. Returns quoteId (pass to booking.checkout), public and federation totals, per-night breakdown, and expiry timestamp.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        quoteId: { type: "string", description: "Snapshot ID. Pass to booking.checkout to lock this price." },
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
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "booking.checkout",
    description:
      "Create a booking with Stripe payment and return a checkout URL. Use this tool when the user is ready to pay — it creates the booking record and generates a Stripe payment page. Do NOT call twice for the same booking — check booking.status first to avoid double charges. Optionally pass quoteId from booking.negotiate to lock the price. Returns reservationId, paymentUrl (Stripe checkout page), and pricing details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        propertyId: { type: "string", format: "uuid", description: "Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        checkIn: { type: "string", description: "Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later." },
        checkOut: { type: "string", description: "Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn." },
        guests: { type: "integer", minimum: 1, description: "Total number of guests as integer >= 1 (e.g. 4)." },
        guestName: { type: "string", description: "Full name of primary guest (e.g. 'Anna Svensson')." },
        guestEmail: { type: "string", format: "email", description: "Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address." },
        guestPhone: { type: "string", description: "Phone with country code (e.g. '+46701234567'). Optional but recommended." },
        quoteId: { type: "string", description: "Quote ID from booking.negotiate to lock the price. Optional — if omitted, a fresh federation price is calculated at checkout time." },
        paymentMode: { type: "string", enum: ["checkout_session", "payment_intent"], description: "'checkout_session' (default): returns Stripe redirect URL. 'payment_intent': returns client_secret for programmatic payment (AI agent MPP flow)." },
        channel: { type: "string", enum: ["public", "federation"], description: "'federation' (default): applies direct booking discount. 'public': uses standard website rate." },
      },
      required: ["propertyId", "checkIn", "checkOut", "guests", "guestName", "guestEmail"],
    },
    outputSchema: {
      type: "object" as const,
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
      openWorldHint: false,
    },
  },
  {
    name: "booking.cancel",
    description:
      "Cancel a confirmed booking and process the Stripe refund. Use this tool when the guest explicitly requests cancellation. Do NOT use for pending/unpaid bookings — those expire automatically. Refund amount is calculated based on the host's cancellation policy. Returns cancellation confirmation with refund amount and status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID from booking.checkout or booking.create (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
        reason: { type: "string", description: "Cancellation reason for host notification (e.g. 'Travel plans changed'). Optional but recommended." },
      },
      required: ["reservationId"],
    },
    outputSchema: {
      type: "object" as const,
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
      openWorldHint: false,
    },
  },
  {
    name: "booking.status",
    description:
      "Retrieve current status and full details of an existing booking. Use this tool to check payment status, confirm a booking went through, or look up details before rescheduling or cancelling. Use after booking.checkout if unsure whether the booking succeeded. Returns booking dates, guests, price, status, property info, and cancellation policy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID from booking.checkout or booking.create (e.g. '550e8400-e29b-41d4-a716-446655440000')." },
      },
      required: ["reservationId"],
    },
    outputSchema: {
      type: "object" as const,
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
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed"] },
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
    name: "booking.reschedule",
    description:
      "Reschedule a confirmed or pending booking to new dates. Use this tool when the guest wants to change travel dates on an existing booking. Do NOT use if the booking is cancelled or completed — check booking.status first. Automatically recalculates price and handles Stripe charge (if price increased) or refund (if decreased). Returns previous dates, new dates, price delta, and Stripe transaction details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string", description: "Booking UUID to reschedule (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be in 'confirmed' or 'pending' status." },
        newCheckIn: { type: "string", description: "New arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-20'). Must be today or later." },
        newCheckOut: { type: "string", description: "New departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-27'). Must be after newCheckIn." },
        reason: { type: "string", description: "Reason for rescheduling (e.g. 'Flight delayed'). Optional but recommended for host records." },
      },
      required: ["reservationId", "newCheckIn", "newCheckOut"],
    },
    outputSchema: {
      type: "object" as const,
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
      openWorldHint: false,
    },
  },
];

// ── Prompts ──────────────────────────────────────────────────────

export const PROMPTS = [
  {
    name: "trip.plan",
    description: "Help plan a vacation rental trip. Guides the agent through the full booking lifecycle: searching properties, getting a binding quote, completing payment via Stripe checkout, and managing the booking (status checks, rescheduling, cancellation). Provide destination, dates, and guest count to get started.",
    arguments: [
      {
        name: "destination",
        description: "Where the guest wants to travel (region, city, or country). Example: 'Skane', 'Sweden', 'Toscana'.",
        required: true,
      },
      {
        name: "checkIn",
        description: "Desired check-in date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "checkOut",
        description: "Desired check-out date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "guests",
        description: "Number of guests (integer, minimum 1).",
        required: true,
      },
    ],
  },
];

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === "trip.plan") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please: (1) search for available properties, (2) show pricing with both public and direct booking rates, (3) create a binding quote with booking.negotiate, (4) proceed to booking.checkout with Stripe payment, and (5) confirm the booking status. If I need to change dates later, use booking.reschedule. If I need to cancel, use booking.cancel.`,
          },
        },
      ],
    };
  }
  return null;
}

// ── Supabase clients ─────────────────────────────────────────────

// Service-role client — bypasses RLS. Required for bookings reads + all writes.
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// Anon client — subject to RLS. Use for published property/snapshot reads.
function getSupabaseReader() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, key);
}

// Tool execution lives in lib/tools.ts — single source of truth shared with
// src/stdio.ts and src/index.ts. Transports construct their own clients and
// pass them in. Errors bubble up so each transport can apply its own
// error-handling rules unchanged.


// ── JSON-RPC handler ─────────────────────────────────────────────

async function handleJsonRpc(
  msg: { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> },
  ctx: { agent: string; ip_hint: string } = { agent: "unknown", ip_hint: "unknown" }
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: "hemmabo-mcp-server",
            version: "3.2.8",
            description: "MCP server for vacation rental direct bookings. Search properties, check availability, get real-time pricing quotes, and create bookings through the federation protocol. Supports seasonal pricing, guest-count tiers, weekly and biweekly package discounts, gap-night discounts, and host-controlled federation discounts. All data is live — never cached, never estimated.",
          },
          configSchema: CONFIG_SCHEMA,
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (params as { name: string })?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      const start = Date.now();
      let ok = true;
      let errMsg: string | undefined;
      try {
        const result = await executeTool(toolName, toolArgs, {
          supabase: getSupabase(),
          reader: getSupabaseReader(),
        });
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        ok = false;
        errMsg = err instanceof Error ? err.message : "Internal error";
        return { jsonrpc: "2.0", id, error: { code: -32603, message: errMsg } };
      } finally {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          tool: toolName,
          params: sanitizeParams(toolArgs),
          duration_ms: Date.now() - start,
          result: ok ? "ok" : "error",
          error_msg: errMsg,
          agent: ctx.agent,
          ip_hint: ctx.ip_hint,
        }));
      }
    }

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };

    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };

    case "prompts/get": {
      const promptName = (params as { name: string })?.name;
      const promptArgs = (params as { arguments?: Record<string, string> })?.arguments ?? {};
      const result = getPromptMessages(promptName, promptArgs);
      if (!result) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
      }
      return { jsonrpc: "2.0", id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Origin is intentionally unrestricted — MCP clients (Claude Desktop, Smithery,
  // Glama) are not browsers and do not send an Origin header. Browser-based CSRF
  // is mitigated by requiring the Authorization header on all POST requests:
  // browsers cannot send custom headers cross-origin without a preflight, and the
  // preflight response does not grant credentials, so unauthenticated cross-site
  // POSTs are blocked at the browser level.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: "3.2.8" });
  if (req.method === "DELETE") return res.status(202).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Validate API key on tool execution requests only.
  // initialize and tools/list are allowed without auth so MCP registries
  // (Glama, Smithery inspector) can discover tools without credentials.
  // tools/call requires auth — this is where data is read and bookings are made.
  const requestMethod = Array.isArray(req.body) ? req.body[0]?.method : req.body?.method;
  const requiresAuth = requestMethod === "tools/call";
  if (requiresAuth) {
    const authErr = validateApiKey(req.headers["authorization"]);
    if (authErr) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: `${authErr}. Pass your API key as: Authorization: Bearer <key>` },
      });
    }
  }

  const ctx = {
    agent: ((req.headers["user-agent"] as string | undefined) ?? "unknown").slice(0, 80),
    ip_hint: ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0]?.trim() || "unknown",
  };

  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = [];
      for (const msg of body) {
        const result = await handleJsonRpc(msg, ctx);
        if (result !== null) results.push(result);
      }
      if (results.length === 0) return res.status(202).end();
      return res.json(results);
    }

    const result = await handleJsonRpc(body, ctx);
    if (result === null) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("MCP handler error:", message);
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
  }
}
