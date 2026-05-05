/**
 * Shared tool execution — single source of truth for all 11 federation tools.
 *
 * Transports (api/mcp.ts, src/stdio.ts, src/index.ts) are thin wrappers that:
 *  1. Construct their own Supabase clients (service-role + anon reader).
 *  2. Validate inputs per transport (JSON-Schema or Zod).
 *  3. Delegate tool execution to `executeTool` below.
 *  4. Preserve their own error-handling semantics (e.g. stdio/index wrap
 *     checkout/cancel/reschedule in try/catch with transport-specific messages).
 *
 * This module does NOT catch errors — errors bubble up to the caller so each
 * transport can apply its own error-handling rules unchanged.
 *
 * MCP-06 invariant: bookings-dependent reads (checkAvailability, resolveQuote's
 * gap detection) MUST use the service-role client, because anon is denied on
 * the `bookings` table by RLS (`USING (false)`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveQuote } from "./pricing.js";
import { checkAvailability } from "./availability.js";
import {
  createCheckoutSession,
  retrievePaymentIntent,
  createRefund,
  createPaymentIntent,
} from "../src/stripe.js";

export interface ToolClients {
  /** Service-role client — bypasses RLS. Required for bookings reads + all writes. */
  supabase: SupabaseClient;
  /** Anon client — subject to RLS. Used for published property/snapshot reads. */
  reader: SupabaseClient;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  /**
   * MCP-05: when true, the client must treat this as a tool-level failure
   * rather than a successful tool call whose `content` happens to describe
   * an error. Required by the MCP spec for tool errors; JSON-RPC protocol
   * errors go through a separate channel (`-32603`) and are not set here.
   */
  isError?: boolean;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  // Search tree
  "search.properties": "hemmabo_search_properties",
  "search.availability": "hemmabo_search_availability",
  "search.similar": "hemmabo_search_similar",
  "search.compare": "hemmabo_compare_properties",
  // Booking tree
  "booking.quote": "hemmabo_booking_quote",
  "booking.create": "hemmabo_booking_create",
  "booking.negotiate": "hemmabo_booking_negotiate",
  "booking.checkout": "hemmabo_booking_checkout",
  "booking.cancel": "hemmabo_booking_cancel",
  "booking.status": "hemmabo_booking_status",
  "booking.reschedule": "hemmabo_booking_reschedule",
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns an error string if any of the provided date strings are not YYYY-MM-DD. */
export function validateDates(...dates: (string | undefined)[]): string | null {
  for (const d of dates) {
    if (d !== undefined && !ISO_DATE_RE.test(d)) {
      return `Invalid date format "${d}" — expected YYYY-MM-DD`;
    }
  }
  return null;
}

/** Returns an error string if checkOut is not strictly after checkIn. */
export function validateDateOrder(checkIn: string, checkOut: string): string | null {
  if (checkOut <= checkIn) {
    return `checkOut (${checkOut}) must be strictly after checkIn (${checkIn})`;
  }
  return null;
}

// ── booking_locks helpers ─────────────────────────────────────────────────────

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Attempts to acquire a booking lock for property+date-range.
 * First cleans up any expired locks for that property, then inserts a new one.
 * Returns the lock UUID on success, null if the slot is already locked.
 *
 * Uses service-role client (writes to booking_locks are denied for anon).
 */
async function acquireBookingLock(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string
): Promise<string | null> {
  // 1. Clean up expired locks for this property (best-effort; failure is non-fatal)
  await supabase
    .from("booking_locks")
    .delete()
    .eq("property_id", propertyId)
    .lt("locked_until", new Date().toISOString());

  // 2. Attempt to insert a new lock
  const lockedUntil = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("booking_locks")
    .insert({
      property_id: propertyId,
      check_in: checkIn,
      check_out: checkOut,
      locked_until: lockedUntil,
    })
    .select("id")
    .single();

  if (error || !data) {
    // Unique constraint violation or other DB error → slot already locked.
    // Log without PII for spike / attack detection.
    console.warn(
      JSON.stringify({
        event: "booking_lock_acquire_failed",
        propertyId,
        checkIn,
        checkOut,
        errorCode: error?.code ?? "unknown",
        ts: new Date().toISOString(),
      })
    );
    return null;
  }
  return data.id as string;
}

