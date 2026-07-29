/**
 * Pricing — shared core (Layer 3, runtime-agnostic).
 *
 * This module is the **single source** for the pure rack-quote engine and
 * the gap-night decision logic. It unifies what previously lived as three
 * divergent implementations:
 *   - `api/_lib/pricing-resolver.ts`          (Node serverless — staircase)
 *   - `supabase/functions/_shared/canonical-pricing.ts` (Deno edge — was exact-match)
 *   - `hemmabo-mcp-server/lib/pricing.ts`     (MCP — staircase, no season-gap-fill)
 *
 * Canonical rules (divergences resolved by ADR
 * `docs/DECISIONS/2026-07-29-pricing-shared-core.md`):
 *   - Guest block = STAIRCASE: smallest block whose guest count >= requested.
 *     (Exact-match is dead — it made 3 guests unquotable while other doors quoted.)
 *   - Weekend = Friday + Saturday nights. Sunday is NEVER weekend.
 *   - Week package = exactly 7 nights; two-week package = exactly 14 nights;
 *     packages apply only when ALL nights share one season type and the
 *     package price is set (> 0). Package prices are totals, not nightly.
 *   - Season gap-fill: when enabled, a date not covered by any season falls
 *     back to the NEAREST season (marked on the breakdown row). When disabled,
 *     the quote fails with action:"no_season". This is *season* gap-fill —
 *     unrelated to the gap-NIGHT discount below.
 *   - Rack quote NEVER includes any discount. Channel folding stays in
 *     `price-reconciliation.ts` (applyHostDirectPrice) with the pct picked by
 *     `channel-discount.ts` — this core does not re-implement either.
 *   - Canonical node-side order: rack → channel fold → gap-night discount.
 *     (Matches the arithmetic already live on the signed agent surface, so
 *     existing signed-offer totals stay byte-stable.)
 *
 * Gap-NIGHT discount (calendar gap between bookings — the host lever
 * `property_smart_pricing.gap_night_discount_pct`): the DECISION is pure and
 * lives here; the neighbor-booking lookups need a DB client and stay in the
 * runtime adapters, which feed booleans in.
 *
 * The runtime wrappers must NOT redeclare any constant, type, or pure helper
 * that lives in this file — they import from here (same law as
 * `availability-core.ts`, ADR 2026-05-01-availability-truth-shared-core).
 */

// ── Types ──────────────────────────────────────────────────────────

export interface Season {
  id?: string;
  name: string;
  date_from: string; // YYYY-MM-DD
  date_to: string; // YYYY-MM-DD
  type: "low" | "high";
}

