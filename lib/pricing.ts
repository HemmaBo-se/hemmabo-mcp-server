/**
 * Pricing Resolver — MCP wrapper around the shared pricing core.
 *
 * The pure rack-quote engine and the gap-night decision logic live in
 * `lib/pricing-core.ts` — a byte-identical vendored mirror of smart-stays
 * `contracts/ts/pricing-core.ts` (repo-lockstep per ADR 0004; unification
 * decided in smart-stays ADR `2026-07-29-pricing-shared-core.md`, PR-1b).
 * This wrapper must NOT redeclare any constant, type, or pure helper that
 * lives in the core — it imports from there.
 *
 * Reads real data from Supabase. Never guesses, never hardcodes.
 * Each host owns their own pricing via their property node.
 *
 * Pricing flow (canonical node-side order: rack → channel fold → gap):
 *   rack          = core `computeRackQuote` (season × guest staircase × day
 *                   type, or a week/two-week package when all nights share a
 *                   season type — or, on slider-model properties (stay-
 *                   discount rules configured, ADR 2026-08-13 D3), the ONE
 *                   winning stay rule repricing the nightly sum while
 *                   packages are ignored entirely). Season-gap-fill now applies here too —
 *                   dates outside configured seasons quote via the nearest
 *                   season when the host has it enabled (parity with the
 *                   website; previously the MCP path errored).
 *   direct total  = round(rack × (1 − direct_pct/100)) — the host's single
 *                   acquisition lever (property_channel_discounts → agent,
 *                   else legacy properties.direct_booking_discount). Folded
 *                   INTO the nightly rates (rounding residual absorbed into
 *                   the last night) so Σ nightly === total.
 *   public_total  = federation_total = direct total. ONE honest total — no
 *                   spread (smart-stays applyHostDirectPrice; CEO decision
 *                   2026-06-29b).
 *   gap_total     = core `applyGapDiscount(federation_total, decision)` —
 *                   only when the core's `decideGapNight` says the stay sits
 *                   between two confirmed bookings (DB neighbor lookups stay
 *                   here; the decision is core logic).
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { pickChannelDiscountPct, type ChannelDiscountRow } from "./channel-discount.js";
import {
  computeRackQuote,
  decideGapNight,
  applyGapDiscount,
  isWeekendDay,
  findPriceBlock,
  leadDaysUntil,
  stayDiscountRulesFromRows,
  type PriceBlock,
  type Season,
  type StayDiscountRow,
} from "./pricing-core.js";

// ── Re-exports (compat: tests + tools import these from this module) ──

export { findPriceBlock, isWeekendDay as isWeekend };
export type { PriceBlock, Season };

// ── Types ──────────────────────────────────────────────────────────

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

// ── Gap Night Detection (DB neighbor lookups — decision is core logic) ──

async function findGapNeighbors(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<{ hasNeighborBefore: boolean; hasNeighborAfter: boolean }> {
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

  return {
    hasNeighborBefore: Boolean(before?.length),
    hasNeighborAfter: Boolean(after?.length),
  };
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

  // 3. Fetch seasons
  const { data: seasons } = await supabase
    .from("property_seasons")
    .select("name, date_from, date_to, type")
    .eq("property_id", propertyId);

  // 4. Fetch smart pricing (gap settings + season-gap-fill flag)
  const { data: smartPricing } = await supabase
    .from("property_smart_pricing")
    .select("gap_fill_enabled, gap_fill_min_nights, gap_night_discount_pct, season_gap_fill_enabled")
    .eq("property_id", propertyId)
    .single();

  // 4b. Channel acquisition discounts (same table the dashboard writes)
  const { data: channelRows } = await supabase
    .from("property_channel_discounts")
    .select("channel, discount_pct")
    .eq("property_id", propertyId);

  // 4c. Stay-discount rules (the slider model, smart-stays ADR 2026-08-13
  //     D3 "ersätt") — ANY row moves the property off the package model;
  //     the vendored core picks the ONE winning rule (never stacked, D1).
  //     Public-read table, so every client key works.
  const { data: stayRuleRows } = await supabase
    .from("property_stay_discounts")
    .select("kind, threshold_units, pct")
    .eq("property_id", propertyId);

  // 5. Rack quote from the shared core (staircase, seasons incl. gap-fill,
  //    weekend rule, 7/14-night packages — one engine, every door).
  //    Default ON when the column is absent: refusing to quote is never a
  //    safe SaaS default (same semantics as smart-stays fetchPriceMatrix).
  const seasonGapFillEnabled =
    typeof smartPricing?.season_gap_fill_enabled === "boolean"
      ? smartPricing.season_gap_fill_enabled
      : true;

  const rack = computeRackQuote(
    (seasons ?? []) as Season[],
    (blocks ?? []) as PriceBlock[],
    guests,
    checkIn,
    checkOut,
    seasonGapFillEnabled,
    {},
    stayDiscountRulesFromRows((stayRuleRows ?? []) as StayDiscountRow[]),
    leadDaysUntil(checkIn),
  );

  if (rack.success === false) {
    if (rack.action === "clarify" && rack.available_tiers) {
      return { error: rack.reason, available_tiers: rack.available_tiers };
    }
    return { error: rack.detail ? `${rack.reason} — ${rack.detail}` : rack.reason };
  }

  const nightlyRates: QuoteResult["breakdown"]["nightlyRates"] = rack.breakdown.map((n) => ({
    date: n.date,
    rate: n.nightly_rate,
    season: n.season_name,
    dayType: n.is_weekend ? "weekend" : "weekday",
  }));

  const rackTotal = rack.rackTotal;

  // 6. Host's single direct-price lever (CEO decision 2026-06-29b).
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

  // 7. Gap-night: DB neighbor lookups here, decision in the core.
  //    D1 (ADR 2026-08-13): discounts never stack — a kernel-applied stay
  //    discount suppresses the opportunistic gap discount, exactly like the
  //    smart-stays doors (resolveGapNight's stayDiscountApplied guard).
  const stayApplied = rack.stay_discount_applied !== null;
  const gapEnabled = (smartPricing?.gap_fill_enabled ?? false) && !stayApplied;
  const neighbors = gapEnabled
    ? await findGapNeighbors(supabase, propertyId, checkIn, checkOut)
    : { hasNeighborBefore: false, hasNeighborAfter: false };

  const gapDecision = decideGapNight({
    enabled: gapEnabled,
    gapFillMinNights: smartPricing?.gap_fill_min_nights ?? 2,
    nights,
    hasNeighborBefore: neighbors.hasNeighborBefore,
    hasNeighborAfter: neighbors.hasNeighborAfter,
    discountPct: smartPricing?.gap_night_discount_pct ?? null,
  });

  const gapTotal = applyGapDiscount(federationTotal, gapDecision);

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
    packageApplied: rack.package_applied,
    gapNight: gapDecision.isGap,
    gapTotal,
    gapDiscountPercent: gapDecision.isGap ? gapDecision.discountPct : null,
  };
}
