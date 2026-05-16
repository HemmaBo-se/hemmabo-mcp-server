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
  excludeBookingId?: string
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

  // 3. Check active booking locks
  const { data: locks, error: locksErr } = await supabase
    .from("booking_locks")
    .select("check_in, check_out, locked_until")
    .eq("property_id", propertyId)
    .gt("locked_until", new Date().toISOString())
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);

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
