/**
 * booking_locks primitive — shared by the MCP booking tools (lib/tools-base.ts)
 * and the ACP checkout endpoint (api/acp.ts).
 *
 * Extracted verbatim from lib/tools-base.ts (no behavior change) so both call
 * paths acquire and release locks through ONE implementation and cannot drift.
 * The MCP-transport-shaped error result (lockErrorResult) stays in tools-base;
 * this module is transport-agnostic and returns a plain discriminated result.
 *
 * A booking_locks row is a short-lived hold on (property, date-range) that
 * closes the TOCTOU window between an availability check and the booking
 * insert. The table has a gist no-overlap exclusion constraint, so a second
 * overlapping insert fails with 23P01 — that is the conflict signal below.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Postgres error codes that mean the slot is genuinely held by a live lock:
 *   23P01 exclusion_violation — booking_locks_no_overlap (gist, property+daterange)
 *   23505 unique_violation    — defensive, in case a unique slot index is added
 * Any other code (23502 not-null, 23514 check, RLS denial, …) is an internal
 * defect, NOT a date conflict, and must never be reported as "already locked".
 */
export const LOCK_CONFLICT_CODES = new Set(["23P01", "23505"]);

export type LockAcquireResult = { lockId: string } | { lockError: "conflict" | "db_error" };

/**
 * Attempts to acquire a booking lock for property+date-range.
 * First cleans up any expired locks for that property, then inserts a new one.
 * Returns { lockId } on success, { lockError: "conflict" } when another live
 * lock holds the slot, and { lockError: "db_error" } on any other DB failure.
 *
 * Uses service-role client (writes to booking_locks are denied for anon).
 */
export async function acquireBookingLock(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string
): Promise<LockAcquireResult> {
  // 1. Clean up expired locks for this property (best-effort; failure is non-fatal)
  await supabase
    .from("booking_locks")
    .delete()
    .eq("property_id", propertyId)
    .lt("locked_until", new Date().toISOString());

  // 2. Attempt to insert a new lock. booking_locks.source is NOT NULL with a
  //    CHECK constraint ('hemmabo','ai_agent','guest','system'); this path is
  //    always an agent flow, matching mcp-booking's acquireBookingLock call.
  const lockedUntil = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("booking_locks")
    .insert({
      property_id: propertyId,
      check_in: checkIn,
      check_out: checkOut,
      locked_until: lockedUntil,
      source: "ai_agent",
    })
    .select("id")
    .single();

  if (error || !data) {
    const errorCode = error?.code ?? "unknown";
    // Log without PII for spike / attack detection.
    console.warn(
      JSON.stringify({
        event: "booking_lock_acquire_failed",
        propertyId,
        checkIn,
        checkOut,
        errorCode,
        ts: new Date().toISOString(),
      })
    );
    return { lockError: LOCK_CONFLICT_CODES.has(errorCode) ? "conflict" : "db_error" };
  }
  return { lockId: data.id as string };
}

/**
 * Releases a booking lock by setting locked_until to now (immediate expiry).
 * This makes the row invisible to the active-lock filter in checkAvailability
 * without requiring a DELETE (which could race with another reader).
 * Best-effort: errors are ignored so the call site's finally block never throws.
 */
export async function releaseBookingLock(supabase: SupabaseClient, lockId: string): Promise<void> {
  try {
    await supabase
      .from("booking_locks")
      .update({ locked_until: new Date().toISOString() })
      .eq("id", lockId);
  } catch (err) {
    // Non-fatal: lock will expire naturally after LOCK_TTL_MS.
    // Log so on-call can detect if DB is unreachable during cleanup.
    console.warn(
      JSON.stringify({
        event: "booking_lock_release_failed",
        lockId,
        ts: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
