/**
 * Pricing Resolver — Source of Truth
 *
 * Reads real data from Supabase. Never guesses, never hardcodes.
 * Each host owns their own pricing via their property node.
 *
 * Pricing flow:
 *   public_total  = sum of nightly rates (season × guest level × day type)
 *   federation_total = public_total × (1 - direct_booking_discount / 100)
 *   gap_total     = federation_total × (1 - gap_campaign_discount / 100)
 *                   (only when calendar context shows a gap)
 */

import { SupabaseClient } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────

export interface PriceBlock {
  guests: number;
  low_weekday: number;
  low_weekend: number;
  high_weekday: number;
  high_weekend: number;
  low_week: number;
  high_week: number;
}

export interface Season {
  name: string;
  date_from: string;
  date_to: string;
  type: "high" | "low";
}

export interface QuoteResult {
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

// ── Helpers ────────────────────────────────────────────────────────

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
  const day = new Date(dateStr).getDay(); // 0=Sun, 5=Fri, 6=Sat
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
  // Find the smallest block whose guest count covers the request
  const sorted = [...blocks].sort((a, b) => a.guests - b.guests);
  for (const b of sorted) {
    if (b.guests >= guests) return b;
  }
  // Fallback: highest block
  return sorted[sorted.length - 1];
}

function nightlyRate(
  block: PriceBlock,
  season: Season | null,
  weekend: boolean
): number {
  const seasonType = season?.type ?? "low";
  if (seasonType === "high") {
    return weekend ? block.high_weekend : block.high_weekday;
  }
  return weekend ? block.low_weekend : block.low_weekday;
}

// ── Gap Night Detection ────────────────────────────────────────────

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
    // Too long to be a gap filler
    return { isGap: false, campaignDiscount: null };
  }

  // Check for confirmed bookings immediately before and after
  const windowBefore = addDays(checkIn, -1);
  const windowAfter = checkOut;

  // Booking ending on or 1 day before check-in
  const { data: before } = await supabase
    .from("bookings")
    .select("id, check_out_date")
    .eq("property_id", propertyId)
    .eq("status", "confirmed")
    .gte("check_out_date", addDays(checkIn, -2))
    .lte("check_out_date", checkIn)
    .limit(1);

  // Booking starting on or 1 day after check-out
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

  // Look for active gap_filler campaign
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

// ── Main Resolver ──────────────────────────────────────────────────

export async function resolveQuote(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests: number
): Promise<QuoteResult | { error: string }> {
  // 1. Fetch property
  const { data: property, error: propErr } = await supabase
    .from("properties")
    .select(
      "id, name, currency, max_guests, direct_booking_discount, cleaning_fee, min_nights, max_nights, sunday_is_weekend, published"
    )
    .eq("id", propertyId)
    .single();

  if (propErr || !property) return { error: "Property not found" };
  if (!property.published) return { error: "Property not published" };
  if (guests > property.max_guests)
    return {
      error: `Max guests is ${property.max_guests}, requested ${guests}`,
    };

  const nights = daysBetween(checkIn, checkOut);
  if (nights < (property.min_nights ?? 1))
    return { error: `Minimum ${property.min_nights} nights required` };
  if (property.max_nights && nights > property.max_nights)
    return { error: `Maximum ${property.max_nights} nights` };

  // 2. Fetch price blocks
  const { data: blocks } = await supabase
    .from("property_price_blocks")
    .select("guests, low_weekday, low_weekend, high_weekday, high_weekend, low_week, high_week")
    .eq("property_id", propertyId)
    .order("guests");

  if (!blocks?.length) return { error: "No pricing configured" };

  // 3. Fetch seasons
  const { data: seasons } = await supabase
    .from("property_seasons")
    .select("name, date_from, date_to, type")
    .eq("property_id", propertyId);

  // 4. Fetch smart pricing (gap settings)
  const { data: smartPricing } = await supabase
    .from("property_smart_pricing")
    .select("gap_fill_enabled, gap_fill_min_nights")
    .eq("property_id", propertyId)
    .single();

  // 5. Calculate nightly rates
  const block = pickPriceBlock(guests, blocks as PriceBlock[]);
  const nightlyRates: QuoteResult["breakdown"]["nightlyRates"] = [];

  // Check if we should use week price
  if (nights >= 7 && nights <= 8) {
    // Check season
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
          dayType: isWeekend(date, property.sunday_is_weekend ?? true)
            ? "weekend"
            : "weekday",
        });
      }
    }
  }

  // Default: night-by-night calculation
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

  // 6. Federation discount (host-controlled)
  const discountPct = property.direct_booking_discount ?? 0;
  const federationTotal = Math.round(publicTotal * (1 - discountPct / 100));

  // 7. Gap night detection
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
    breakdown: {
      nightlyRates,
      cleaningFee,
    },
    publicTotal,
    federationTotal,
    federationDiscountPercent: discountPct,
    gapNight: isGap,
    gapTotal,
    gapDiscountPercent: isGap ? campaignDiscount : null,
  };
}
