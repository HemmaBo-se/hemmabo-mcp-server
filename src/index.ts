/**
 * MCP Server — Federation Protocol
 *
 * Infrastructure for independent hosts. Each property is its own node
 * (source of truth). This server reads real data — never mocks, never guesses.
 *
 * Transport: Streamable HTTP (required for Smithery Gateway)
 * Data: Supabase (property, pricing, availability, bookings)
 *
 * Pricing flow:
 *   Google/website visitor → public_total
 *   Vera AI / federation partner (at booking) → federation_total
 *   Gap night (calendar context) → gap_total
 *
 * The host controls the federation discount via direct_booking_discount.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { executeTool } from "../lib/tools.js";
import { validateApiKey } from "./auth.js";
import { PROMPTS as CATALOG_PROMPTS, TOOLS as CATALOG_TOOLS } from "../api/mcp.js";

// Tool execution is shared via lib/tools.ts (single source of truth for all
// 11 tools, used by api/mcp.ts, src/stdio.ts, and src/index.ts).

// ── Shared validators ──────────────────────────────────────────────

/** Accepts only YYYY-MM-DD. Rejects free-text, SQL fragments, and partial dates. */
const zISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

// ── Environment ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Graceful degradation: allow server to start without DB for validation/testing
// Service-role client — bypasses RLS. Required for bookings reads + all writes.
let supabase: SupabaseClient | null = null;
// Anon client — subject to RLS. Used for published property/snapshot reads.
// Falls back to service-role if SUPABASE_ANON_KEY is not set (matches stdio.ts).
let reader: SupabaseClient | null = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠ Running without database — tools will return errors until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  reader = createClient(SUPABASE_URL, SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_KEY);
  console.log("✓ Database connected");
}

// ── MCP Server ─────────────────────────────────────────────────────

/**
 * Server instructions (for documentation):
 * 
 * This MCP server provides real-time vacation rental data for independent property hosts.
 * All data is live from the property's own database — never cached, never estimated.
 *
 * Full booking lifecycle: search.properties (find properties) -> booking.negotiate (binding quote with quoteId)
 * -> booking.checkout (Stripe payment) -> booking.status (check details) -> booking.reschedule / booking.cancel (modify or cancel).
 *
 * Legacy shortcut: search.properties -> booking.quote -> booking.create (no payment, pending host approval).
 *
 * Pricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6).
 * Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week)
 * are applied automatically. Federation discount (direct booking rate) is host-controlled.
 *
 * Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).
 */
const server = new McpServer(
  {
    name: "hemmabo-mcp-server",
    version: "3.2.8",
    description: "MCP server for vacation rental direct bookings. Search properties, check availability, get real-time pricing quotes, and create bookings through the federation protocol. Supports seasonal pricing, guest-count tiers, weekly and biweekly package discounts, gap-night discounts, and host-controlled federation discounts. All data is live — never cached, never estimated.",
  },
  {
    instructions: "This MCP server provides real-time vacation rental data for independent property hosts. All data is live from the property's own database — never cached, never estimated.\n\nFull booking lifecycle: search.properties (find properties) -> booking.negotiate (binding quote with quoteId) -> booking.checkout (Stripe payment) -> booking.status (check details) -> booking.reschedule / booking.cancel (modify or cancel).\n\nLegacy shortcut: search.properties -> booking.quote -> booking.create (no payment, pending host approval).\n\nPricing tiers: Prices scale by guest count (staircase model — e.g. 1-2 guests, 3-4, 5-6). Seasonal rates (high/low), weekend premiums (Fri+Sat only), and package discounts (7-night week, 14-night two-week) are applied automatically. Federation discount (direct booking rate) is host-controlled.\n\nDates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).",
  }
);

// ── Structured logging ──────────────────────────────────────────────
// Wrapped once around server.tool() so every registered tool is auto-instrumented.
// Per-request agent/ip_hint is propagated via AsyncLocalStorage (populated by /mcp handler).

