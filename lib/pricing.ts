/**
 * Pricing Resolver — Source of Truth
 *
 * Reads real data from Supabase. Never guesses, never hardcodes.
 * Each host owns their own pricing via their property node.
 *
 * Pricing flow:
 *   rack          = sum of nightly rates (season × guest level × day type), or a
 *                   week/two-week package price when all nights share a season.
 *   direct total  = round(rack × (1 − direct_pct/100)) — the host's single
 *                   acquisition lever (property_channel_discounts → agent, else
 *                   legacy properties.direct_booking_discount). Folded INTO the
 *                   nightly rates (rounding residual absorbed into the last night)
 *                   so Σ nightly === total.
 *   public_total  = federation_total = direct total. The agent surface carries
 *                   ONE honest total — no spread, no second number, no "discount"
 *                   line — mirroring the signed verified-stay-offer
 *                   (smart-stays applyHostDirectPrice; CEO decision 2026-06-29b).
 *   gap_total     = round(federation_total × (1 − gap_night_discount_pct/100))
 *                   (only when calendar context shows a gap between booked nights)
 *
 * RULES (synced with main repo pricing-resolver.ts):
 * - Weekend = Friday + Saturday. Sunday is NEVER weekend.
 * - Week package = exactly 7 nights (not 8).
 * - Two-week package = exactly 14 nights.
 * - Package pricing only when ALL nights are same season type.
 * - Guest block = staircase: smallest block whose guest count >= requested.
 * - Gap discount reads from property_smart_pricing.gap_night_discount_pct.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { pickChannelDiscountPct, type ChannelDiscountRow } from "./channel-discount.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PriceBlock {
  guests: number;
  low_weekday: number;
  low_weekend: number;
  high_weekday: number;
  high_weekend: number;
  low_week: number | null;
  high_week: number | null;
  low_two_weeks: number | null;
  high_two_weeks: number | null;
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
  };
  publicTotal: number;
  federationTotal: number;
  federationDiscountPercent: number;
  packageApplied: string | null; // "week" | "two_weeks" | null
  gapNight: boolean;
  gapTotal: number | null;
  gapDiscountPercent: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────

export function daysBetween(checkIn: string, checkOut: string): number {
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Weekend = Friday (5) + Saturday (6). Sunday is NEVER weekend. */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  return dow === 5 || dow === 6;
}

function getSeasonForDate(date: string, seasons: Season[]): Season | null {
  for (const s of seasons) {
    if (date >= s.date_from && date <= s.date_to) return s;
  }
  return null;
}

/**
 * Staircase pricing: find the smallest block whose guest count >= requested.
 * Example: blocks [2, 6] — 2 guests → 2g, 3-6 guests → 6g, 1 guest → 2g.
 * Returns null only if guests > all blocks (handled by max_guests check upstream).
 */
export function findPriceBlock(guests: number, blocks: PriceBlock[]): PriceBlock | null {
  const sorted = [...blocks].sort((a, b) => a.guests - b.guests);
  for (const b of sorted) {
    if (b.guests >= guests) return b;
  }
  // Guests exceed all blocks — shouldn't happen if max_guests is correct
  return null;
}

function nightlyRate(block: PriceBlock, season: Season | null, weekend: boolean): number {
  const seasonType = season?.type ?? "low";
  if (seasonType === "high") {
    return weekend ? block.high_weekend : block.high_weekday;
  }
  return weekend ? block.low_weekend : block.low_weekday;
}

/**
 * Fold the host's single direct-price lever into the nightly rates + total.
 *
 * Mirror of smart-stays `contracts/ts/price-reconciliation.ts` → applyHostDirectPrice
 * (CEO decision 2026-06-29b). The host lowers their price in ONE place — the agent
 * acquisition discount — and that folds the rack into one honest total:
 *   total = round(rack × (1 − pct/100))
 * Each night is scaled by the SAME factor and the rounding residual is absorbed into
 * the last night, so `Σ nightlyRates.rate === total` exactly (the signed offer then
 * self-reconciles with empty adjustments — no spread, no second number).
 *
 * `pct ≤ 0` / non-finite is a no-op (rack unchanged) — set-and-forget hosts. Mutates
 * `nightlyRates` in place so the returned breakdown carries the folded rates.
 */
