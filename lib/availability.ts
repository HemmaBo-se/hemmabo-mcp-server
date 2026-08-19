/**
 * Availability Resolver — Source of Truth
 *
 * Checks three layers:
 *   1. property_blocked_dates (manual blocks + channel-manager reservations)
 *   2. bookings (confirmed, pending)
 *   3. booking_locks (temporary holds during checkout)
 *
 * Buffer parity (PR 1b, mirrors the host node's truth path
 * `api/_lib/availability-truth.ts` in hemmabo-smart-stays): the property's
 * turnaround buffer (properties.buffer_nights_before/after) expands bookings
 * and channel-manager blocks (source='channex'); manual and legacy-iCal
 * blocks stay exact (smart-stays ADR 2026-06-24 mirror-exact); booking locks
 * are NEVER buffered. Pure date/overlap/buffer math lives in the vendored
 * shared core `lib/availability-core.ts` — this wrapper must not redeclare
 * anything that lives there (same law as pricing-core).
 */

import { SupabaseClient } from "@supabase/supabase-js";
import {
  addUtcDays,
  blockedEndExclusive,
  DEFAULT_BUFFER_AFTER,
  DEFAULT_BUFFER_BEFORE,
  DEFAULT_MIN_NIGHTS,
  effectiveBlockedRangeForAvailability,
  overlapsHalfOpen,
} from "./availability-core.js";

// MCP-04b: Pending bookings older than this are ignored by the availability
// check. Stripe Checkout Sessions expire after 24 h by default, after which
// the external stripe-webhook fires checkout.session.expired. Until that path
// also updates the bookings row (NOT PROVEN — see MCP-04a3), a pending row
// with no payment can otherwise block the calendar indefinitely. The 24 h
// cut-off matches Stripe's default session TTL; confirmed bookings are
// unaffected and continue to block regardless of age.
//
// A pending row that carries a `stripe_payment_intent_id` is EXEMPT from this
// cut-off: it is not an abandoned checkout, it is a stay with a live payment.
// The ACP path keeps such a booking pending until Stripe reports the money
// settled (api/acp.ts), and async methods can take days — dropping those dates
// back into inventory would let a second guest book them while the first
// guest's payment is still in flight, ending in two confirmed bookings for the
// same nights.
const PENDING_BOOKING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingBookingRow {
  status?: string | null;
  created_at?: string | null;
  stripe_payment_intent_id?: string | null;
}

/**
 * Does this booking row still hold its dates?
 *
 * Confirmed always blocks. A pending row blocks while it is younger than
 * PENDING_BOOKING_TTL_MS, or — at any age — while it carries a PaymentIntent:
 * that is a live payment, not an abandoned checkout, and releasing its nights
 * would let a second guest book them while the first guest's money is still in
 * flight. Anything else is stale and no longer blocks.
 */
export function blocksAvailability(row: PendingBookingRow, pendingCutoffIso: string): boolean {
  if (row.status === "confirmed") return true;
  if (row.status !== "pending") return false;
  if (row.stripe_payment_intent_id) return true;
  return typeof row.created_at === "string" && row.created_at >= pendingCutoffIso;
}

export interface BufferNights {
  before: number;
  after: number;
}

/**
 * Normalize a date input to a plain YYYY-MM-DD key, or null when it cannot be
 * parsed as a real calendar date. `addUtcDays()` throws on an unparseable key
 * (Invalid Date → toISOString), so buffer math must never receive raw caller
 * input unvalidated — bad input degrades to the buffer-less comparison, never
 * a crash. Same guard as smart-stays `api/_lib/availability-batch.ts`.
 */
function toUtcDateKey(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match) return null;
  const key = match[1];
  return Number.isNaN(Date.parse(`${key}T12:00:00Z`)) ? null : key;
}

