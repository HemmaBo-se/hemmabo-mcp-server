/**
 * Availability Truth — shared core (Layer 3, runtime-agnostic).
 *
 * This module is the **single source** for the pure-logic parts of the
 * availability resolver. Both the Node serverless layer
 * (`api/_lib/availability-truth.ts`) and the Deno edge-function layer
 * (`supabase/functions/_shared/availability-truth.ts`) import from here.
 *
 * The two runtime wrappers still exist because they need a runtime-
 * specific Supabase client (Node: `@supabase/supabase-js` typed; Deno:
 * `any`-typed import) and runtime-specific query helpers (booking lock
 * acquisition, ICS cache). The wrappers must NOT redeclare any constant,
 * type, or pure helper that lives in this file — they import from here.
 *
 * Established by:
 *   docs/DECISIONS/2026-05-01-availability-truth-shared-core.md
 *   (PR 4/5 of the meta-SoT-binding plan).
 *
 * Predecessor ADR:
 *   docs/DECISIONS/2026-04-25-deno-availability-truth-sync.md
 *   — manual hand-sync rule. This PR converts that rule to a code-level
 *   guarantee for the parts contained here. The wrappers' runtime
 *   queries (loadAvailabilityRules body, checkAvailability body, lock
 *   helpers) remain hand-synced as documented in 2026-04-25 until the
 *   future packages/availability-truth-core/ extraction lands.
 */

// ── NULL-fallback defaults for `loadAvailabilityRules()` ────────────────────
//
// Values match the canonical DB-default for each column. When a property
// row has NULL in one of these columns, the resolver returns this value
// instead of a magic number that did NOT match the DB-default. This
// closes the silent policy-extension where the resolver previously
// permitted bookings (e.g. 365-night, 99-guest) that hosts never approved.
//
// Source-of-truth (DB defaults verified on HEAD):
//   min_nights:           2   (NOT NULL DEFAULT 2, migration 20260819120000)
//   max_nights:           30  (migration 20260319120000)
//   max_guests:           2   (migration 20260308000001)
//   buffer_nights_before: 0   (migration 20260319120000)
//   buffer_nights_after:  0   (migration 20260319120000)

export const DEFAULT_MIN_NIGHTS = 2;
export const DEFAULT_MAX_NIGHTS = 30;
export const DEFAULT_MAX_GUESTS = 2;
export const DEFAULT_BUFFER_BEFORE = 0;
export const DEFAULT_BUFFER_AFTER = 0;

// ── Types ───────────────────────────────────────────────────────────────────

export interface AvailabilityConflict {
  type: "blocked_date" | "booking" | "booking_lock";
  startDate: string;
  endDate: string;
  source?: string;
  bookingId?: string;
}

export interface AvailabilityCheckResult {
  available: boolean;
  conflicts: AvailabilityConflict[];
  reason?: string;
  /**
   * Outcome discriminator (BUG_LEDGER P1-13 — fail-closed availability).
   *   "available"   : every source query succeeded and no conflict was found.
   *   "unavailable" : every source query succeeded and ≥1 conflict was found.
   *   "unknown"     : at least one source query errored (transport / DB / parse).
   *                   The result asserts NOTHING about availability. `available`
   *                   is forced `false` so no caller reading `.available` can
   *                   treat an unverifiable check as bookable — but signers and
   *                   payment guards MUST branch on `status === "unknown"` and
   *                   refuse to sign / charge rather than assert `available: false`
   *                   as a fact ("no claim when data is missing").
   * Optional at the type level only so producers/consumers compile during the
   * staged rollout; `checkAvailability` always sets it.
   */
  status?: "available" | "unavailable" | "unknown";
  /** Present only when `status === "unknown"`: which source query failed. */
  checkError?: {
    source: "blocked_dates" | "bookings" | "locks" | "rules";
    message?: string;
  };
}