function applyHostDirectPrice(
  nightlyRates: QuoteResult["breakdown"]["nightlyRates"],
  rackTotal: number,
  discountPct: number | null | undefined,
): number {
  const pct = Number(discountPct);
  if (!Number.isFinite(pct) || pct <= 0) return rackTotal;
  const factor = 1 - pct / 100;
  const total = Math.round(rackTotal * factor);
  for (const n of nightlyRates) {
    n.rate = Math.round((Number(n.rate) || 0) * factor);
  }
  const scaledSum = nightlyRates.reduce((sum, n) => sum + (Number(n.rate) || 0), 0);
  const residual = total - scaledSum;
  if (residual !== 0 && nightlyRates.length > 0) {
    nightlyRates[nightlyRates.length - 1].rate += residual;
  }
  return total;
}

// ── Gap Night Detection ────────────────────────────────────────────

async function detectGap(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  gapFillEnabled: boolean,
  gapFillMinNights: number,
  gapNightDiscountPct: number | null
): Promise<{ isGap: boolean; discountPercent: number | null }> {
  if (!gapFillEnabled) return { isGap: false, discountPercent: null };

  const nights = daysBetween(checkIn, checkOut);
  if (nights > gapFillMinNights + 1) {
    return { isGap: false, discountPercent: null };
  }

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
  if (!isGap) return { isGap: false, discountPercent: null };

  // Use gap_night_discount_pct from property_smart_pricing (NOT property_campaigns)
  return { isGap, discountPercent: gapNightDiscountPct ?? null };
}

// ── Main Resolver ──────────────────────────────────────────────────