export interface PriceBlock {
  id?: string;
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

export interface RackNight {
  date: string;
  day_of_week: string;
  is_weekend: boolean;
  season_type: "low" | "high";
  /** Season name; suffixed with " (gap-fill)" when season-gap-filled. */
  season_name: string;
  nightly_rate: number;
}

export interface RackQuote {
  success: true;
  /** Sum of nightly rates, or the package total when a package applies. NO discounts. */
  rackTotal: number;
  nights: number;
  guests: number;
  breakdown: RackNight[];
  package_applied: "week" | "two_weeks" | null;
}

export interface RackQuoteError {
  success: false;
  price: null;
  reason: string;
  action: "no_season" | "no_block" | "clarify" | "no_data";
  available_tiers?: number[];
  detail?: string;
}

// ── Pure date helpers ──────────────────────────────────────────────

/** Friday (5) and Saturday (6) nights are weekend. Sunday is NEVER weekend. */
export function isWeekendDay(dateStr: string): boolean {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC avoids TZ edges
  const dow = d.getUTCDay();
  return dow === 5 || dow === 6;
}

export function dayOfWeekName(dateStr: string): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

/** All night dates from check-in (inclusive) to check-out (exclusive). */
export function dateRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const end = new Date(`${checkOut}T12:00:00Z`);
  const current = new Date(`${checkIn}T12:00:00Z`);
  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Season resolution (incl. season-gap-fill) ──────────────────────

export function findSeason(date: string, seasons: Season[]): Season | null {
  for (const s of seasons) {
    if (date >= s.date_from && date <= s.date_to) return s;
  }
  return null;
}

/**
 * Nearest season by day-distance to either end of its range. Fallback when
 * no season covers the date and season-gap-fill is enabled. Null only when
 * `seasons` is empty.
 */
export function findNearestSeason(date: string, seasons: Season[]): Season | null {
  if (seasons.length === 0) return null;
  const target = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(target)) return null;
  const ONE_DAY = 86400000;
  let best: Season | null = null;
  let bestDist = Infinity;
  for (const s of seasons) {
    const from = Date.parse(`${s.date_from}T12:00:00Z`);
    const to = Date.parse(`${s.date_to}T12:00:00Z`);
    let dist = 0;
    if (target < from) dist = (from - target) / ONE_DAY;
    else if (target > to) dist = (target - to) / ONE_DAY;
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

// ── Guest block (STAIRCASE — the canonical rule) ───────────────────

/**
 * Staircase: smallest block whose guest count >= requested.
 * Example: blocks [2, 6] — 2 guests → 2g, 3–6 guests → 6g, 1 guest → 2g.
 * Null only when guests exceed every block.
 */
export function findPriceBlock(guests: number, blocks: PriceBlock[]): PriceBlock | null {
  const sorted = [...blocks].sort((a, b) => a.guests - b.guests);
  for (const b of sorted) {
    if (b.guests >= guests) return b;
  }
  return null;
}

export function getNightlyRate(
  block: PriceBlock,
  seasonType: "low" | "high",
  weekend: boolean,
): number {
  if (seasonType === "low") return weekend ? block.low_weekend : block.low_weekday;
  return weekend ? block.high_weekend : block.high_weekday;
}

// ── Rack quote (NO discounts — folding happens per surface) ────────

export function computeRackQuote(
  seasons: Season[],
  blocks: PriceBlock[],
  guests: number,
  checkIn: string,
  checkOut: string,
  seasonGapFillEnabled = false,
): RackQuote | RackQuoteError {
  if (seasons.length === 0 || blocks.length === 0) {
    return {
      success: false,
      price: null,
      reason: "No pricing data configured for this property",
      action: "no_data",
    };
  }

  const block = findPriceBlock(guests, blocks);
  if (!block) {
    const available = blocks.map((b) => b.guests).sort((a, b) => a - b);
    return {
      success: false,
      price: null,
      reason: `No price block covers ${guests} guests. Max tier is ${available[available.length - 1]} guests.`,
      action: "clarify",
      available_tiers: available,
      detail: `Available guest tiers: ${available.join(", ")}. Guests requested (${guests}) exceeds all tiers.`,
    };
  }

  const nightDates = dateRange(checkIn, checkOut);
  if (nightDates.length === 0) {
    return { success: false, price: null, reason: "Invalid date range", action: "no_data" };
  }

  const breakdown: RackNight[] = [];
  for (const date of nightDates) {
    let season = findSeason(date, seasons);
    let gapFilled = false;
    if (!season) {
      if (!seasonGapFillEnabled) {
        return {
          success: false,
          price: null,
          reason: `No season defined for ${date}`,
          action: "no_season",
          detail: `Date ${date} has no season — property is not bookable for this period`,
        };
      }
      season = findNearestSeason(date, seasons);
      if (!season) {
        return {
          success: false,
          price: null,
          reason: `No season defined for ${date}`,
          action: "no_season",
          detail: `Date ${date} has no season and no fallback season available`,
        };
      }
      gapFilled = true;
    }
    const weekend = isWeekendDay(date);
    breakdown.push({
      date,
      day_of_week: dayOfWeekName(date),
      is_weekend: weekend,
      season_type: season.type,
      season_name: gapFilled ? `${season.name} (gap-fill)` : season.name,
      nightly_rate: getNightlyRate(block, season.type, weekend),
    });
  }

  const allSameSeasonType = breakdown.every((n) => n.season_type === breakdown[0].season_type);
  const seasonType = breakdown[0].season_type;
  const nightlySum = breakdown.reduce((sum, n) => sum + n.nightly_rate, 0);

  let rackTotal = nightlySum;
  let packageApplied: "week" | "two_weeks" | null = null;

  if (allSameSeasonType && nightDates.length === 14) {
    const pkg = seasonType === "low" ? block.low_two_weeks : block.high_two_weeks;
    if (pkg !== null && pkg > 0) {
      rackTotal = pkg;
      packageApplied = "two_weeks";
    }
  } else if (allSameSeasonType && nightDates.length === 7) {
    const pkg = seasonType === "low" ? block.low_week : block.high_week;
    if (pkg !== null && pkg > 0) {
      rackTotal = pkg;
      packageApplied = "week";
    }
  }

  return {
    success: true,
    rackTotal,
    nights: nightDates.length,
    guests,
    breakdown,
    package_applied: packageApplied,
  };
}

// ── Gap-NIGHT discount (decision logic — DB lookups stay in adapters) ──

export interface GapNightInput {
  /** Host toggle `property_smart_pricing.gap_fill_enabled`. */
  enabled: boolean;
  /** Host setting `property_smart_pricing.gap_fill_min_nights` (default 2). */
  gapFillMinNights: number;
  /** Nights in the requested stay. */
  nights: number;
  /** A confirmed booking checks out on/within 2 days before this check-in. */
  hasNeighborBefore: boolean;
  /** A confirmed booking checks in on/within 2 days after this check-out. */
  hasNeighborAfter: boolean;
  /** Host setting `property_smart_pricing.gap_night_discount_pct` (0..50). */
  discountPct: number | null;
}

export interface GapNightDecision {
  isGap: boolean;
  discountPct: number | null;
}

/**
 * A stay is a gap night when the feature is on, the stay is short enough
 * (nights <= gapFillMinNights + 1) and it sits between two confirmed
 * bookings. Mirrors the live MCP behaviour exactly.
 */
export function decideGapNight(input: GapNightInput): GapNightDecision {
  if (!input.enabled) return { isGap: false, discountPct: null };
  if (input.nights > input.gapFillMinNights + 1) return { isGap: false, discountPct: null };
  if (!input.hasNeighborBefore || !input.hasNeighborAfter) {
    return { isGap: false, discountPct: null };
  }
  const pct = Number(input.discountPct);
  if (!Number.isFinite(pct) || pct <= 0) return { isGap: true, discountPct: null };
  return { isGap: true, discountPct: pct };
}

/**
 * Apply the gap-night discount to an already channel-folded total.
 * Canonical node-side order: rack → channel fold → gap (the arithmetic the
 * signed agent surface already runs live). Returns null when not applicable.
 */
export function applyGapDiscount(
  foldedTotal: number,
  decision: GapNightDecision,
): number | null {
  if (!decision.isGap || !decision.discountPct) return null;
  return Math.round(foldedTotal * (1 - decision.discountPct / 100));
}