const REDACT_KEYS = ["stripe_token", "spt_token", "card_number", "email", "phone", "guest_name"];

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) =>
      REDACT_KEYS.some((r) => k.toLowerCase().includes(r)) ? [k, "[redacted]"] : [k, v]
    )
  );
}

type LogCtx = { agent: string; ip_hint: string; sessionId: string };
const requestContext = new AsyncLocalStorage<LogCtx>();

// ── Session tracking + intent classification ───────────────────────

interface SessionState {
  tools: string[];
  firstSeen: number;
  lastSeen: number;
  propertyId?: string;
  checkIn?: string;
  checkOut?: string;
}

type Intent =
  | "browsing"       // search → stop
  | "comparing"      // quote × 3+ without checkout
  | "ready_to_book"  // quote → checkout
  | "completed"      // checkout → status
  | "abandoned"      // quote → >30 min inactivity
  | "unknown";

// In-memory store — resets on cold start, intentional
const sessionStore = new Map<string, SessionState>();

function classifyIntent(tools: string[], lastSeen: number): Intent {
  const hasStatus   = tools.includes("booking.status");
  const hasCheckout = tools.includes("booking.checkout");
  const quoteCount  = tools.filter(t => t === "booking.quote" || t === "booking.negotiate").length;
  const hasSearch   = tools.some(t => t.includes("search"));
  const hasQuote    = quoteCount > 0;
  const idleMs      = Date.now() - lastSeen;

  if (hasStatus)                              return "completed";
  if (hasCheckout)                            return "ready_to_book";
  if (hasQuote && idleMs > 30 * 60 * 1000)   return "abandoned";
  if (quoteCount >= 3)                        return "comparing";
  if (hasSearch && !hasQuote)                 return "browsing";
  return "unknown";
}

// Cleanup sessions older than 2 hours — runs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of sessionStore.entries()) {
    if (session.lastSeen < cutoff) sessionStore.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── Tool wrapper ───────────────────────────────────────────────────

const _originalServerTool = server.tool.bind(server);
(server as unknown as { tool: unknown }).tool = (
  name: string,
  description: string,
  schema: unknown,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
) => {
  const wrapped = async (args: Record<string, unknown>, extra: unknown) => {
    const start = Date.now();
    let ok = true;
    let errMsg: string | undefined;
    try {
      return await handler(args, extra);
    } catch (err) {
      ok = false;
      errMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const ctx = requestContext.getStore() ?? { agent: "unknown", ip_hint: "unknown", sessionId: "anonymous" };

      // Update session state
      const session = sessionStore.get(ctx.sessionId) ?? {
        tools: [], firstSeen: Date.now(), lastSeen: Date.now(),
      };
      session.tools.push(name);
      session.lastSeen = Date.now();
      if (args.property_id) session.propertyId = args.property_id as string;
      if (args.propertyId)  session.propertyId = args.propertyId as string;
      if (args.check_in)    session.checkIn    = args.check_in as string;
      if (args.checkIn)     session.checkIn    = args.checkIn as string;
      if (args.check_out)   session.checkOut   = args.check_out as string;
      if (args.checkOut)    session.checkOut   = args.checkOut as string;
      sessionStore.set(ctx.sessionId, session);

      console.log(JSON.stringify({
        ts:            new Date().toISOString(),
        tool:          name,
        params:        sanitizeParams(args ?? {}),
        duration_ms:   Date.now() - start,
        result:        ok ? "ok" : "error",
        error_msg:     errMsg,
        agent:         ctx.agent,
        ip_hint:       ctx.ip_hint,
        session_id:    ctx.sessionId,
        session_depth: session.tools.length,
        intent:        classifyIntent(session.tools, session.lastSeen),
        property_id:   session.propertyId ?? null,
      }));
    }
  };
  return (_originalServerTool as unknown as (
    n: string, d: string, s: unknown, h: typeof wrapped
  ) => unknown)(name, description, schema, wrapped);
};

// ── Tool: search.properties ────────────────────────────────────────

