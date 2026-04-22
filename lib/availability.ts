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

export interface AvailabilityResult {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  available: boolean;
  reason?: string;
  conflictDates?: string[];
}

export async function checkAvailability(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeBookingId?: string
): Promise<AvailabilityResult> {
  // 1. Check blocked dates (overlapping ranges)
  const { data: blocked } = await supabase
    .from("property_blocked_dates")
    .select("start_date, end_date, source")
    .eq("property_id", propertyId)
    .lt("start_date", checkOut)
    .gt("end_date", checkIn);

  if (blocked?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates blocked",
      conflictDates: blocked.map(
        (b) => `${b.start_date} to ${b.end_date} (${b.source})`
      ),
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

  const { data: bookings } = await bookingsQuery;

  if (bookings?.length) {
    return {
      propertyId,
      checkIn,
      checkOut,
      available: false,
      reason: "Dates already booked",
      conflictDates: bookings.map(
        (b) => `${b.check_in_date} to ${b.check_out_date} (${b.status})`
      ),
    };
  }

  // 3. Check active booking locks
  const { data: locks } = await supabase
    .from("booking_locks")
    .select("check_in, check_out, locked_until")
    .eq("property_id", propertyId)
    .gt("locked_until", new Date().toISOString())
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);

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
