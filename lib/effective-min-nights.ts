/**
 * Effective minimum nights — shared core (Layer 3, runtime-agnostic).
 *
 * SINGLE SOURCE for the min-stay MODIFIER logic (gap-fill, last-minute) that
 * sits on top of the ONE min-stay base, `properties.min_nights`
 * (ADR docs/DECISIONS/2026-08-19-min-nights-single-truth.md, PR-3).
 *
 * Before this module the modifier logic lived only in the guest-UI engine
 * (`src/lib/smartPricingEngine.ts` getEffectiveMinNights) while every server
 * decision path refused on the raw base. A host who enabled gap-fill /
 * last-minute therefore saw the guest-UI offer a short stay that the node
 * API, agent endpoints and the signed offer then all refused — the latent
 * split-brain that ADR
 * docs/DECISIONS/2026-08-19-effective-min-nights-live-everywhere.md
 * (CEO decision A) rips out by giving every runtime ONE effective-min truth:
 *
 *   - Node truth      : api/_lib/availability-truth.ts (resolveEffectiveMinNights)
 *   - guest-UI engine : src/lib/smartPricingEngine.ts (getEffectiveMinNights delegates here)
 *   - Deno mirror     : supabase/functions/_shared/... (PR-A2)
 *   - mcp-server      : vendored byte-identical copy (PR-A3)
 *
 * Parity / contract tests pin the copies against this file.
 *
 * DETERMINISM (ADR consequence 1): "today" is an INJECTED UTC day key
 * (YYYY-MM-DD) — never `new Date()` inside the core — and every comparison is
 * a YYYY-MM-DD string compare (lexicographic == chronological) or a
 * UTC-anchored day count via `nightsBetween`. Client and server therefore
 * compute the identical effective minimum regardless of host timezone.
 *
 * The modifiers only ever LOWER the base: gap-fill is `<= base` by
 * construction, and last-minute is the host's own shorter near-term floor.
 */

import { nightsBetween } from "./availability-core.js";

/**
 * Host-configured min-stay MODIFIERS, read from the `property_smart_pricing`
 * row. NOT a base: the base is always `properties.min_nights`, passed
 * separately. `base_minimum_nights` is deprecated and intentionally absent
 * here (ADR 2026-08-19-min-nights-single-truth).
 */
export interface MinNightsModifiers {
  setup_completed: boolean;
  gap_fill_enabled: boolean;
  gap_fill_min_nights: number;
  last_minute_enabled: boolean;
  last_minute_days_before: number;
  last_minute_min_nights: number;
}

/** A neighbouring stay as YYYY-MM-DD keys (half-open [checkIn, checkOut)). */
export interface BookingWindow {
  checkIn: string;
  checkOut: string;
}

/**
 * The effective minimum nights for a stay arriving on `checkIn`.
 *
 * @param baseMinNights        `properties.min_nights` — the ONE base.
 * @param modifiers            `property_smart_pricing` modifiers, or `null`
 *                             when the host has no smart-pricing row (→ base).
 * @param checkIn              requested arrival, YYYY-MM-DD.
 * @param surroundingBookings  the neighbouring confirmed/pending stays used
 *                             for gap detection (the nearest checkout on/before
 *                             the arrival and the nearest checkin after it).
 *                             Empty when there are none.
 * @param todayUtc             injected clock: today's UTC day key, YYYY-MM-DD.
 * @returns the effective minimum — `<= base` when a modifier applies, else the
 *          base unchanged.
 */
export function getEffectiveMinNights(
  baseMinNights: number,
  modifiers: MinNightsModifiers | null,
  checkIn: string,
  surroundingBookings: BookingWindow[],
  todayUtc: string,
): number {
  // Setup not completed (or no row at all) ⇒ modifiers are inert; the raw
  // base rules. This mirrors the engine's `!setup_completed ⇒ base` guard.
  if (!modifiers || !modifiers.setup_completed) return baseMinNights;

  // Last-minute: arrival within `last_minute_days_before` whole UTC days of
  // today ⇒ the host's shorter last-minute floor. A past arrival (negative
  // day count) never qualifies — it is refused as `checkin_in_past` upstream,
  // and we never let a stale request borrow the last-minute floor.
  const daysUntilCheckIn = nightsBetween(todayUtc, checkIn);
  if (
    modifiers.last_minute_enabled &&
    daysUntilCheckIn >= 0 &&
    daysUntilCheckIn <= modifiers.last_minute_days_before
  ) {
    return modifiers.last_minute_min_nights;
  }

  // Gap-fill: arrival sits inside a gap between two neighbouring stays and the
  // gap is no larger than the base ⇒ shrink the floor to fit the gap, never
  // below the host's configured `gap_fill_min_nights`.
  if (modifiers.gap_fill_enabled && surroundingBookings.length > 0) {
    const gapNights = findGapSize(checkIn, surroundingBookings);
    if (gapNights !== null && gapNights <= baseMinNights) {
      return Math.min(modifiers.gap_fill_min_nights, gapNights);
    }
  }

  return baseMinNights;
}

/**
 * The gap (in whole UTC nights) between the two consecutive neighbouring
 * stays that contains `checkIn`, or `null` when `checkIn` is not inside such
 * a gap. Pure and deterministic — YYYY-MM-DD string ordering is chronological.
 */
export function findGapSize(checkIn: string, bookings: BookingWindow[]): number | null {
  const sorted = [...bookings].sort((a, b) =>
    a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0,
  );
  for (let i = 0; i < sorted.length - 1; i++) {
    const currentCheckOut = sorted[i].checkOut;
    const nextCheckIn = sorted[i + 1].checkIn;
    // Half-open: the arrival is in the gap when it lands on/after the previous
    // checkout and strictly before the next checkin.
    if (checkIn >= currentCheckOut && checkIn < nextCheckIn) {
      return nightsBetween(currentCheckOut, nextCheckIn);
    }
  }
  return null;
}