/**
 * Load the property's turnaround buffer. Mirrors loadAvailabilityRules() in
 * the smart-stays truth path for the two buffer columns: NULL falls back to
 * the 0 default, raw values pass through otherwise, and a QUERY error is
 * reported so callers can fail closed (never "could not read → 0/0").
 * A missing row keeps the defaults — parity with the truth path's documented
 * no-rules fallback.
 */
async function loadBufferNights(
  supabase: SupabaseClient,
  propertyId: string,
): Promise<{ buffers: BufferNights | null; error: boolean }> {
  const { data, error } = await supabase
    .from("properties")
    .select("buffer_nights_before, buffer_nights_after")
    .eq("id", propertyId);
  if (error) return { buffers: null, error: true };
  const row = (data ?? [])[0] as
    | { buffer_nights_before?: number | null; buffer_nights_after?: number | null }
    | undefined;
  return {
    buffers: {
      before: row?.buffer_nights_before ?? DEFAULT_BUFFER_BEFORE,
      after: row?.buffer_nights_after ?? DEFAULT_BUFFER_AFTER,
    },
    error: false,
  };
}

export interface AvailabilityResult {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  available: boolean;
  reason?: string;
}

export async function checkAvailability(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeBookingId?: string,
  excludeLockId?: string,
  buffers?: BufferNights
): Promise<AvailabilityResult> {
  // 0. Resolve the turnaround buffer. Callers that already hold the property
  // row pass it in; otherwise one properties read. Fail-closed on error —
  // "could not read the buffer" must never degrade to the buffer-less
  // comparison, which is exactly the search/truth parity hole PR 1b closes.
  let effectiveBuffers = buffers;
  if (!effectiveBuffers) {
    const loaded = await loadBufferNights(supabase, propertyId);
    if (loaded.error) {
      return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (buffer rules query error)" };
    }
    effectiveBuffers = loaded.buffers ?? { before: DEFAULT_BUFFER_BEFORE, after: DEFAULT_BUFFER_AFTER };
  }
  // Buffer math needs plain YYYY-MM-DD keys; unparseable input degrades to
  // the raw (buffer-less) comparison instead of throwing.
  const checkInKey = toUtcDateKey(checkIn);
  const checkOutKey = toUtcDateKey(checkOut);
  const bufBefore = checkInKey && checkOutKey ? effectiveBuffers.before : 0;
  const bufAfter = checkInKey && checkOutKey ? effectiveBuffers.after : 0;
  // Widen the fetch window so rows whose BUFFERED span reaches into the
  // request are seen; the in-memory overlap check below decides. A before-
  // buffer moves a span's start backwards (widen the END bound); an after-
  // buffer moves its end forwards (widen the START bound). Same two-step as
  // the smart-stays truth path.
  const windowEnd = bufBefore > 0 ? addUtcDays(checkOutKey!, bufBefore) : checkOut;
  const windowStart = bufAfter > 0 ? addUtcDays(checkInKey!, -bufAfter) : checkIn;

  // 1. Check blocked dates (overlapping ranges)
  const { data: blocked, error: blockedErr } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date, source")
    .eq("property_id", propertyId)
    .lt("start_date", windowEnd)
    .gte("end_date", windowStart);

  // Fail-closed: DB error → treat as unavailable to avoid double-booking
  if (blockedErr) return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (blocked dates query error)" };

  // Channel-manager rows (source='channex') are guest stays mirrored from an
  // OTA and get the turnaround buffer; manual and legacy-iCal rows stay exact
  // (smart-stays ADR 2026-06-24 / 2026-08-12). The shared core owns that rule.
  const blockedConflict = (blocked ?? []).some(
    (row: { start_date: string; end_date: string; source?: string | null }) => {
      const effective = effectiveBlockedRangeForAvailability(
        row.start_date,
        row.end_date,
        row.source,
        bufBefore,
        bufAfter,
      );
      return overlapsHalfOpen(checkIn, checkOut, effective.startDate, effective.endDate);
    },
  );

  if (blockedConflict) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates blocked",
    };
  }

  // 2. Check confirmed/pending bookings.
  // MCP-04b: confirmed rows always count; pending rows only count while
  // younger than PENDING_BOOKING_TTL_MS (stale-pending filter).
  const pendingCutoff = new Date(Date.now() - PENDING_BOOKING_TTL_MS).toISOString();
  // Widen the query to every overlapping confirmed or pending row and apply the
  // stale-pending rule in code below. Expressing "pending AND has a payment
  // intent" as a PostgREST `or(...and(...))` string cannot be verified by the
  // test suite (the mocks stub `.or()` out), and a filter that silently parses
  // wrong here would quietly resell occupied dates. Overlapping rows for one
  // property in one date range are few, so reading them costs nothing.
  let bookingsQuery = supabase
    .from("bookings")
    .select("check_in_date, check_out_date, status, created_at, stripe_payment_intent_id")
    .eq("property_id", propertyId)
    .or(`status.eq.confirmed,status.eq.pending`)
    .lt("check_in_date", windowEnd)
    .gt("check_out_date", windowStart);

  if (excludeBookingId) {
    bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
  }

  const { data: bookingRows, error: bookingsErr } = await bookingsQuery;

  // Fail-closed: DB error → treat as unavailable to avoid double-booking
  if (bookingsErr) return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (bookings query error)" };

  // A booking occupies [check_in − before, check_out + after): the turnaround
  // buffer is part of the stay's effective span, exactly like the truth path.
  const bookings = (bookingRows ?? []).filter((row) => {
    if (!blocksAvailability(row as PendingBookingRow, pendingCutoff)) return false;
    const r = row as { check_in_date: string; check_out_date: string };
    const bufferedStart = bufBefore !== 0 ? addUtcDays(r.check_in_date, -bufBefore) : r.check_in_date;
    const bufferedEnd = bufAfter !== 0 ? addUtcDays(r.check_out_date, bufAfter) : r.check_out_date;
    return overlapsHalfOpen(checkIn, checkOut, bufferedStart, bufferedEnd);
  });

  if (bookings?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates already booked",
    };
  }

  // 3. Check active booking locks. A caller re-checking availability while
  // HOLDING a lock must exclude its own lock (excludeLockId), or the re-check
  // deterministically sees the caller's own row and defeats the booking.
  // Locks are NEVER buffered — a lock spans exactly what checkout holds,
  // matching the truth path (which applies no buffer to booking_locks).
  let locksQuery = supabase
    .from("booking_locks")
    .select("id, check_in, check_out, locked_until")
    .eq("property_id", propertyId)
    .gt("locked_until", new Date().toISOString())
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);

  if (excludeLockId) {
    locksQuery = locksQuery.neq("id", excludeLockId);
  }

  const { data: locks, error: locksErr } = await locksQuery;

  // Fail-closed: DB error → treat as unavailable to avoid double-booking
  if (locksErr) return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (locks query error)" };

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