/**
 * Machine-readable reason codes emitted by the AI Agent Booking Endpoint
 * (`/api/availability`) when `available === false`.
 *
 * AI agents (ChatGPT, Gemini, Claude, Manus, …) read `reasonCode` to decide
 * how to respond to the user without re-prompting the host. Free-text
 * `reason` stays alongside for human/log readability and backwards
 * compatibility — clients on legacy contracts MUST keep working.
 *
 * Adding a new code is additive. Removing or renaming is a breaking
 * contract change and requires an ADR.
 */
export type UnavailabilityReasonCode =
  | "already_booked"
  | "host_blocked"
  | "booking_lock_held"
  | "min_nights_violation"
  | "max_nights_violation"
  | "guests_exceed_max"
  | "checkin_in_past"
  | "checkout_before_checkin"
  | "pricing_not_configured"
  | "pricing_unavailable"
  | "calendar_sync_stale"
  | "calendar_sync_unverified"
  | "beyond_booking_window";

/**
 * A concrete alternative window that the property IS available for,
 * with the canonical price for that window. Used to power AI-agent
 * responses like "Tyvärr upptaget — men 22–25 juni är ledigt, 11 880 kr".
 */
export interface AvailabilityAlternative {
  checkIn: string;
  checkOut: string;
  nights: number;
  pricing?: {
    pricePerNight: number;
    totalPrice: number;
    currency: string;
  };
}

export interface PropertyAvailabilityRules {
  propertyId: string;
  minNights: number;
  maxNights: number;
  maxGuests: number;
  prepDaysBefore: number;
  prepDaysAfter: number;
}

// ── Pure date / overlap helpers ─────────────────────────────────────────────

/**
 * Add `days` to a YYYY-MM-DD date key in UTC and return the resulting
 * YYYY-MM-DD string. Stable across DST because we anchor at noon UTC.
 */
export function addUtcDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Booking window (how far ahead a stay may start) ─────────────────────────

/**
 * Default booking window in months when the host set none. Mirrors the
 * dashboard calendar (`booking_window_months ?? 12`): a null column is
 * enforced as a 12-month window, so the server never becomes a loophole past
 * the limit the UI already draws (ADR 2026-08-08 §B2, parity).
 */
export const DEFAULT_BOOKING_WINDOW_MONTHS = 12;

/**
 * The last date (inclusive, YYYY-MM-DD) a stay may occupy given the host's
 * booking window: `today` + N months. E.g. a 12-month window on 2026-08-08
 * sells through 2027-08-08. `months <= 0` (host disabled the window) → null =
 * no cutoff. Null/undefined months fall back to the 12-month default, matching
 * the dashboard. Anchored at noon UTC so month arithmetic is DST-stable.
 */
export function bookingWindowCutoff(
  today: string,
  months: number | null | undefined,
): string | null {
  const m = months == null ? DEFAULT_BOOKING_WINDOW_MONTHS : months;
  if (!Number.isFinite(m) || m <= 0) return null;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}

/**
 * True when a stay reaches past the booking-window cutoff. The stay's LAST
 * night is `checkOut − 1` (checkOut is exclusive); the whole stay must lie on
 * or before the cutoff, matching the dashboard which makes every cell beyond
 * the window non-selectable. Cutoff `null` (window disabled) → never beyond.
 */
export function isStayBeyondWindow(checkOut: string, cutoff: string | null): boolean {
  if (!cutoff) return false;
  return addUtcDays(checkOut, -1) > cutoff;
}

/**
 * Half-open overlap: [startA, endA) overlaps [startB, endB).
 * Adjacent stays (check-out == next check-in) do NOT overlap.
 */
export function overlapsHalfOpen(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  return startA < endB && startB < endA;
}

/**
 * property_blocked_dates is canonical as [start_date, end_date), but legacy
 * dashboard rows stored a one-day block as start_date == end_date. Normalize
 * those legacy rows at the resolver boundary so every caller can still use
 * half-open overlap while old rows are being migrated.
 */
export function blockedEndExclusive(startDate: string, endDate: string): string {
  return endDate <= startDate ? addUtcDays(startDate, 1) : endDate;
}

export function blockedRangeOverlaps(
  checkIn: string,
  checkOut: string,
  blockStart: string,
  blockEnd: string,
): boolean {
  return overlapsHalfOpen(checkIn, checkOut, blockStart, blockedEndExclusive(blockStart, blockEnd));
}

