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
 *   - Rack quote carries NO per-surface discount. Channel folding stays in
 *     `price-reconciliation.ts` (applyHostDirectPrice) with the pct picked by
 *     `channel-discount.ts` — this core does not re-implement either. The
 *     STAY discount (slider model, ADR 2026-08-13 D3) is a RACK-layer
 *     substitution exactly like packages: rules present ⇒ the ONE winning
 *     rule reprices the stay off the nightly sum and packages are ignored.
 *   - Canonical node-side order: rack (incl. stay rule) → channel fold →
 *     gap-night discount, where a kernel-applied stay discount suppresses
 *     the gap discount (D1: discounts never stack; best single wins).
 *     (Matches the arithmetic live on the signed agent surface, so
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
  /**
   * True when this night's rate is the host's sticky MANUAL price
   * (`property_date_settings.custom_price`), not a season/tier rate. Absent
   * on automated nights (back-compatible). See CustomPriceMap.
   */
  custom_price_applied?: boolean;
}

/**
 * date (YYYY-MM-DD) → the host's manual per-night price in WHOLE currency
 * units (> 0). The "New Year click": a per-date price the host sets in the
 * calendar (`property_date_settings.custom_price`).
 *
 * The manual layer (ADR 2026-08-08 §B1.2) is the top price layer:
 *   - it WINS over every automated layer (seasons, guest tiers, packages),
 *   - it is FLAT for the whole unit — the tier staircase is paused for that
 *     night, which is priced "as the house" regardless of guest count,
 *   - automation NEVER overwrites it (no gap-night discount, no package
 *     collapse over a manual night), and
 *   - the host removes it explicitly; nothing else does.
 * The same map feeds every surface (dashboard calendar, agent/VRP quote, and
 * the OTA/Channex projection) so one number reaches them all.
 */
export type CustomPriceMap = Record<string, number>;

/**
 * The sticky manual price for one night, or null when the host set none.
 * Whole currency units, strictly positive (a 0/negative/NaN entry is treated
 * as "no manual price" — never a free night).
 */
