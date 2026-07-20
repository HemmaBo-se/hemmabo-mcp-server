/**
 * Availability Resolver — Source of Truth
 *
 * Checks three layers:
 *   1. property_blocked_dates (iCal syncs, manual blocks)
 *   2. bookings (confirmed, pending)
 *   3. booking_locks (temporary holds during checkout)
 */

import { SupabaseClient } from "@supabase/supabase-js";

// MCP-04b: Pending bookings older than this are ignored by the availability
// check. Stripe Checkout Sessions expire after 24 h by default, after which
// the external stripe-webhook fires checkout.session.expired. Until that path
// also updates the bookings row (NOT PROVEN — see MCP-04a3), a pending row
// with no payment can otherwise block the calendar indefinitely. The 24 h
// cut-off matches Stripe's default session TTL; confirmed bookings are
// unaffected and continue to block regardless of age.
const PENDING_BOOKING_TTL_MS = 24 * 60 * 60 * 1000;

function addUtcDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function overlapsHalfOpen(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA < endB && startB < endA;
}

function blockedEndExclusive(startDate: string, endDate: string): string {
  return endDate <= startDate ? addUtcDays(startDate, 1) : endDate;
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
  excludeLockId?: string
): Promise<AvailabilityResult> {
  // 1. Check blocked dates (overlapping ranges)
  const { data: blocked, error: blockedErr } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date, source")
    .eq("property_id", propertyId)
    .lt("start_date", checkOut)
    .gte("end_date", checkIn);

  // Fail-closed: DB error → treat as unavailable to avoid double-booking
  if (blockedErr) return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (blocked dates query error)" };

  const blockedConflict = (blocked ?? []).some((row: { start_date: string; end_date: string }) =>
    overlapsHalfOpen(
      checkIn,
      checkOut,
      row.start_date,
      blockedEndExclusive(row.start_date, row.end_date),
    ),
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
  let bookingsQuery = supabase
    .from("bookings")
    .select("check_in_date, check_out_date, status")
    .eq("property_id", propertyId)
    .or(`status.eq.confirmed,and(status.eq.pending,created_at.gte.${pendingCutoff})`)
    .lt("check_in_date", checkOut)
    .gt("check_out_date", checkIn);

  if (excludeBookingId) {
    bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
  }

  const { data: bookings, error: bookingsErr } = await bookingsQuery;

  // Fail-closed: DB error → treat as unavailable to avoid double-booking
  if (bookingsErr) return { propertyId, checkIn, checkOut, available: false, reason: "Availability check failed (bookings query error)" };

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
// (floor: 1 night) — so a 2-night gap surfaces even when the request was for 4.
// The old approach only slid a fixed-length window sideways, so shorter gaps
// could never be produced.

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
): Promise<FreeWindow[]> {
  const requestedNights = Math.max(1, nightsBetweenKeys(refCheckIn, refCheckOut));
  const monthStart = monthStartKey(refCheckIn);
  const nextMonthStart = nextMonthStartKey(refCheckIn);
  const scanEnd = addUtcDays(nextMonthStart, ALTERNATIVE_LOOKAHEAD_DAYS);

  // 1. Blocked dates overlapping the scan range.
  const { data: blocked, error: blockedErr } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date")
    .eq("property_id", propertyId)
    .lt("start_date", scanEnd)
    .gte("end_date", monthStart);
  if (blockedErr) return [];

  // 2. Confirmed / fresh-pending bookings (same stale-pending filter as checkAvailability).
  const pendingCutoff = new Date(Date.now() - PENDING_BOOKING_TTL_MS).toISOString();
  const { data: bookings, error: bookingsErr } = await supabase
    .from("bookings")
    .select("check_in_date, check_out_date, status")
    .eq("property_id", propertyId)
    .or(`status.eq.confirmed,and(status.eq.pending,created_at.gte.${pendingCutoff})`)
    .lt("check_in_date", scanEnd)
    .gt("check_out_date", monthStart);
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
    markBlocked(row.start_date, blockedEndExclusive(row.start_date, row.end_date));
  }
  for (const row of bookings ?? []) {
    markBlocked(row.check_in_date, row.check_out_date);
  }
  for (const row of locks ?? []) {
    markBlocked(row.check_in, row.check_out);
  }

  // Emit each maximal run of contiguous free nights whose start is in-month.
  const windows: FreeWindow[] = [];
  const pushWindow = (startKey: string, endExclusiveKey: string) => {
    if (startKey >= nextMonthStart) return; // start must fall within the requested month
    const nights = nightsBetweenKeys(startKey, endExclusiveKey);
    if (nights < 1) return;
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