// ── Alternative-date discovery ────────────────────────────────────────────────
//
// When the requested dates are unavailable, agents must be offered concrete
// bookable windows instead of an empty wall. We scan the requested month's
// free nights and emit each MAXIMAL contiguous free run as a candidate window
// (floor: the host's min_nights) — so a 2-night gap surfaces even when the
// request was for 4, but a run the booking engine would refuse as too short
// is never offered. The old approach only slid a fixed-length window
// sideways, so shorter gaps could never be produced.

const ALTERNATIVE_LOOKAHEAD_DAYS = 14;

export interface FreeWindow {
  checkIn: string;
  checkOut: string;
  nights: number;
  shorterThanRequested: boolean;
}

function monthStartKey(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

function nextMonthStartKey(dateKey: string): string {
  const d = new Date(`${dateKey.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function nightsBetweenKeys(startKey: string, endKey: string): number {
  const ms =
    new Date(`${endKey}T12:00:00Z`).getTime() - new Date(`${startKey}T12:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Returns bookable date windows within the requested month, derived from the
 * SAME three availability layers as checkAvailability (blocked dates, bookings,
 * booking locks) so a returned window is free by construction.
 *
 * Each maximal run of contiguous free nights becomes one window. A run whose
 * first night falls within the requested month is kept even if it extends past
 * the month boundary (the same-month clamp is eased on the end side); the scan
 * reaches ALTERNATIVE_LOOKAHEAD_DAYS into the next month so such runs can form.
 * Runs are sorted nearest-to-requested-length first, then nearest to the
 * requested check-in. Fail-closed: any query error yields no windows, so we
 * never surface dates we could not verify.
 */
export async function findFreeWindowsInMonth(
  supabase: SupabaseClient,
  propertyId: string,
  refCheckIn: string,
  refCheckOut: string,
  config?: { minNights?: number | null; buffers?: BufferNights | null },
): Promise<FreeWindow[]> {
  const requestedNights = Math.max(1, nightsBetweenKeys(refCheckIn, refCheckOut));
  const monthStart = monthStartKey(refCheckIn);
  const nextMonthStart = nextMonthStartKey(refCheckIn);
  const scanEnd = addUtcDays(nextMonthStart, ALTERNATIVE_LOOKAHEAD_DAYS);

  // 0. Resolve min-nights + turnaround buffer (one properties read when the
  // caller did not pass them). Fail-closed: an errored read yields no windows
  // — never a window the node's booking engine would then refuse.
  let minNights = config?.minNights ?? null;
  let buffers = config?.buffers ?? null;
  if (minNights == null || buffers == null) {
    const { data, error } = await supabase
      .from("properties")
      .select("min_nights, buffer_nights_before, buffer_nights_after")
      .eq("id", propertyId);
    if (error) return [];
    const row = (data ?? [])[0] as
      | {
          min_nights?: number | null;
          buffer_nights_before?: number | null;
          buffer_nights_after?: number | null;
        }
      | undefined;
    if (minNights == null) minNights = row?.min_nights ?? DEFAULT_MIN_NIGHTS;
    if (buffers == null) {
      buffers = {
        before: row?.buffer_nights_before ?? DEFAULT_BUFFER_BEFORE,
        after: row?.buffer_nights_after ?? DEFAULT_BUFFER_AFTER,
      };
    }
  }
  const nightsFloor = Math.max(1, minNights ?? DEFAULT_MIN_NIGHTS);
  const bufBefore = buffers.before;
  const bufAfter = buffers.after;
  // Widen the fetch window so rows whose buffered span reaches into the scan
  // range are seen; markBlocked() clamps to [monthStart, scanEnd) AFTER the
  // buffer is applied, so the clamp never eats the buffer.
  const fetchEnd = bufBefore > 0 ? addUtcDays(scanEnd, bufBefore) : scanEnd;
  const fetchStart = bufAfter > 0 ? addUtcDays(monthStart, -bufAfter) : monthStart;

  // 1. Blocked dates overlapping the scan range.
  const { data: blocked, error: blockedErr } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date, source")
    .eq("property_id", propertyId)
    .lt("start_date", fetchEnd)
    .gte("end_date", fetchStart);
  if (blockedErr) return [];

  // 2. Confirmed / pending bookings. Widen to every confirmed-or-pending row and
  //    apply the stale-pending rule IN CODE via blocksAvailability — identical to
  //    checkAvailability. This (a) drops the interpolated `and(...created_at...)`
  //    or-string that the test suite cannot verify and that could silently
  //    misparse, and (b) honors the stripe_payment_intent_id exemption: a pending
  //    booking with a live PaymentIntent blocks at any age, so a window held by an
  //    in-flight ACP payment is never suggested as a free alternative.
  const pendingCutoff = new Date(Date.now() - PENDING_BOOKING_TTL_MS).toISOString();
  const { data: bookings, error: bookingsErr } = await supabase
    .from("bookings")
    .select("check_in_date, check_out_date, status, created_at, stripe_payment_intent_id")
    .eq("property_id", propertyId)
    .or(`status.eq.confirmed,status.eq.pending`)
    .lt("check_in_date", fetchEnd)
    .gt("check_out_date", fetchStart);
  if (bookingsErr) return [];

  // 3. Active booking locks.
  const { data: locks, error: locksErr } = await supabase
    .from("booking_locks")
    .select("check_in, check_out, locked_until")
    .eq("property_id", propertyId)
    .gt("locked_until", new Date().toISOString())
    .lt("check_in", scanEnd)
    .gt("check_out", monthStart);
  if (locksErr) return [];

  // Mark every blocked night in the scan range (half-open [start, end)).
  const blockedNights = new Set<string>();
  const markBlocked = (startKey: string, endExclusiveKey: string) => {
    let d = startKey < monthStart ? monthStart : startKey;
    const end = endExclusiveKey > scanEnd ? scanEnd : endExclusiveKey;
    while (d < end) {
      blockedNights.add(d);
      d = addUtcDays(d, 1);
    }
  };
  for (const row of blocked ?? []) {
    // Channel-manager rows are buffer-expanded, manual/legacy-iCal stay exact
    // — same shared-core rule as checkAvailability.
    const effective = effectiveBlockedRangeForAvailability(
      row.start_date,
      row.end_date,
      (row as { source?: string | null }).source,
      bufBefore,
      bufAfter,
    );
    markBlocked(effective.startDate, effective.endDate);
  }
  for (const row of bookings ?? []) {
    // Only rows that actually still hold their dates (confirmed, fresh-pending,
    // or pending-with-a-live-payment) block a suggestable window — same rule as
    // checkAvailability, so an alternative we offer can always be booked.
    // The turnaround buffer is part of the stay's effective span.
    if (blocksAvailability(row as PendingBookingRow, pendingCutoff)) {
      const bufferedStart =
        bufBefore !== 0 ? addUtcDays(row.check_in_date, -bufBefore) : row.check_in_date;
      const bufferedEnd =
        bufAfter !== 0 ? addUtcDays(row.check_out_date, bufAfter) : row.check_out_date;
      markBlocked(bufferedStart, bufferedEnd);
    }
  }
  for (const row of locks ?? []) {
    // Locks are never buffered (parity with checkAvailability and the truth path).
    markBlocked(row.check_in, row.check_out);
  }

  // Emit each maximal run of contiguous free nights whose start is in-month.
  const windows: FreeWindow[] = [];
  const pushWindow = (startKey: string, endExclusiveKey: string) => {
    if (startKey >= nextMonthStart) return; // start must fall within the requested month
    const nights = nightsBetweenKeys(startKey, endExclusiveKey);
    // Respect the host's minimum stay: a window shorter than min_nights is not
    // bookable, so offering it would be a dead end (the booking engine refuses
    // it with min_nights_violation).
    if (nights < nightsFloor) return;
    windows.push({
      checkIn: startKey,
      checkOut: endExclusiveKey,
      nights,
      shorterThanRequested: nights < requestedNights,
    });
  };

  let runStart: string | null = null;
  for (let night = monthStart; night < scanEnd; night = addUtcDays(night, 1)) {
    const isFree = !blockedNights.has(night);
    if (isFree && runStart === null) {
      runStart = night;
    } else if (!isFree && runStart !== null) {
      pushWindow(runStart, night);
      runStart = null;
    }
  }
  if (runStart !== null) pushWindow(runStart, scanEnd);

  // Nearest to the requested trip length first, then nearest to the requested
  // check-in date. Keeps the most relevant window at the front for the cap.
  windows.sort((a, b) => {
    const lenDelta =
      Math.abs(a.nights - requestedNights) - Math.abs(b.nights - requestedNights);
    if (lenDelta !== 0) return lenDelta;
    return (
      Math.abs(nightsBetweenKeys(refCheckIn, a.checkIn)) -
      Math.abs(nightsBetweenKeys(refCheckIn, b.checkIn))
    );
  });

  return windows;
}
