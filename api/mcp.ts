/**
 * Federation MCP Server — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All-in-one handler: JSON-RPC, pricing resolver, availability checker.
 * Each host is its own node (source of truth).
 * 
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /mcp  — transport info
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════
// PRICING RESOLVER
// ═══════════════════════════════════════════════════════════════════

interface PriceBlock {
  guests: number;
  low_weekday: number;
  low_weekend: number;
  high_weekday: number;
  high_weekend: number;
  low_week: number;
  high_week: number;
}

interface Season {
  name: string;
  date_from: string;
  date_to: string;
  type: "high" | "low";
}

interface QuoteResult {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  nights: number;
  currency: string;
  breakdown: {
    nightlyRates: { date: string; rate: number; season: string; dayType: string }[];
    cleaningFee: number;
  };
  publicTotal: number;
  federationTotal: number;
  federationDiscountPercent: number;
  gapNight: boolean;
  gapTotal: number | null;
  gapDiscountPercent: number | null;
}

function daysBetween(checkIn: string, checkOut: string): number {
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(dateStr: string, sundayIsWeekend: boolean): boolean {
  const day = new Date(dateStr).getDay();
  if (day === 5 || day === 6) return true;
  if (day === 0 && sundayIsWeekend) return true;
  return false;
}

function getSeasonForDate(date: string, seasons: Season[]): Season | null {
  const d = new Date(date);
  for (const s of seasons) {
    if (d >= new Date(s.date_from) && d <= new Date(s.date_to)) return s;
  }
  return null;
}

function pickPriceBlock(guests: number, blocks: PriceBlock[]): PriceBlock {
  const sorted = [...blocks].sort((a, b) => a.guests - b.guests);
  for (const b of sorted) {
    if (b.guests >= guests) return b;
  }
  return sorted[sorted.length - 1];
}

function nightlyRate(block: PriceBlock, season: Season | null, weekend: boolean): number {
  const seasonType = season?.type ?? "low";
  if (seasonType === "high") {
    return weekend ? block.high_weekend : block.high_weekday;
  }
  return weekend ? block.low_weekend : block.low_weekday;
}

async function detectGap(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  gapFillEnabled: boolean,
  gapFillMinNights: number
): Promise<{ isGap: boolean; campaignDiscount: number | null }> {
  if (!gapFillEnabled) return { isGap: false, campaignDiscount: null };

  const nights = daysBetween(checkIn, checkOut);
  if (nights > gapFillMinNights + 1) {
    return { isGap: false, campaignDiscount: null };
  }

  const { data: before } = await supabase
    .from("bookings")
    .select("id, check_out_date")
    .eq("property_id", propertyId)
    .eq("status", "confirmed")
    .gte("check_out_date", addDays(checkIn, -2))
    .lte("check_out_date", checkIn)
    .limit(1);

  const { data: after } = await supabase
    .from("bookings")
    .select("id, check_in_date")
    .eq("property_id", propertyId)
    .eq("status", "confirmed")
    .gte("check_in_date", checkOut)
    .lte("check_in_date", addDays(checkOut, 2))
    .limit(1);

  const isGap = Boolean(before?.length && after?.length);
  if (!isGap) return { isGap: false, campaignDiscount: null };

  const { data: campaigns } = await supabase
    .from("property_campaigns")
    .select("discount_percent")
    .eq("property_id", propertyId)
    .eq("campaign_type", "gap_filler")
    .eq("is_active", true)
    .limit(1);

  const campaignDiscount = campaigns?.[0]?.discount_percent ?? null;
  return { isGap, campaignDiscount };
}

async function resolveQuote(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests: number
): Promise<QuoteResult | { error: string }> {
  const { data: property, error: propErr } = await supabase
    .from("properties")
    .select(
      "id, name, currency, max_guests, direct_booking_discount, cleaning_fee, min_nights, max_nights, sunday_is_weekend, published"
    )
    .eq("id", propertyId)
    .single();

  if (propErr || !property) return { error: "Property not found" };
  if (!property.published) return { error: "Property not published" };
  if (guests > property.max_guests) return { error: `Max guests is ${property.max_guests}, requested ${guests}` };

  const nights = daysBetween(checkIn, checkOut);
  if (nights < (property.min_nights ?? 1)) return { error: `Minimum ${property.min_nights} nights required` };
  if (property.max_nights && nights > property.max_nights) return { error: `Maximum ${property.max_nights} nights` };

  const { data: blocks } = await supabase
    .from("property_price_blocks")
    .select("guests, low_weekday, low_weekend, high_weekday, high_weekend, low_week, high_week")
    .eq("property_id", propertyId)
    .order("guests");

  if (!blocks?.length) return { error: "No pricing configured" };

  const { data: seasons } = await supabase
    .from("property_seasons")
    .select("name, date_from, date_to, type")
    .eq("property_id", propertyId);

  const { data: smartPricing } = await supabase
    .from("property_smart_pricing")
    .select("gap_fill_enabled, gap_fill_min_nights")
    .eq("property_id", propertyId)
    .single();

  const block = pickPriceBlock(guests, blocks as PriceBlock[]);
  const nightlyRates: QuoteResult["breakdown"]["nightlyRates"] = [];

  if (nights >= 7 && nights <= 8) {
    const midStay = addDays(checkIn, Math.floor(nights / 2));
    const season = getSeasonForDate(midStay, (seasons ?? []) as Season[]);
    const weekPrice = season?.type === "high" ? block.high_week : block.low_week;
    if (weekPrice > 0) {
      const perNight = Math.round(weekPrice / nights);
      for (let i = 0; i < nights; i++) {
        const date = addDays(checkIn, i);
        const s = getSeasonForDate(date, (seasons ?? []) as Season[]);
        nightlyRates.push({
          date,
          rate: perNight,
          season: s?.name ?? "Standard",
          dayType: isWeekend(date, property.sunday_is_weekend ?? true) ? "weekend" : "weekday",
        });
      }
    }
  }

  if (nightlyRates.length === 0) {
    for (let i = 0; i < nights; i++) {
      const date = addDays(checkIn, i);
      const season = getSeasonForDate(date, (seasons ?? []) as Season[]);
      const weekend = isWeekend(date, property.sunday_is_weekend ?? true);
      const rate = nightlyRate(block, season, weekend);
      nightlyRates.push({
        date,
        rate,
        season: season?.name ?? "Standard",
        dayType: weekend ? "weekend" : "weekday",
      });
    }
  }

  const accommodationTotal = nightlyRates.reduce((sum, n) => sum + n.rate, 0);
  const cleaningFee = property.cleaning_fee ?? 0;
  const publicTotal = accommodationTotal + cleaningFee;

  const discountPct = property.direct_booking_discount ?? 0;
  const federationTotal = Math.round(publicTotal * (1 - discountPct / 100));

  const { isGap, campaignDiscount } = await detectGap(
    supabase,
    propertyId,
    checkIn,
    checkOut,
    smartPricing?.gap_fill_enabled ?? false,
    smartPricing?.gap_fill_min_nights ?? 2
  );

  let gapTotal: number | null = null;
  if (isGap && campaignDiscount) {
    gapTotal = Math.round(federationTotal * (1 - campaignDiscount / 100));
  }

  return {
    propertyId,
    checkIn,
    checkOut,
    guests,
    nights,
    currency: property.currency ?? "SEK",
    breakdown: { nightlyRates, cleaningFee },
    publicTotal,
    federationTotal,
    federationDiscountPercent: discountPct,
    gapNight: isGap,
    gapTotal,
    gapDiscountPercent: isGap ? campaignDiscount : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AVAILABILITY CHECKER
// ═══════════════════════════════════════════════════════════════════

interface AvailabilityResult {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  available: boolean;
  reason?: string;
  conflictDates?: string[];
}

async function checkAvailability(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string
): Promise<AvailabilityResult> {
  const { data: blocked } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date, source")
    .eq("property_id", propertyId)
    .lt("start_date", checkOut)
    .gt("end_date", checkIn);

  if (blocked?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates blocked",
      conflictDates: blocked.map((b) => `${b.start_date} to ${b.end_date} (${b.source})`),
    };
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select("check_in_date, check_out_date, status")
    .eq("property_id", propertyId)
    .in("status", ["confirmed", "pending"])
    .lt("check_in_date", checkOut)
    .gt("check_out_date", checkIn);

  if (bookings?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates already booked",
      conflictDates: bookings.map((b) => `${b.check_in_date} to ${b.check_out_date} (${b.status})`),
    };
  }

  const { data: locks } = await supabase
    .from("booking_locks")
    .select("check_in, check_out, locked_until")
    .eq("property_id", propertyId)
    .gt("locked_until", new Date().toISOString())
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);

  if (locks?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates temporarily locked (booking in progress)",
    };
  }

  return { propertyId, checkIn, checkOut, available: true };
}

// ═══════════════════════════════════════════════════════════════════
// MCP TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: "search_properties",
    description:
      "Search for available properties by region and guest count. Returns real pricing from each property node.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
];

// ═══════════════════════════════════════════════════════════════════
// TOOL EXECUTION
// ═══════════════════════════════════════════════════════════════════

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[] }> {
  const supabase = getSupabase();

  switch (name) {
    case "search_properties": {
      const { region, country, guests, checkIn, checkOut } = args as {
        region?: string; country?: string; guests: number; checkIn: string; checkOut: string;
      };

      let query = supabase
        .from("properties")
        .select("id, name, domain, region, city, country, max_guests, currency, property_type, direct_booking_discount, cleaning_fee")
        .eq("published", true)
        .gte("max_guests", guests);

      if (region) query = query.ilike("region", `%${region}%`);
      if (country) query = query.ilike("country", `%${country}%`);

      const { data: properties, error } = await query;
      if (error) return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };

      const results = [];
      for (const prop of properties ?? []) {
        const avail = await checkAvailability(supabase, prop.id, checkIn, checkOut);
        if (!avail.available) continue;
        const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, guests);
        if ("error" in quote) continue;
        results.push({
          propertyId: prop.id, name: prop.name, domain: prop.domain,
          region: prop.region, city: prop.city, country: prop.country,
          maxGuests: prop.max_guests, propertyType: prop.property_type,
          currency: quote.currency, nights: quote.nights,
          publicTotal: quote.publicTotal, federationTotal: quote.federationTotal,
          federationDiscountPercent: quote.federationDiscountPercent, available: true,
        });
      }

      return { content: [{ type: "text", text: JSON.stringify({ checkIn, checkOut, guests, properties: results }, null, 2) }] };
    }

    case "check_availability": {
      const { propertyId, checkIn, checkOut } = args as { propertyId: string; checkIn: string; checkOut: string };
      const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "get_canonical_quote": {
      const { propertyId, checkIn, checkOut, guests } = args as { propertyId: string; checkIn: string; checkOut: string; guests: number };
      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      return { content: [{ type: "text", text: JSON.stringify(quote, null, 2) }] };
    }

    case "create_booking": {
      const { propertyId, checkIn, checkOut, guests, guestName, guestEmail, guestPhone } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
        guestName: string; guestEmail: string; guestPhone?: string;
      };

      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...avail }) }] };

      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }] };

      const totalPrice = quote.gapTotal ?? quote.federationTotal;
      const { data: prop } = await supabase.from("properties").select("name, host_id").eq("id", propertyId).single();

      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .insert({
          property_id: propertyId, host_id: prop?.host_id,
          check_in_date: checkIn, check_out_date: checkOut,
          guests_count: guests, guest_name: guestName,
          guest_email: guestEmail, guest_phone: guestPhone ?? null,
          total_price: totalPrice, currency: quote.currency,
          status: "pending", property_name_at_booking: prop?.name ?? null,
          host_approval_required: true,
        })
        .select("id, status, created_at")
        .single();

      if (bookErr) return { content: [{ type: "text", text: JSON.stringify({ error: bookErr.message }) }] };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            bookingId: booking.id, status: booking.status, propertyId,
            checkIn, checkOut, nights: quote.nights, guests, totalPrice,
            currency: quote.currency, priceType: quote.gapTotal ? "gap_night" : "federation",
            federationDiscountPercent: quote.federationDiscountPercent,
            gapDiscountPercent: quote.gapDiscountPercent, createdAt: booking.created_at,
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] };
  }
}

// ═══════════════════════════════════════════════════════════════════
// JSON-RPC HANDLER
// ═══════════════════════════════════════════════════════════════════

async function handleJsonRpc(
  msg: { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> }
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "federation-mcp-server", version: "2.0.0" },
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (params as { name: string })?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      try {
        const result = await executeTool(toolName, toolArgs);
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal error";
        return { jsonrpc: "2.0", id, error: { code: -32603, message } };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: "2.0.0" });
  if (req.method === "DELETE") return res.status(202).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = [];
      for (const msg of body) {
        const result = await handleJsonRpc(msg);
        if (result !== null) results.push(result);
      }
      if (results.length === 0) return res.status(202).end();
      return res.json(results);
    }

    const result = await handleJsonRpc(body);
    if (result === null) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("MCP handler error:", message);
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
  }
}