server.tool(
  "search.properties",
  "Search available vacation rental properties by location and travel dates. Use this tool when the user wants to find or browse properties — it is the entry point for all booking flows. Do NOT use if the user already has a specific propertyId; use search.availability or booking.quote instead. Returns a list of available properties with propertyId, live pricing, and capacity info needed for subsequent tools.",
  {
    region: z.string().optional().describe("Region, area, or destination name to search within. Partial match (e.g. 'Skåne', 'Toscana'). At least one of region or country should be provided."),
    country: z.string().optional().describe("Country name to filter by (e.g. 'Sweden', 'Italy'). Partial match. At least one of region or country should be provided."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines price tier and filters out properties with insufficient capacity."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("search.properties", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: search.availability ───────────────────────────────────────

server.tool(
  "search.availability",
  "Check whether a specific property is available for the requested dates. Use this tool after the user has selected a property from search.properties and wants to confirm availability before getting a quote. Do NOT use for general browsing — use search.properties instead. Returns available=true/false with conflict details (blocked dates, existing bookings, active locks) if unavailable.",
  {
    propertyId: z.string().uuid().describe("Property UUID returned by search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("search.availability", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: search.similar ───────────────────────────────────────────

server.tool(
  "search.similar",
  "Find vacation rental properties similar to a given property on specific dates. Use this tool after the user has selected a property (via search.properties) and wants to see alternatives — same region, same property type, same or larger capacity. Do NOT use for the initial search; use search.properties instead. Returns a list of similar available properties with live pricing, excluding the source property.",
  {
    propertyId: z.string().uuid().describe("UUID of the source property to find alternatives for (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).optional().describe("Number of guests. Defaults to the source property's max_guests if omitted."),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum number of similar properties to return. Default 5, max 20."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("search.similar", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: search.compare ──────────────────────────────────────

server.tool(
  "search.compare",
  "Compare availability and pricing for 2–10 specific properties on the same dates. Use this tool when the user is deciding between multiple properties and wants to see price and availability side by side. Do NOT use for discovery — use search.properties first. Returns one entry per propertyId, sorted by federation price (cheapest first), with unavailable properties last.",
  {
    propertyIds: z.array(z.string().uuid()).min(2).max(10).describe("Array of 2 to 10 property UUIDs to compare side by side."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("search.compare", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: booking.quote ──────────────────────────────────────

server.tool(
  "booking.quote",
  "Get a detailed pricing quote for a specific property, dates, and guest count. Use this tool after confirming availability to show the user exact pricing before booking. Do NOT use before checking availability — the quote may be invalid if dates are unavailable. Returns publicTotal (website rate), federationTotal (direct booking discount), gapTotal (gap-night discount if applicable), per-night breakdown, and package pricing. All prices are integers in the property's local currency (e.g. SEK).",
  {
    propertyId: z.string().uuid().describe("Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied (staircase pricing by guest count)."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("booking.quote", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: booking.create ───────────────────────────────────────────

server.tool(
  "booking.create",
  "Create a direct booking without online payment (legacy flow). Use this tool when the user wants to book without Stripe payment — the booking is created with status 'pending' and requires host approval. Do NOT use for paid bookings — use booking.checkout instead. Do NOT retry on timeout without calling booking.status first to avoid duplicate bookings. Returns bookingId, final price, and confirmation details.",
  {
    propertyId: z.string().uuid().describe("Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4)."),
    guestName: z.string().describe("Full name of primary guest (e.g. 'Anna Svensson')."),
    guestEmail: z.string().email().describe("Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address."),
    guestPhone: z.string().optional().describe("Phone with country code (e.g. '+46701234567'). Optional but recommended for check-in coordination."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("booking.create", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: booking.negotiate ──────────────────────────────────────────

server.tool(
  "booking.negotiate",
  "Create a binding price quote that locks the price for 15 minutes. Use this tool before booking.checkout to guarantee the quoted price during payment. Do NOT skip this step if the user wants price certainty — without a quoteId, checkout calculates a fresh price that may differ. Returns quoteId (pass to booking.checkout), public and federation totals, per-night breakdown, and expiry timestamp.",
  {
    propertyId: z.string().uuid().describe("Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4). Determines which price tier is applied."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("booking.negotiate", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: booking.checkout ─────────────────────────────────────────────────

server.tool(
  "booking.checkout",
  "Create a booking with Stripe payment and return a checkout URL. Use this tool when the user is ready to pay — it creates the booking record and generates a Stripe payment page. Do NOT call twice for the same booking — check booking.status first to avoid double charges. Optionally pass quoteId from booking.negotiate to lock the price. Returns reservationId, paymentUrl (Stripe checkout page), and pricing details.",
  {
    propertyId: z.string().uuid().describe("Property UUID from search.properties (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    checkIn: zISODate.describe("Arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-15'). Must be today or later."),
    checkOut: zISODate.describe("Departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-22'). Must be after checkIn."),
    guests: z.number().int().min(1).describe("Total number of guests as integer >= 1 (e.g. 4)."),
    guestName: z.string().describe("Full name of primary guest (e.g. 'Anna Svensson')."),
    guestEmail: z.string().email().describe("Email for booking confirmation (e.g. 'anna@example.com'). Must be a valid email address."),
    guestPhone: z.string().optional().describe("Phone with country code (e.g. '+46701234567'). Optional but recommended."),
    quoteId: z.string().optional().describe("Quote ID from booking.negotiate to lock the price. Optional — if omitted, a fresh federation price is calculated at checkout time."),
    paymentMode: z.enum(["checkout_session", "payment_intent"]).optional().describe("'checkout_session' (default): returns Stripe redirect URL. 'payment_intent': returns client_secret for programmatic payment (AI agent MPP flow)."),
    channel: z.enum(["public", "federation"]).optional().describe("'federation' (default): applies direct booking discount. 'public': uses standard website rate."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    try {
      return await executeTool("booking.checkout", args as Record<string, unknown>, { supabase, reader });
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Checkout failed" }) }], isError: true };
    }
  }
);

// ── Tool: booking.cancel ───────────────────────────────────────────

server.tool(
  "booking.cancel",
  "Cancel a confirmed booking and process the Stripe refund. Use this tool when the guest explicitly requests cancellation. Do NOT use for pending/unpaid bookings — those expire automatically. Refund amount is calculated based on the host's cancellation policy. Returns cancellation confirmation with refund amount and status.",
  {
    reservationId: z.string().describe("Booking UUID from booking.checkout or booking.create (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
    reason: z.string().optional().describe("Cancellation reason for host notification (e.g. 'Travel plans changed'). Optional but recommended."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    try {
      return await executeTool("booking.cancel", args as Record<string, unknown>, { supabase, reader });
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Cancellation failed" }) }], isError: true };
    }
  }
);

// ── Tool: booking.status ───────────────────────────────────────

server.tool(
  "booking.status",
  "Retrieve current status and full details of an existing booking. Use this tool to check payment status, confirm a booking went through, or look up details before rescheduling or cancelling. Use after booking.checkout if unsure whether the booking succeeded. Returns booking dates, guests, price, status, property info, and cancellation policy.",
  {
    reservationId: z.string().describe("Booking UUID from booking.checkout or booking.create (e.g. '550e8400-e29b-41d4-a716-446655440000')."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    return executeTool("booking.status", args as Record<string, unknown>, { supabase, reader });
  }
);

// ── Tool: booking.reschedule ───────────────────────────────────────

server.tool(
  "booking.reschedule",
  "Reschedule a confirmed or pending booking to new dates. Use this tool when the guest wants to change travel dates on an existing booking. Do NOT use if the booking is cancelled or completed — check booking.status first. Automatically recalculates price and handles Stripe charge (if price increased) or refund (if decreased). Returns previous dates, new dates, price delta, and Stripe transaction details.",
  {
    reservationId: z.string().describe("Booking UUID to reschedule (e.g. '550e8400-e29b-41d4-a716-446655440000'). Must be in 'confirmed' or 'pending' status."),
    newCheckIn: zISODate.describe("New arrival date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-20'). Must be today or later."),
    newCheckOut: zISODate.describe("New departure date in ISO 8601 format (YYYY-MM-DD, e.g. '2026-07-27'). Must be after newCheckIn."),
    reason: z.string().optional().describe("Reason for rescheduling (e.g. 'Flight delayed'). Optional but recommended for host records."),
  },
  async (args) => {
    if (!supabase || !reader) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }) }], isError: true };
    }
    try {
      return await executeTool("booking.reschedule", args as Record<string, unknown>, { supabase, reader });
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.message || "Reschedule failed" }) }], isError: true };
    }
  }
);

// ── Prompt: trip.plan ─────────────────────────────────────────────────────
server.prompt(
  "trip.plan",
  "Help plan a vacation rental trip. Guides the agent through the full booking lifecycle: searching properties, getting a binding quote, completing payment via Stripe checkout, and managing the booking (status checks, rescheduling, cancellation). Provide destination, dates, and guest count to get started.",
  {
    destination: z.string().describe("Where the guest wants to travel (region, city, or country). Example: 'Skane', 'Sweden', 'Toscana'."),
    checkIn: zISODate.describe("Desired check-in date in YYYY-MM-DD format."),
    checkOut: zISODate.describe("Desired check-out date in YYYY-MM-DD format."),
    guests: z.string().describe("Number of guests (integer, minimum 1)."),
  },
  async ({ destination, checkIn, checkOut, guests }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I want to plan a trip to ${destination || "a vacation destination"} from ${checkIn || "TBD"} to ${checkOut || "TBD"} for ${guests || "2"} guests. Please: (1) search for available properties, (2) show pricing with both public and direct booking rates, (3) create a binding quote with booking.negotiate, (4) proceed to booking.checkout with Stripe payment, and (5) confirm the booking status. If I need to change dates later, use booking.reschedule. If I need to cancel, use booking.cancel.`,
          },
        },
      ],
    };
  }
);

// ── HTTP Server (Streamable HTTP Transport) ────────────────────────

const app = express();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "3.2.8" });
});

// MCP endpoint
app.all("/mcp", async (req, res) => {
  // MCP-09: auth gate. Grövre än api/mcp.ts — där kontrolleras endast
  // tools/call via inspektion av den förparsade JSON-RPC-bodyn. Här kan vi
  // inte inspektera method före StreamableHTTPServerTransport tar över
  // utan att buffra bodyn (vilket skulle kräva transport-refactor, ej i
  // MCP-09-scope). Vi kräver därför Authorization på alla POST /mcp när
  // MCP_API_KEY är satt. GET/OPTIONS/DELETE och öppet läge (ingen nyckel
  // satt) lämnas oförändrade.
  if (req.method === "POST") {
    const authErr = validateApiKey(req.headers["authorization"]);
    if (authErr) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: `${authErr}. Pass your API key as: Authorization: Bearer <key>` },
      });
    }
  }

  const ctx: LogCtx = {
    agent: ((req.headers["user-agent"] as string | undefined) ?? "unknown").slice(0, 80),
    ip_hint: ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0]?.trim() || "unknown",
    sessionId:
      (req.headers["mcp-session-id"] as string | undefined) ??
      (req.headers["x-session-id"] as string | undefined) ??
      "anonymous",
  };
  await requestContext.run(ctx, async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});

// Static server card for Smithery discovery
app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.2.8",
    },
    configSchema: {
      type: "object",
      properties: {
        propertyDomain: {
          type: "string",
          description: "Your vacation rental domain (e.g. example.com)",
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
    tools: CATALOG_TOOLS,
    resources: [],
    prompts: CATALOG_PROMPTS,
  });
});

app.listen(PORT, () => {
  console.log(`Federation MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Server card:  http://0.0.0.0:${PORT}/.well-known/mcp/server-card.json`);
});