/**
 * True when a blocked-date row originates from an imported external calendar
 * (Airbnb/Booking/Vrbo iCal), as opposed to a manual host block. Retained for
 * labeling/diagnostics. NOTE: legacy iCal imports are NOT prep-buffered
 * (2026-06-24 decision); channel-manager rows (source='channex') ARE, since
 * 2026-08-12 — see effectiveBlockedRangeForAvailability below.
 */
export function isExternalCalendarBlockSource(source?: string | null): boolean {
  const normalized = (source || "").toLowerCase();
  return normalized === "ical" || normalized === "ical_import" || normalized.startsWith("ical:");
}

/**
 * Effective date span for a blocked-date row in availability math.
 *
 * Decision 2026-08-12 (CEO — supersedes the exact-mirror rule of 2026-06-24
 * for channel-manager rows; docs/DECISIONS/2026-06-24-external-ical-mirror-exact.md
 * carries the supersession note): a `source='channex'` row IS a guest stay —
 * an OTA reservation mirrored by the channel manager — so the property's
 * turnaround buffer (buffer_nights_before/after) expands it exactly like a
 * native `bookings` row. Before this, the prep day showed closed in the host
 * calendar while the booking engine and the Channex ARI push kept selling it
 * (live case 2026-08-12: Booking.com stay [2026-12-29, 2027-01-03) left
 * 2026-12-28 open on Booking/Airbnb). The buffer is per-property config:
 * hosts that want turnover days sellable (the 2026-06-24 rationale) set
 * buffer_nights to 0/0 — the config governs, not a hardcoded exemption.
 *
 * Still EXACT, never buffered: manual host locks (a lock spans exactly what
 * the host drew) and legacy iCal rows (dead in prod since the 2026-08-11
 * purge; the 2026-06-24 exact-mirror rule stands for them).
 */
export function effectiveBlockedRangeForAvailability(
  startDate: string,
  endDate: string,
  source: string | null | undefined,
  prepDaysBefore: number,
  prepDaysAfter: number,
): { startDate: string; endDate: string; buffered: boolean } {
  const endExclusive = blockedEndExclusive(startDate, endDate);
  const isChannelReservation = (source || "").toLowerCase() === "channex";
  const before = isChannelReservation ? prepDaysBefore : 0;
  const after = isChannelReservation ? prepDaysAfter : 0;
  if (before <= 0 && after <= 0) {
    return { startDate, endDate: endExclusive, buffered: false };
  }
  return {
    startDate: addUtcDays(startDate, -Math.max(0, before)),
    endDate: addUtcDays(endExclusive, Math.max(0, after)),
    buffered: true,
  };
}

/**
 * Pure helper: given a list of conflicts (booked / blocked / locked
 * windows) and a target window length in nights, walk forward from
 * `searchFrom` (YYYY-MM-DD, exclusive of conflicts) and return the
 * first {checkIn, checkOut} window of `nights` length that does NOT
 * overlap any conflict.
 *
 * Returns null if no slot fits within `lookAheadDays` of `searchFrom`.
 *
 * This is used by `/api/availability` to emit a `nextAvailable` hint
 * when a requested window is unavailable. The conflicts list MUST be
 * loaded by the runtime wrapper (Node or Deno) using the same canonical
 * tables that `checkAvailability()` reads — never independently.
 */
export function findFirstAvailableWindow(
  conflicts: AvailabilityConflict[],
  searchFrom: string,
  nights: number,
  lookAheadDays: number,
): { checkIn: string; checkOut: string } | null {
  if (nights < 1 || lookAheadDays < 1) return null;

  for (let offset = 0; offset <= lookAheadDays; offset += 1) {
    const candidateIn = addUtcDays(searchFrom, offset);
    const candidateOut = addUtcDays(candidateIn, nights);

    const collides = conflicts.some((c) =>
      overlapsHalfOpen(candidateIn, candidateOut, c.startDate, c.endDate),
    );

    if (!collides) {
      return { checkIn: candidateIn, checkOut: candidateOut };
    }
  }

  return null;
}