export async function resolveQuote(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests: number
): Promise<QuoteResult | { error: string; available_tiers?: number[] }> {
  // 1. Fetch property
  const { data: property, error: propErr } = await supabase
    .from("properties")
    .select(
      "id, name, currency, max_guests, direct_booking_discount, min_nights, max_nights, published"
    )
    .eq("id", propertyId)
    .single();

  if (propErr || !property) return { error: "Property not found" };
  if (!property.published) return { error: "Property not published" };
  if (guests > property.max_guests) return { error: `Max guests is ${property.max_guests}, requested ${guests}` };

  const nights = daysBetween(checkIn, checkOut);
  if (nights < (property.min_nights ?? 1)) return { error: `Minimum ${property.min_nights} nights required` };
  if (property.max_nights && nights > property.max_nights) return { error: `Maximum ${property.max_nights} nights` };

  // 2. Fetch price blocks (including two_weeks columns)
  const { data: blocks } = await supabase
    .from("property_price_blocks")
    .select("guests, low_weekday, low_weekend, high_weekday, high_weekend, low_week, high_week, low_two_weeks, high_two_weeks")
    .eq("property_id", propertyId)
    .order("guests");

  if (!blocks?.length) return { error: "No pricing configured" };

  // 3. Find guest block (staircase: smallest block >= guests)
  const block = findPriceBlock(guests, blocks as PriceBlock[]);
  if (!block) {
    const available = (blocks as PriceBlock[]).map((b) => b.guests).sort((a, b) => a - b);
    return {
      error: `No price block covers ${guests} guests. Max tier is ${available[available.length - 1]} guests.`,
      available_tiers: available,
    };
  }

  // 4. Fetch seasons
  const { data: seasons } = await supabase
    .from("property_seasons")
    .select("name, date_from, date_to, type")
    .eq("property_id", propertyId);

  // 5. Fetch smart pricing (gap settings + gap_night_discount_pct)
  const { data: smartPricing } = await supabase
    .from("property_smart_pricing")
    .select("gap_fill_enabled, gap_fill_min_nights, gap_night_discount_pct")
    .eq("property_id", propertyId)
    .single();

  // 5b. Channel acquisition discounts (same table the dashboard writes)
  const { data: channelRows } = await supabase
    .from("property_channel_discounts")
    .select("channel, discount_pct")
    .eq("property_id", propertyId);

  // 6. Calculate nightly rates
  const nightlyRates: QuoteResult["breakdown"]["nightlyRates"] = [];
  const seasonList = (seasons ?? []) as Season[];

  // Check each night has a season
  for (let i = 0; i < nights; i++) {
    const date = addDays(checkIn, i);
    const season = getSeasonForDate(date, seasonList);
    if (!season) {
      return { error: `No season defined for ${date} — property not bookable for this period` };
    }
    const weekend = isWeekend(date);
    const rate = nightlyRate(block, season, weekend);
    nightlyRates.push({
      date,
      rate,
      season: season.name,
      dayType: weekend ? "weekend" : "weekday",
    });
  }

  // 7. Check for package pricing
  let packageApplied: string | null = null;
  let accommodationTotal: number;

  const allSameSeasonType = nightlyRates.every(
    (n) => {
      const s = getSeasonForDate(n.date, seasonList);
      return s?.type === getSeasonForDate(nightlyRates[0].date, seasonList)?.type;
    }
  );
  const firstSeason = getSeasonForDate(nightlyRates[0].date, seasonList);
  const seasonType = firstSeason?.type ?? "low";

  if (allSameSeasonType && nights === 14) {
    // Two-week package: exactly 14 nights, same season
    const pkg = seasonType === "low" ? block.low_two_weeks : block.high_two_weeks;
    if (pkg !== null && pkg > 0) {
      accommodationTotal = pkg;
      packageApplied = "two_weeks";
    } else {
      accommodationTotal = nightlyRates.reduce((sum, n) => sum + n.rate, 0);
    }
  } else if (allSameSeasonType && nights === 7) {
    // Week package: exactly 7 nights, same season
    const pkg = seasonType === "low" ? block.low_week : block.high_week;
    if (pkg !== null && pkg > 0) {
      accommodationTotal = pkg;
      packageApplied = "week";
    } else {
      accommodationTotal = nightlyRates.reduce((sum, n) => sum + n.rate, 0);
    }
  } else {
    // Night-by-night
    accommodationTotal = nightlyRates.reduce((sum, n) => sum + n.rate, 0);
  }

  const rackTotal = accommodationTotal;

  // 8. Host's single direct-price lever (CEO decision 2026-06-29b).
  //    The host lowers their price in ONE place — the agent acquisition discount
  //    (property_channel_discounts → agent, else legacy direct_booking_discount).
  //    That lever FOLDS the rack into one honest total; public and federation
  //    carry the SAME folded value — no spread, no second number — exactly what
  //    the signed verified-stay-offer carries (smart-stays applyHostDirectPrice).
  const directDiscountPct = pickChannelDiscountPct(
    (channelRows ?? []) as ChannelDiscountRow[],
    "agent",
    property.direct_booking_discount ?? null,
  );
  const directTotal = applyHostDirectPrice(nightlyRates, rackTotal, directDiscountPct);
  const publicTotal = directTotal;
  const federationTotal = directTotal;

  // 9. Gap night detection (reads gap_night_discount_pct from smart_pricing)
  const { isGap, discountPercent: gapDiscountPct } = await detectGap(
    supabase,
    propertyId,
    checkIn,
    checkOut,
    smartPricing?.gap_fill_enabled ?? false,
    smartPricing?.gap_fill_min_nights ?? 2,
    smartPricing?.gap_night_discount_pct ?? null
  );

  let gapTotal: number | null = null;
  if (isGap && gapDiscountPct) {
    gapTotal = Math.round(federationTotal * (1 - gapDiscountPct / 100));
  }

  return {
    propertyId,
    checkIn,
    checkOut,
    guests,
    nights,
    currency: property.currency ?? "SEK",
    breakdown: { nightlyRates },
    publicTotal,
    federationTotal,
    // No public/agent spread — the direct lever is folded into the single total.
    federationDiscountPercent: 0,
    packageApplied,
    gapNight: isGap,
    gapTotal,
    gapDiscountPercent: isGap ? gapDiscountPct : null,
  };
}