export function customNightlyRate(
  date: string,
  customPrices: CustomPriceMap,
): number | null {
  const v = customPrices[date];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export interface RackQuote {
  success: true;
  /**
   * Sum of nightly rates, or the package total when a package applies, or
   * the stay-discounted sum when the property runs the slider model (ADR
   * 2026-08-13 D3 "ersätt"). NO per-surface discounts (fold/gap) here.
   */
  rackTotal: number;
  nights: number;
  guests: number;
  breakdown: RackNight[];
  package_applied: "week" | "two_weeks" | null;
  /**
   * The ONE winning stay-discount rule when the property has rules configured
   * and one matched (never stacked, D1). null on package-model properties and
   * when no rule matched. Downstream mirrors package_applied: reconciliation
   * emits the neutral `stay_rate` adjustment line exactly like package_rate.
   */
  stay_discount_applied: StayDiscountDecision | null;
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
  customPrices: CustomPriceMap = {},
  stayRules: StayDiscountRule[] = [],
  leadDays: number | null = null,
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
  const hasAnyCustom = Object.keys(customPrices).length > 0;
  // No manual layer in play → the guest tier must resolve exactly as before
  // (byte-identical path for every existing caller). A manual price is flat
  // for the whole unit, so it can price a stay even when the guest count
  // exceeds every tier — but only nights that actually carry one; a
  // non-custom night below still requires the tier and re-raises this error.
  if (!block && !hasAnyCustom) {
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
    // Manual layer wins first (ADR §B1.2): flat for the whole unit — the tier
    // staircase is paused for this night, and season coverage is not required
    // (a host who priced the night made it bookable). season_type is a
    // best-effort label; it never changes the manual price.
    const manual = customNightlyRate(date, customPrices);
    if (manual !== null) {
      const covering = findSeason(date, seasons);
      breakdown.push({
        date,
        day_of_week: dayOfWeekName(date),
        is_weekend: isWeekendDay(date),
        season_type: covering ? covering.type : "low",
        season_name: "Manual price",
        nightly_rate: manual,
        custom_price_applied: true,
      });
      continue;
    }

    if (!block) {
      // Reachable only when customPrices is non-empty but THIS night has no
      // manual price and the guest count exceeds every tier — still not
      // bookable on canonical terms.
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

  // Packages are an AUTOMATED layer — a week/two-week total is a single number
  // that cannot preserve a per-night manual override, so a stay containing any
  // manual night is never collapsed into a package (the manual layer is never
  // overwritten by automation). Packages also need the resolved tier block.
  //
  // Stay-discount mode (ADR 2026-08-13 D3 "ersätt", CEO-approved cutover):
  // ANY configured rule row moves the property to the slider model — the
  // package branch is skipped entirely, even for stays no rule matches.
  // That makes the cutover per property and reversible: delete the rows and
  // packages resume untouched.
  const anyCustomNight = breakdown.some((n) => n.custom_price_applied);
  const stayMode = stayRules.length > 0;
  if (block && !anyCustomNight && !stayMode) {
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
  }

  // The ONE winning stay discount reprices the whole stay off the nightly
  // sum (rack → stay, before any per-surface fold — D1 chain). Manual nights
  // stay sacred exactly like the package rule above: automation never
  // reduces a manual price (§B1), so a stay containing one keeps its exact
  // nightly sum.
  let stayDiscountApplied: StayDiscountDecision | null = null;
  if (stayMode && !anyCustomNight) {
    const decision = resolveStayDiscount(nightDates.length, leadDays, stayRules);
    if (decision) {
      const discounted = applyStayDiscount(nightlySum, decision);
      if (discounted !== null && discounted > 0) {
        rackTotal = discounted;
        stayDiscountApplied = decision;
      }
    }
  }

  return {
    success: true,
    rackTotal,
    nights: nightDates.length,
    guests,
    breakdown,
    package_applied: packageApplied,
    stay_discount_applied: stayDiscountApplied,
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

// ── Stay discounts (nodens standard — "exakt som Airbnb") ──────────
//
// ADR 2026-08-13 rabattmodulen, D1 (låst): the host's base price is always
// the base; discounts sit ON TOP as percentages and the SAME standard
// reaches every surface (website, agents, every channel's own discount system).
// Discounts NEVER stack — one winning rule per stay. The uniform rule model
// mirrors the Airbnb reference the CEO specified:
//   stay_length  threshold = minimum nights   (weekly = 7, monthly = 28,
//                "resans längd" rules = other thresholds)
//   last_minute  threshold = booked ≤ N days before check-in
//   early_bird   threshold = booked ≥ N days before check-in
// LIVE since the consumer wave (PR 2026-08-13/14): every quote door resolves
// these rules via fetchPriceMatrix/canonical-pricing — the pure decision
// stays here, the DB reads stay in the adapters. ⚠️ The MCP server's
// vendored copy (hemmabo-mcp-server/lib/pricing.ts) must gain the same
// support BEFORE any property gets rules (villa activation gate).

export type StayDiscountKind = "stay_length" | "last_minute" | "early_bird";

export interface StayDiscountRule {
  kind: StayDiscountKind;
  /**
   * stay_length: minimum nights. last_minute: booked at most N days before
   * check-in. early_bird: booked at least N days before check-in.
   */
  thresholdUnits: number;
  /** Percent off the rack stay total (0 < pct ≤ 99). */
  pct: number;
}

export interface StayDiscountDecision {
  pct: number;
  kind: StayDiscountKind;
  thresholdUnits: number;
}

/** DB row shape (property_stay_discounts) — adapters pass rows straight in. */
export interface StayDiscountRow {
  kind: string;
  threshold_units: number;
  pct: number;
}

const STAY_DISCOUNT_KINDS: readonly StayDiscountKind[] = [
  "stay_length",
  "last_minute",
  "early_bird",
];

/** Rows → rules; unknown kinds are dropped (forward-compat, never a throw). */
export function stayDiscountRulesFromRows(rows: StayDiscountRow[]): StayDiscountRule[] {
  return rows
    .filter((row): row is StayDiscountRow & { kind: StayDiscountKind } =>
      (STAY_DISCOUNT_KINDS as readonly string[]).includes(row.kind)
    )
    .map((row) => ({
      kind: row.kind,
      thresholdUnits: row.threshold_units,
      pct: row.pct,
    }));
}

/** Deterministic tie-break order: length beats lead-time kinds on equal pct. */
function stayDiscountKindRank(kind: StayDiscountKind): number {
  if (kind === "stay_length") return 0;
  if (kind === "last_minute") return 1;
  return 2;
}

/**
 * Pick the ONE stay discount that applies (D1: discounts never stack — the
 * single best-for-guest eligible rule wins). Airbnb's "om du erbjuder flera
 * rabatter gäller den längsta" falls out of the tie-break: equal percentages
 * prefer stay_length, then the HIGHEST threshold, so outcomes are
 * deterministic and longer commitments never lose to shorter ones.
 *
 * leadDays = whole days from booking moment to check-in (0 = same day).
 * null/undefined disables the two lead-time kinds — callers without a
 * booking timestamp (calendar previews, OTA settings projection) see
 * length discounts only.
 */
export function resolveStayDiscount(
  nights: number,
  leadDays: number | null | undefined,
  rules: StayDiscountRule[],
): StayDiscountDecision | null {
  if (!Number.isFinite(nights) || nights <= 0) return null;
  let best: StayDiscountDecision | null = null;
  for (const rule of rules) {
    const pct = Number(rule.pct);
    const threshold = Number(rule.thresholdUnits);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 99) continue;
    if (!Number.isInteger(threshold) || threshold <= 0) continue;
    let eligible = false;
    if (rule.kind === "stay_length") {
      eligible = nights >= threshold;
    } else if (rule.kind === "last_minute") {
      eligible = typeof leadDays === "number" && leadDays >= 0 && leadDays <= threshold;
    } else if (rule.kind === "early_bird") {
      eligible = typeof leadDays === "number" && leadDays >= threshold;
    }
    if (!eligible) continue;
    const candidate: StayDiscountDecision = { pct, kind: rule.kind, thresholdUnits: threshold };
    if (
      best === null ||
      candidate.pct > best.pct ||
      (candidate.pct === best.pct &&
        stayDiscountKindRank(candidate.kind) < stayDiscountKindRank(best.kind)) ||
      (candidate.pct === best.pct &&
        candidate.kind === best.kind &&
        candidate.thresholdUnits > best.thresholdUnits)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Apply the winning stay discount to a rack stay total (whole currency
 * units, same rounding contract as applyGapDiscount). Chain position and
 * the never-stack rule against the gap discount are the CONSUMER wave's
 * contract (D1: rack → stay discount → channel fold → gap, best single
 * discount wins) — this helper only does the arithmetic.
 */
export function applyStayDiscount(
  rackTotal: number,
  decision: StayDiscountDecision | null,
): number | null {
  if (!decision) return null;
  return Math.round(rackTotal * (1 - decision.pct / 100));
}

/**
 * Whole days from "now" to check-in (0 = same-day arrival) — the booking
 * moment IS the quote moment on every live surface, so lead-time rules
 * (last_minute / early_bird) resolve against the caller's clock. Whole-day
 * boundary on both sides: booking at 14:00 UTC for tonight is lead 0
 * (same-day, last-minute eligible). Past check-in → null, which disables
 * the lead-time kinds.
 */
export function leadDaysUntil(checkIn: string, nowMs: number = Date.now()): number | null {
  const checkInMs = Date.parse(`${checkIn}T00:00:00Z`);
  if (!Number.isFinite(checkInMs)) return null;
  const todayMidnightMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const days = Math.round((checkInMs - todayMidnightMs) / 86_400_000);
  return days >= 0 ? days : null;
}