/**
 * UTC-anchored night count between two YYYY-MM-DD date keys (DST-safe).
 */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T12:00:00Z`);
  const b = Date.parse(`${checkOut}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * "Shorten in place": when a requested window [checkIn, requestedCheckOut)
 * collides with a conflict, return the longest stay that keeps the requested
 * check-in but leaves on or before the first conflict — i.e. "you can't stay
 * through the 17th, but you can book 6–16". Returns null when the check-in
 * night itself is blocked, when the free prefix is shorter than minNights, or
 * when nothing actually cuts the window.
 *
 * This is the node's OWN availability truth, surfaced so an agent never hits a
 * dead end. It NEVER ranks or compares to another property.
 */
export function largestAvailablePrefix(
  conflicts: AvailabilityConflict[],
  checkIn: string,
  requestedCheckOut: string,
  minNights: number,
): AvailabilityAlternative | null {
  let prefixEnd: string | null = null;
  for (const c of conflicts) {
    if (c.endDate <= checkIn) continue; // conflict ends before arrival — irrelevant
    if (c.startDate >= requestedCheckOut) continue; // conflict starts at/after departure — irrelevant
    const boundary = c.startDate > checkIn ? c.startDate : checkIn;
    if (prefixEnd === null || boundary < prefixEnd) prefixEnd = boundary;
  }
  if (prefixEnd === null) return null; // nothing cuts the window
  if (prefixEnd <= checkIn) return null; // arrival night itself is blocked
  if (prefixEnd >= requestedCheckOut) return null; // whole window free — nothing to shorten
  const nights = nightsBetween(checkIn, prefixEnd);
  if (nights < minNights) return null; // too short to be a valid stay
  return { checkIn, checkOut: prefixEnd, nights };
}

// ── Pure validation ─────────────────────────────────────────────────────────

// ── Refusal-reason single source (zero-tolerance uniformity) ────────────────
//
// THE one place the human refusal sentences live. Every surface that refuses
// a stay — /api/availability, the signed verified-stay-offer, the Deno
// mcp-booking mirror, and any future door — imports these instead of inlining
// a template literal. Before this, three byte-variants of the min-nights
// refusal were live at once ("Minimum stay is 2 nights. Requested 1." vs
// "Minimum stay is 2 nights" vs the bare enum "stay_length_not_allowed") —
// exactly the class of drift the zero-tolerance order forbids. A contract
// gate pins that no emitter re-inlines these sentences.

/** Canonical min-nights refusal sentence — byte-identical on every surface. */
export function minNightsRefusalReason(minNights: number, nights: number): string {
  return `Minimum stay is ${minNights} nights. Requested ${nights}.`;
}

/** Canonical max-nights refusal sentence — byte-identical on every surface. */
export function maxNightsRefusalReason(maxNights: number, nights: number): string {
  return `Maximum stay is ${maxNights} nights. Requested ${nights}.`;
}

/** Canonical guest-capacity refusal sentence — byte-identical on every surface. */
export function maxGuestsRefusalReason(maxGuests: number): string {
  return `Maximum ${maxGuests} guests allowed.`;
}

/**
 * Validate requested night count against per-property rules.
 */
export function validateNightCount(
  nights: number,
  rules: PropertyAvailabilityRules,
): { valid: boolean; reason?: string } {
  if (nights < rules.minNights) {
    return {
      valid: false,
      reason: minNightsRefusalReason(rules.minNights, nights),
    };
  }
  if (nights > rules.maxNights) {
    return {
      valid: false,
      reason: maxNightsRefusalReason(rules.maxNights, nights),
    };
  }
  return { valid: true };
}

/**
 * Validate requested guest count against per-property rules.
 */
export function validateGuestCount(
  guests: number,
  rules: PropertyAvailabilityRules,
): { valid: boolean; reason?: string } {
  if (guests > rules.maxGuests) {
    return {
      valid: false,
      reason: maxGuestsRefusalReason(rules.maxGuests),
    };
  }
  return { valid: true };
}