/**
 * Releases a booking lock by setting locked_until to now (immediate expiry).
 * This makes the row invisible to the active-lock filter in checkAvailability
 * without requiring a DELETE (which could race with another reader).
 * Best-effort: errors are ignored so the call site's finally block never throws.
 */
async function releaseBookingLock(supabase: SupabaseClient, lockId: string): Promise<void> {
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

// ── _runCheckout ──────────────────────────────────────────────────────────────
// Inner implementation for hemmabo_booking_checkout, extracted so it can be
// called from inside the lock try/finally block without duplicating logic.
// The caller holds a booking_lock; this function must NOT release it.

async function _runCheckout(
  supabase: SupabaseClient,
  reader: SupabaseClient,
  prop: { name: string; domain: string | null; host_id: string; currency: string; direct_booking_discount: number | null },
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests: number,
  guestName: string,
  guestEmail: string,
  guestPhone: string | undefined,
  quoteId: string | undefined,
  effectivePaymentMode: string,
  effectiveChannel: string
): Promise<ToolResult> {
  let totalPrice: number;
  let currency: string;
  let nights: number;

  if (quoteId) {
    // Use locked quote from hemmabo_booking_negotiate
    const { data: snapshot, error: snapErr } = await reader
      .from("property_quote_snapshots")
      .select("*")
      .eq("id", quoteId)
      .single();
    if (snapErr || !snapshot) return { content: [{ type: "text", text: JSON.stringify({ error: "Quote not found" }) }], isError: true };
    if (new Date(snapshot.valid_until) < new Date()) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Quote expired", quoteId, validUntil: snapshot.valid_until }) }], isError: true };
    }
    totalPrice = effectiveChannel === "public" ? snapshot.public_total : snapshot.ai_total;
    currency = snapshot.currency;
    nights = snapshot.nights;
  } else {
    // Calculate fresh price.
    // MCP-06: supabase is the service-role client so gap-night detection works.
    const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
    if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }], isError: true };
    totalPrice = effectiveChannel === "public" ? quote.publicTotal : (quote.gapTotal ?? quote.federationTotal);
    currency = quote.currency;
    nights = quote.nights;
  }

  // Create booking record first (MCP-04b: needed to put real UUID into
  // Stripe metadata[booking_id] — previously this was the literal string
  // "pending", which left the external stripe-webhook without a reliable
  // link from Stripe event → booking row).
  const { data: booking, error: bookErr } = await supabase
    .from("bookings")
    .insert({
      property_id: propertyId,
      host_id: prop.host_id,
      check_in_date: checkIn,
      check_out_date: checkOut,
      guests_count: guests,
      guest_name: guestName,
      guest_email: guestEmail,
      guest_phone: guestPhone ?? null,
      total_price: totalPrice,
      currency,
      status: "pending",
      property_name_at_booking: prop.name,
      // stripe_session_id is filled in right after the Stripe session is
      // created below. If that call fails, this row remains with a NULL
      // stripe_session_id — the stale-pending filter in lib/availability.ts
      // ensures it stops blocking the calendar after PENDING_BOOKING_TTL_MS.
    })
    .select("id, status, created_at, guest_token")
    .single();

  if (bookErr) return { content: [{ type: "text", text: JSON.stringify({ error: bookErr.message }) }], isError: true };

  // Create Stripe Checkout Session (now with real booking UUID in metadata)
  const session = await createCheckoutSession({
    amount: totalPrice,
    currency,
    propertyName: prop.name,
    checkIn,
    checkOut,
    guests,
    guestEmail,
    propertyId,
    bookingId: booking.id,
    domain: prop.domain ?? "",
  });

  // Link booking row to Stripe session so the webhook can locate it.
  const { error: updErr } = await supabase
    .from("bookings")
    .update({ stripe_session_id: session.id })
    .eq("id", booking.id);

  if (updErr) return { content: [{ type: "text", text: JSON.stringify({ error: updErr.message }) }], isError: true };

  // Build response
  const result: Record<string, unknown> = {
    reservationId: booking.id,
    status: booking.status,
    paymentUrl: session.url,
    propertyId,
    checkIn,
    checkOut,
    nights,
    guests,
    totalPrice,
    currency,
    payment_modes: ["checkout_session", "payment_intent"],
    createdAt: booking.created_at,
  };

  // MPP enrichment: if payment_intent mode, retrieve client_secret.
  // SECURITY NOTE: client_secret and payment_intent_id are intentionally
  // returned here — this is required by the Stripe Mobile Payment Protocol
  // (MPP) so the agent/client SDK can confirm the payment directly without
  // a redirect. Do not remove these fields without a separate policy decision.
  if (effectivePaymentMode === "payment_intent" && session.payment_intent) {
    const pi = await retrievePaymentIntent(session.payment_intent);
    result.mpp = {
      protocol: "stripe-mpp",
      version: "2025-03-17",
      payment_intent_id: pi.id,
      client_secret: pi.client_secret,
      amount: totalPrice,
      currency,
      supported_payment_methods: ["card", "klarna", "swish", "link"],
      confirmation_url: session.url,
    };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  clients: ToolClients
): Promise<ToolResult> {
  const { supabase, reader } = clients;
  const canonicalName = normalizeToolName(name);

  switch (canonicalName) {
    case "hemmabo_search_properties": {
      const { region, country, guests, checkIn, checkOut } = args as {
        region?: string; country?: string; guests: number; checkIn: string; checkOut: string;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      let query = reader
        .from("properties")
        .select("id, name, domain, region, city, country, max_guests, currency, property_type, direct_booking_discount")
        .eq("published", true)
        .gte("max_guests", guests);

      if (region) query = query.ilike("region", `%${region}%`);
      if (country) query = query.ilike("country", `%${country}%`);

      const { data: properties, error } = await query;
      if (error) return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };

      const results = [];
      for (const prop of properties ?? []) {
        // MCP-06: use service-role client so bookings table is visible to availability/gap checks
        const avail = await checkAvailability(supabase, prop.id, checkIn, checkOut);
        if (!avail.available) continue;
        const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, guests);
        if ("error" in quote) continue;
        results.push({
          propertyId: prop.id, name: prop.name, domain: prop.domain,
          region: prop.region, city: prop.city, country: prop.country,
          maxGuests: prop.max_guests, propertyType: prop.property_type,
          currency: quote.currency, nights: quote.nights,
          publicTotal: quote.publicTotal, federationTotal: quote.federationTotal,
          federationDiscountPercent: quote.federationDiscountPercent,
          packageApplied: quote.packageApplied, available: true,
        });
      }

      return { content: [{ type: "text", text: JSON.stringify({ checkIn, checkOut, guests, properties: results }, null, 2) }] };
    }

    case "hemmabo_search_availability": {
      const { propertyId, checkIn, checkOut } = args as { propertyId: string; checkIn: string; checkOut: string };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };
      // MCP-06: use service-role client so bookings table is visible to availability checks
      const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "hemmabo_search_similar": {
      const { propertyId, checkIn, checkOut, guests, limit } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests?: number; limit?: number;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      const { data: src, error: srcErr } = await reader
        .from("properties")
        .select("region, country, property_type, max_guests, published")
        .eq("id", propertyId)
        .single();
      if (srcErr || !src) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Source property not found" }) }], isError: true };
      }

      const effectiveGuests = guests ?? src.max_guests ?? 2;
      const max = limit ?? 5;

      let query = reader
        .from("properties")
        .select("id, name, domain, region, city, country, max_guests, currency, property_type, direct_booking_discount")
        .eq("published", true)
        .neq("id", propertyId)
        .gte("max_guests", effectiveGuests);
      if (src.region) query = query.ilike("region", `%${src.region}%`);
      else if (src.country) query = query.ilike("country", `%${src.country}%`);
      if (src.property_type) query = query.eq("property_type", src.property_type);

      const { data: candidates, error: qErr } = await query.limit(max * 3);
      if (qErr) return { content: [{ type: "text", text: JSON.stringify({ error: qErr.message }) }], isError: true };

      const results: any[] = [];
      for (const prop of candidates ?? []) {
        if (results.length >= max) break;
        // MCP-06: use service-role client so bookings table is visible to availability/gap checks
        const avail = await checkAvailability(supabase, prop.id, checkIn, checkOut);
        if (!avail.available) continue;
        const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, effectiveGuests);
        if ("error" in quote) continue;
        results.push({
          propertyId: prop.id,
          name: prop.name, domain: prop.domain,
          region: prop.region, city: prop.city, country: prop.country,
          maxGuests: prop.max_guests, propertyType: prop.property_type,
          currency: quote.currency, nights: quote.nights,
          publicTotal: quote.publicTotal, federationTotal: quote.federationTotal,
          federationDiscountPercent: quote.federationDiscountPercent,
          packageApplied: quote.packageApplied, available: true,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sourcePropertyId: propertyId, checkIn, checkOut,
            guests: effectiveGuests, count: results.length,
            similarProperties: results,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_compare_properties": {
      const { propertyIds, checkIn, checkOut, guests } = args as {
        propertyIds: string[]; checkIn: string; checkOut: string; guests: number;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };
      if (!Array.isArray(propertyIds) || propertyIds.length < 2 || propertyIds.length > 10) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "propertyIds must contain 2 to 10 UUIDs" }) }], isError: true };
      }

      const comparisons = await Promise.all(
        propertyIds.map(async (id) => {
          const { data: prop } = await reader
            .from("properties")
            .select("id, name, domain, region, city, country, max_guests, property_type, published")
            .eq("id", id)
            .single();
          if (!prop || !prop.published) {
            return { propertyId: id, available: false, error: "Property not found or not published" };
          }
          // MCP-06: use service-role client so bookings table is visible to availability/gap checks
          const avail = await checkAvailability(supabase, id, checkIn, checkOut);
          if (!avail.available) {
            return { propertyId: prop.id, name: prop.name, domain: prop.domain, available: false, reason: avail };
          }
          const quote = await resolveQuote(supabase, id, checkIn, checkOut, guests);
          if ("error" in quote) {
            return { propertyId: prop.id, name: prop.name, domain: prop.domain, available: true, error: quote.error };
          }
          return {
            propertyId: prop.id,
            name: prop.name, domain: prop.domain,
            region: prop.region, city: prop.city, country: prop.country,
            maxGuests: prop.max_guests, propertyType: prop.property_type,
            currency: quote.currency, nights: quote.nights,
            publicTotal: quote.publicTotal, federationTotal: quote.federationTotal,
            gapTotal: quote.gapTotal,
            federationDiscountPercent: quote.federationDiscountPercent,
            packageApplied: quote.packageApplied, available: true,
          };
        })
      );

      comparisons.sort((a: any, b: any) => {
        if (a.available && !b.available) return -1;
        if (!a.available && b.available) return 1;
        const ap = typeof a.federationTotal === "number" ? a.federationTotal : Infinity;
        const bp = typeof b.federationTotal === "number" ? b.federationTotal : Infinity;
        return ap - bp;
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ checkIn, checkOut, guests, count: comparisons.length, comparison: comparisons }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_quote": {
      const { propertyId, checkIn, checkOut, guests } = args as { propertyId: string; checkIn: string; checkOut: string; guests: number };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };
      // MCP-06: use service-role client so gap-night detection (reads bookings) works
      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      // MCP-05: resolveQuote may return { error: ... } — surface as MCP tool error, not success.
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(quote, null, 2) }] };
    }

    case "hemmabo_booking_create": {
      const { propertyId, checkIn, checkOut, guests, guestName, guestEmail, guestPhone } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
        guestName: string; guestEmail: string; guestPhone?: string;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      // MCP-06: use service-role client so bookings table is visible to availability/gap checks
      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...avail }) }], isError: true };

      // Acquire a short-term booking lock to close the TOCTOU window between
      // the availability check above and the insert below.
      const lockId = await acquireBookingLock(supabase, propertyId, checkIn, checkOut);
      if (!lockId) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Dates temporarily locked — another booking is in progress. Please try again shortly." }) }], isError: true };
      }

      let bookingCreateResult: ToolResult;
      try {
        // Re-check availability under lock to guard against concurrent requests
        // that passed the first check before the lock was acquired.
        const availUnderLock = await checkAvailability(supabase, propertyId, checkIn, checkOut);
        if (!availUnderLock.available) {
          bookingCreateResult = { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...availUnderLock }) }], isError: true };
        } else {
          const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
          if ("error" in quote) {
            bookingCreateResult = { content: [{ type: "text", text: JSON.stringify(quote) }], isError: true };
          } else {
            const totalPrice = quote.gapTotal ?? quote.federationTotal;
            const { data: prop } = await reader.from("properties").select("name, host_id").eq("id", propertyId).single();

            const { data: booking, error: bookErr } = await supabase
              .from("bookings")
              .insert({
                property_id: propertyId, host_id: prop?.host_id,
                check_in_date: checkIn, check_out_date: checkOut,
                guests_count: guests, guest_name: guestName,
                guest_email: guestEmail, guest_phone: guestPhone ?? null,
                total_price: totalPrice, currency: quote.currency,
                status: "pending", property_name_at_booking: prop?.name ?? null,
                host_approval_required: true,
              })
              .select("id, status, created_at")
              .single();

            if (bookErr) {
              bookingCreateResult = { content: [{ type: "text", text: JSON.stringify({ error: bookErr.message }) }], isError: true };
            } else {
              bookingCreateResult = {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    bookingId: booking.id, status: booking.status, propertyId,
                    checkIn, checkOut, nights: quote.nights, guests, totalPrice,
                    currency: quote.currency,
                    priceType: quote.gapTotal ? "gap_night" : (quote.packageApplied ? `package_${quote.packageApplied}` : "federation"),
                    packageApplied: quote.packageApplied,
                    federationDiscountPercent: quote.federationDiscountPercent,
                    gapDiscountPercent: quote.gapDiscountPercent, createdAt: booking.created_at,
                  }, null, 2),
                }],
              };
            }
          }
        }
      } finally {
        await releaseBookingLock(supabase, lockId);
      }
      return bookingCreateResult;
    }

    case "hemmabo_booking_negotiate": {
      const { propertyId, checkIn, checkOut, guests } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      // MCP-06: use service-role client so gap-night detection (reads bookings) works
      const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }], isError: true };

      // Fetch property domain for snapshot
      const { data: prop } = await reader.from("properties").select("domain").eq("id", propertyId).single();

      const validUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const { data: snapshot, error: snapErr } = await supabase
        .from("property_quote_snapshots")
        .insert({
          property_id: propertyId,
          domain: prop?.domain ?? null,
          stay_start: checkIn,
          stay_end: checkOut,
          nights: quote.nights,
          requested_guests: guests,
          currency: quote.currency,
          source_version: "3.2.7",
          valid_until: validUntil,
          public_total: quote.publicTotal,
          ai_total: quote.federationTotal,
          ai_discount_pct: quote.federationDiscountPercent,
          segments_detail: quote.breakdown.nightlyRates.map(n => ({
            date: n.date,
            rate: n.rate,
            season: n.season,
            dayType: n.dayType,
          })),
          status: "ok",
        })
        .select("id")
        .single();

      if (snapErr) return { content: [{ type: "text", text: JSON.stringify({ error: snapErr.message }) }], isError: true };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            propertyId,
            checkIn,
            checkOut,
            guests,
            nights: quote.nights,
            currency: quote.currency,
            publicTotal: quote.publicTotal,
            federationTotal: quote.federationTotal,
            federationDiscountPercent: quote.federationDiscountPercent,
            breakdown: quote.breakdown,
            packageApplied: quote.packageApplied,
            gapNight: quote.gapNight,
            gapTotal: quote.gapTotal,
            gapDiscountPercent: quote.gapDiscountPercent,
            quoteId: snapshot.id,
            validUntil,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_checkout": {
      const {
        propertyId, checkIn, checkOut, guests, guestName, guestEmail,
        guestPhone, quoteId, paymentMode, channel,
      } = args as {
        propertyId: string; checkIn: string; checkOut: string; guests: number;
        guestName: string; guestEmail: string; guestPhone?: string;
        quoteId?: string; paymentMode?: string; channel?: string;
      };

      const effectivePaymentMode = paymentMode ?? "checkout_session";
      const effectiveChannel = channel ?? "federation";

      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      // Fetch property
      const { data: prop, error: propErr } = await reader
        .from("properties")
        .select("name, domain, host_id, currency, direct_booking_discount")
        .eq("id", propertyId)
        .single();
      if (propErr || !prop) return { content: [{ type: "text", text: JSON.stringify({ error: "Property not found" }) }], isError: true };

      // Check availability
      // MCP-06: use service-role client so bookings table is visible to availability checks
      const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...avail }) }], isError: true };

      // Acquire a short-term booking lock to close the TOCTOU window between
      // the availability check above and the booking insert below.
      const lockId = await acquireBookingLock(supabase, propertyId, checkIn, checkOut);
      if (!lockId) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Dates temporarily locked — another booking is in progress. Please try again shortly." }) }], isError: true };
      }

      let checkoutResult: ToolResult;
      try {
        // Re-check availability under lock to guard against concurrent requests
        // that passed the first check before the lock was acquired.
        const availUnderLock = await checkAvailability(supabase, propertyId, checkIn, checkOut);
        if (!availUnderLock.available) {
          checkoutResult = { content: [{ type: "text", text: JSON.stringify({ error: "Not available", ...availUnderLock }) }], isError: true };
        } else {
          checkoutResult = await _runCheckout(
            supabase, reader, prop, propertyId, checkIn, checkOut, guests,
            guestName, guestEmail, guestPhone, quoteId, effectivePaymentMode, effectiveChannel
          );
        }
      } finally {
        // Release lock regardless of outcome — Stripe failures must not leave
        // a dangling lock that blocks the calendar for 10 minutes.
        await releaseBookingLock(supabase, lockId);
      }
      return checkoutResult;
    }

    case "hemmabo_booking_cancel": {
      const { reservationId, reason } = args as { reservationId: string; reason?: string };

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, guest_token, check_in_date, check_out_date, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }], isError: true };
      if (booking.status === "cancelled") return { content: [{ type: "text", text: JSON.stringify({ error: "Booking is already cancelled", reservationId }) }], isError: true };

      // Delegate to Supabase Edge Function
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const cancelResp = await fetch(`${supabaseUrl}/functions/v1/cancel-booking`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          bookingId: booking.id,
          guestToken: booking.guest_token,
          reason: reason ?? "Cancelled via MCP",
        }),
      });

      if (!cancelResp.ok) {
        const errBody = await cancelResp.text();
        return { content: [{ type: "text", text: JSON.stringify({ error: `Cancel failed: ${errBody}` }) }], isError: true };
      }

      const cancelResult = await cancelResp.json();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId: booking.id,
            status: "cancelled",
            refund: cancelResult.refund ?? null,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_status": {
      const { reservationId } = args as { reservationId: string };

      // Uses service role — booking lookup by UUID is a privileged operation
      // (only authenticated MCP agents with a valid API key reach this point).
      // The anon client cannot look up bookings without a guest_token JWT claim.
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, guest_name, guest_email, created_at, updated_at")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }], isError: true };

      // Fetch property
      const { data: prop } = await supabase
        .from("properties")
        .select("name, domain")
        .eq("id", booking.property_id)
        .single();

      // Fetch cancellation policy
      const { data: policy } = await supabase
        .from("host_policies")
        .select("cancellation_tier, refund_rules")
        .eq("property_id", booking.property_id)
        .single();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId: booking.id,
            status: booking.status,
            propertyId: booking.property_id,
            propertyName: prop?.name ?? null,
            propertyDomain: prop?.domain ?? null,
            checkIn: booking.check_in_date,
            checkOut: booking.check_out_date,
            guests: booking.guests_count,
            totalPrice: booking.total_price,
            currency: booking.currency,
            guestName: booking.guest_name
              // PII: mask full name — show first name + last initial only (e.g. "Anna S.")
              ? (() => {
                  const parts = (booking.guest_name as string).trim().split(/\s+/);
                  return parts.length >= 2
                    ? `${parts[0]} ${parts[parts.length - 1][0]}.`
                    : parts[0];
                })()
              : null,
            // PII: mask email — show only first char + domain so agents can confirm identity without exposing full address
            guestEmail: booking.guest_email
              ? booking.guest_email.replace(/^(.)([^@]*)(@.+)$/, "$1***$3")
              : null,
            cancellationPolicy: policy ? {
              tier: policy.cancellation_tier,
              refundRules: policy.refund_rules,
            } : null,
            createdAt: booking.created_at,
            updatedAt: booking.updated_at,
          }, null, 2),
        }],
      };
    }

    case "hemmabo_booking_reschedule": {
      const { reservationId, newCheckIn, newCheckOut, reason } = args as {
        reservationId: string; newCheckIn: string; newCheckOut: string; reason?: string;
      };
      const dateErr = validateDates(newCheckIn, newCheckOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(newCheckIn, newCheckOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      const RESCHEDULABLE_STATES = ["confirmed", "pending"];

      // Fetch booking
      const { data: booking, error: bookErr } = await supabase
        .from("bookings")
        .select("id, status, check_in_date, check_out_date, guests_count, total_price, currency, property_id, stripe_payment_intent_id")
        .eq("id", reservationId)
        .single();

      if (bookErr || !booking) return { content: [{ type: "text", text: JSON.stringify({ error: "Booking not found" }) }], isError: true };
      if (!RESCHEDULABLE_STATES.includes(booking.status)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Booking status '${booking.status}' is not reschedulable. Must be: ${RESCHEDULABLE_STATES.join(", ")}` }) }], isError: true };
      }

      // Idempotency: same dates = no-op
      if (booking.check_in_date === newCheckIn && booking.check_out_date === newCheckOut) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reservationId: booking.id,
              status: booking.status,
              message: "No change — new dates match current dates",
              checkIn: booking.check_in_date,
              checkOut: booking.check_out_date,
            }, null, 2),
          }],
        };
      }

      // Check availability (excluding this booking)
      // MCP-06: use service-role client so bookings table is visible to availability/gap checks
      const avail = await checkAvailability(supabase, booking.property_id, newCheckIn, newCheckOut, booking.id);
      if (!avail.available) return { content: [{ type: "text", text: JSON.stringify({ error: "New dates not available", ...avail }) }], isError: true };

      // Calculate new price
      const quote = await resolveQuote(supabase, booking.property_id, newCheckIn, newCheckOut, booking.guests_count);
      if ("error" in quote) return { content: [{ type: "text", text: JSON.stringify(quote) }], isError: true };

      const newPrice = quote.gapTotal ?? quote.federationTotal;
      const oldPrice = booking.total_price;
      const delta = newPrice - oldPrice;

      let stripeAction: Record<string, unknown> | null = null;

      if (delta > 0 && booking.stripe_payment_intent_id) {
        // Price increased: create new PaymentIntent with manual capture
        const pi = await createPaymentIntent({
          amount: delta,
          currency: booking.currency,
          captureMethod: "manual",
          metadata: {
            booking_id: booking.id,
            type: "reschedule_delta",
            original_payment_intent: booking.stripe_payment_intent_id,
          },
        });
        stripeAction = { type: "additional_charge", amount: delta, paymentIntentId: pi.id, status: pi.status };
      } else if (delta < 0 && booking.stripe_payment_intent_id) {
        // Price decreased: partial refund
        const refund = await createRefund(booking.stripe_payment_intent_id, Math.abs(delta));
        stripeAction = { type: "partial_refund", amount: Math.abs(delta), refundId: refund.id, status: refund.status };
      }

      // Update booking
      const { error: updateErr } = await supabase
        .from("bookings")
        .update({
          check_in_date: newCheckIn,
          check_out_date: newCheckOut,
          total_price: newPrice,
        })
        .eq("id", booking.id);

      if (updateErr) return { content: [{ type: "text", text: JSON.stringify({ error: updateErr.message }) }], isError: true };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId: booking.id,
            status: booking.status,
            previousDates: { checkIn: booking.check_in_date, checkOut: booking.check_out_date },
            newDates: { checkIn: newCheckIn, checkOut: newCheckOut },
            pricing: {
              previousPrice: oldPrice,
              newPrice,
              delta,
              currency: booking.currency,
              stripeAction,
            },
            reason: reason ?? null,
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }
}
