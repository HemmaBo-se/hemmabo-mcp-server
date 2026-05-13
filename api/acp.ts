/**
 * Agentic Commerce Protocol (ACP) endpoint — Stripe spec compliant
 * https://docs.stripe.com/agentic-commerce/protocol/specification
 *
 * Routes:
 *   POST   /acp/checkouts           → Create checkout session
 *   GET    /acp/checkouts/:id       → Retrieve checkout state
 *   PUT    /acp/checkouts/:id       → Update checkout (dates, guests)
 *   POST   /acp/checkouts/:id/complete → Complete with SharedPaymentToken
 *   POST   /acp/checkouts/:id/cancel   → Cancel checkout
 *
 * This endpoint implements Stripe's Agentic Commerce Protocol so AI
 * agents can book and pay without a browser redirect.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { resolveQuote } from "../lib/pricing.js";
import { checkAvailability } from "../lib/availability.js";
import { validateApiKey } from "../src/auth.js";
import { baseUrl } from "../lib/base-url.js";
import {
  fingerprint as idemFingerprint,
  lookup as idemLookup,
  normaliseIdempotencyKey,
  record as idemRecord,
} from "../lib/idempotency.js";
import {
  anonIdentifier,
  bearerIdentifier,
  checkRateLimit,
} from "../lib/rate-limit.js";
import { toStripeMinorUnits } from "../src/stripe.js";

// ── Helpers ──────────────────────────────────────────────────────

// Service-role client — bypasses RLS. Use only for writes (insert/update/delete).
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// Anon client — subject to RLS. Use for all read-only queries.
function getSupabaseReader() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, key);
}

function getStripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return key;
}

// ── ACP response builder ─────────────────────────────────────────

interface ACPCheckoutState {
  id: string;
  status: "not_ready_for_payment" | "ready_for_payment" | "completed" | "canceled" | "in_progress";
  currency: string;
  buyer?: {
    first_name: string;
    last_name: string;
    email: string;
    phone_number?: string;
  };
  line_items: {
    id: string;
    item: { id: string; quantity: number };
    base_amount: number;
    discount: number;
    total: number;
    subtotal: number;
    tax: number;
  }[];
  fulfillment_options: {
    type: "digital";
    id: string;
    title: string;
    subtitle?: string;
    subtotal: number;
    tax: number;
    total: number;
  }[];
  fulfillment_option_id?: string;
  totals: { type: string; display_text: string; amount: number }[];
  payment_provider?: {
    provider: string;
    supported_payment_methods: string[];
  };
  messages: { type: string; text: string }[];
  links: { rel: string; href: string }[];
  // HemmaBo-specific metadata
  metadata?: Record<string, unknown>;
}

async function buildACPState(bookingId: string, base: string): Promise<ACPCheckoutState | null> {
  const supabase = getSupabase();
  const { data: booking, error } = await supabase
    .from("bookings")
    .select("*, properties(name, domain, currency, region, city, country, property_type)")
    .eq("id", bookingId)
    .single();

  if (error || !booking) return null;

  const prop = booking.properties;
  const status = mapStatus(booking.status);
  const totalAmountCents = toStripeMinorUnits(booking.total_price); // ACP uses smallest currency unit
  const nights = Math.round(
    (new Date(booking.check_out_date).getTime() - new Date(booking.check_in_date).getTime()) / 86400000
  );

  const nameParts = (booking.guest_name || "").split(" ");

  return {
    id: booking.id,
    status,
    currency: (booking.currency || "SEK").toLowerCase(),
    buyer: booking.guest_name ? {
      first_name: nameParts[0] || "",
      last_name: nameParts.slice(1).join(" ") || "",
      email: booking.guest_email || "",
      phone_number: booking.guest_phone || undefined,
    } : undefined,
    line_items: [{
      id: `stay_${booking.id}`,
      item: { id: booking.property_id, quantity: nights },
      base_amount: totalAmountCents,
      discount: 0,
      total: totalAmountCents,
      subtotal: totalAmountCents,
      tax: 0,
    }],
    fulfillment_options: [{
      type: "digital",
      id: "instant_booking",
      title: "Instant Booking Confirmation",
      subtitle: `${prop?.name || "Property"} — ${booking.check_in_date} to ${booking.check_out_date}`,
      subtotal: 0,
      tax: 0,
      total: 0,
    }],
    fulfillment_option_id: "instant_booking",
    totals: [
      { type: "items_base_amount", display_text: `${nights} nights at ${prop?.name || "property"}`, amount: totalAmountCents },
      { type: "subtotal", display_text: "Subtotal", amount: totalAmountCents },
      { type: "tax", display_text: "Tax", amount: 0 },
      { type: "total", display_text: "Total", amount: totalAmountCents },
    ],
    payment_provider: {
      provider: "stripe",
      supported_payment_methods: ["card", "klarna", "swish"],
    },
    messages: status === "ready_for_payment"
      ? [{ type: "info", text: `Booking ready for payment: ${prop?.name}, ${booking.check_in_date} to ${booking.check_out_date}, ${booking.guests_count} guests.` }]
      : status === "completed"
      ? [{ type: "success", text: "Booking confirmed and paid." }]
      : status === "canceled"
      ? [{ type: "info", text: "Booking has been cancelled." }]
      : [{ type: "info", text: "Booking created, awaiting details." }],
    links: [
      { rel: "property", href: prop?.domain ? `https://${prop.domain}` : "https://hemmabo.com" },
      { rel: "booking_status", href: `${base}/acp/checkouts/${booking.id}` },
    ],
    metadata: {
      property_id: booking.property_id,
      property_name: prop?.name,
      property_domain: prop?.domain,
      check_in: booking.check_in_date,
      check_out: booking.check_out_date,
      guests: booking.guests_count,
      nights,
      federation_price: booking.total_price,
      currency: booking.currency,
    },
  };
}

function mapStatus(dbStatus: string): ACPCheckoutState["status"] {
  switch (dbStatus) {
    case "pending": return "ready_for_payment";
    case "confirmed": return "completed";
    case "cancelled": return "canceled";
    default: return "not_ready_for_payment";
  }
}

// ── ACP Endpoints ────────────────────────────────────────────────

async function createCheckout(body: Record<string, unknown>, res: VercelResponse, base: string) {
  const supabase = getSupabase();
  const reader = getSupabaseReader();

  // ACP uses items[].id as property_id, plus buyer and custom fields
  const items = body.items as { id: string; quantity: number }[] | undefined;
  const buyer = body.buyer as { first_name?: string; last_name?: string; email?: string; phone_number?: string } | undefined;

  // HemmaBo-specific: check_in, check_out, guests passed in metadata or top-level
  const propertyId = items?.[0]?.id || (body.property_id as string);
  const checkIn = body.check_in as string;
  const checkOut = body.check_out as string;
  const guests = (body.guests as number) || items?.[0]?.quantity || 2;

  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!propertyId || !checkIn || !checkOut) {
    return res.status(400).json({
      error: "Missing required fields: items[].id (property_id), check_in, check_out",
      hint: "Use items: [{id: 'property-uuid', quantity: guests}], check_in: 'YYYY-MM-DD', check_out: 'YYYY-MM-DD'",
    });
  }
  if (!ISO_DATE_RE.test(checkIn) || !ISO_DATE_RE.test(checkOut)) {
    return res.status(400).json({ error: "Dates must be YYYY-MM-DD format" });
  }

  // Fetch property
  const { data: prop, error: propErr } = await reader
    .from("properties")
    .select("name, domain, host_id, currency, direct_booking_discount")
    .eq("id", propertyId)
    .single();
  if (propErr || !prop) return res.status(404).json({ error: "Property not found" });

  // Check availability
  // MCP-06: use service-role client so bookings table is visible to availability checks
  const avail = await checkAvailability(supabase, propertyId, checkIn, checkOut);
  if (!avail.available) return res.status(409).json({ error: "Not available", ...avail });

  // Calculate price (federation rate for agents)
  const quote = await resolveQuote(supabase, propertyId, checkIn, checkOut, guests);
  if ("error" in quote) return res.status(400).json(quote);

  const totalPrice = quote.gapTotal ?? quote.federationTotal;
  const currency = quote.currency;

  // buyer.email is required — reject rather than silently use an internal fallback
  // that would receive all confirmation emails for anonymous agent bookings.
  if (!buyer?.email) {
    return res.status(400).json({
      error: "Missing buyer.email — a valid guest email is required to create a booking",
    });
  }

  const guestName = `${buyer.first_name || ""} ${buyer.last_name || ""}`.trim() || "ACP Guest";
  const guestEmail = buyer.email;

  // Create booking record
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
      guest_phone: buyer?.phone_number ?? null,
      total_price: totalPrice,
      currency,
      status: "pending",
      property_name_at_booking: prop.name,
    })
    .select("id, status, created_at")
    .single();

  if (bookErr) return res.status(500).json({ error: bookErr.message });

  const state = await buildACPState(booking.id, base);
  return res.status(201).json(state);
}

async function getCheckout(checkoutId: string, res: VercelResponse, base: string) {
  const state = await buildACPState(checkoutId, base);
  if (!state) return res.status(404).json({ error: "Checkout not found" });
  return res.json(state);
}

async function updateCheckout(checkoutId: string, body: Record<string, unknown>, res: VercelResponse, base: string) {
  const supabase = getSupabase();
  const reader = getSupabaseReader();

  // Fetch existing booking — service role required (bookings table blocks anon reads)
  const { data: booking, error: bookErr } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", checkoutId)
    .single();
  if (bookErr || !booking) return res.status(404).json({ error: "Checkout not found" });
  if (booking.status === "cancelled") return res.status(409).json({ error: "Checkout is cancelled" });

  const updates: Record<string, unknown> = {};

  // Update buyer
  const buyer = body.buyer as { first_name?: string; last_name?: string; email?: string; phone_number?: string } | undefined;
  if (buyer) {
    if (buyer.first_name || buyer.last_name) updates.guest_name = `${buyer.first_name || ""} ${buyer.last_name || ""}`.trim();
    if (buyer.email) updates.guest_email = buyer.email;
    if (buyer.phone_number) updates.guest_phone = buyer.phone_number;
  }

  // Update dates/guests (HemmaBo extension)
  const newCheckIn = body.check_in as string | undefined;
  const newCheckOut = body.check_out as string | undefined;
  const newGuests = body.guests as number | undefined;

  if (newCheckIn || newCheckOut) {
    const ci = newCheckIn || booking.check_in_date;
    const co = newCheckOut || booking.check_out_date;
    const g = newGuests || booking.guests_count;

    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_DATE_RE.test(ci) || !ISO_DATE_RE.test(co)) {
      return res.status(400).json({ error: "Dates must be YYYY-MM-DD format" });
    }

    // Check availability
    // MCP-06: use service-role client so bookings table is visible to availability checks
    const avail = await checkAvailability(supabase, booking.property_id, ci, co);
    if (!avail.available) return res.status(409).json({ error: "New dates not available", ...avail });

    // Recalculate price
    const quote = await resolveQuote(supabase, booking.property_id, ci, co, g);
    if ("error" in quote) return res.status(400).json(quote);

    updates.check_in_date = ci;
    updates.check_out_date = co;
    updates.guests_count = g;
    updates.total_price = quote.gapTotal ?? quote.federationTotal;
    updates.currency = quote.currency;
  } else if (newGuests) {
    // MCP-06: use service-role client so gap-night detection (reads bookings) works
    const quote = await resolveQuote(supabase, booking.property_id, booking.check_in_date, booking.check_out_date, newGuests);
    if ("error" in quote) return res.status(400).json(quote);
    updates.guests_count = newGuests;
    updates.total_price = quote.gapTotal ?? quote.federationTotal;
  }

  if (Object.keys(updates).length > 0) {
    const { error: updateErr } = await supabase
      .from("bookings")
      .update(updates)
      .eq("id", checkoutId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
  }

  const state = await buildACPState(checkoutId, base);
  return res.json(state);
}

async function completeCheckout(checkoutId: string, body: Record<string, unknown>, res: VercelResponse, base: string) {
  const supabase = getSupabase();
  const stripeKey = getStripeKey();

  // Fetch booking — service role required (bookings table blocks anon reads)
  const { data: booking, error: bookErr } = await supabase
    .from("bookings")
    .select("*, properties(name, domain, currency)")
    .eq("id", checkoutId)
    .single();
  if (bookErr || !booking) return res.status(404).json({ error: "Checkout not found" });
  if (booking.status === "confirmed") return res.status(409).json({ error: "Checkout already completed" });
  if (booking.status === "cancelled") return res.status(409).json({ error: "Checkout is cancelled" });

  const paymentData = body.payment_data as { token: string; provider: string; billing_address?: Record<string, string> } | undefined;

  if (!paymentData?.token) {
    return res.status(400).json({ error: "Missing payment_data.token (SharedPaymentToken)" });
  }

  const amountCents = toStripeMinorUnits(booking.total_price);
  const currency = (booking.currency || "SEK").toLowerCase();

  // Create PaymentIntent with SharedPaymentToken (SPT)
  const piBody = new URLSearchParams();
  piBody.append("amount", String(amountCents));
  piBody.append("currency", currency);
  piBody.append("confirm", "true");
  piBody.append("metadata[booking_id]", booking.id);
  piBody.append("metadata[property_id]", booking.property_id);
  piBody.append("metadata[acp_checkout]", "true");

  // Use SharedPaymentToken if it starts with spt_, otherwise treat as payment_method
  if (paymentData.token.startsWith("spt_")) {
    piBody.append("payment_method_data[shared_payment_granted_token]", paymentData.token);
  } else {
    piBody.append("payment_method", paymentData.token);
  }

  const piResp = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: piBody.toString(),
  });

  if (!piResp.ok) {
    const err = await piResp.json();
    return res.status(402).json({
      error: "Payment failed",
      stripe_error: err.error?.message ?? piResp.statusText,
      hint: "Provide a valid SharedPaymentToken (spt_...) or payment_method (pm_...)",
    });
  }

  const pi = await piResp.json();

  // Update booking to confirmed
  const { error: updateErr } = await supabase
    .from("bookings")
    .update({
      status: "confirmed",
      stripe_payment_intent_id: pi.id,
    })
    .eq("id", checkoutId);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  const state = await buildACPState(checkoutId, base);
  return res.json(state);
}

async function cancelCheckout(checkoutId: string, res: VercelResponse, base: string) {
  const supabase = getSupabase();

  // Fetch booking — service role required (bookings table blocks anon reads)
  const { data: booking, error: bookErr } = await supabase
    .from("bookings")
    .select("id, status, stripe_payment_intent_id, total_price")
    .eq("id", checkoutId)
    .single();
  if (bookErr || !booking) return res.status(404).json({ error: "Checkout not found" });
  if (booking.status === "cancelled") return res.status(409).json({ error: "Checkout already cancelled" });

  // If paid, issue refund
  let refund = null;
  // ADR 0002 §2.2 clause 5: do not flip booking to 'cancelled' until refund
  // is confirmed (or no refund was needed). Refund failures must surface to
  // the caller and persist on the booking row so support can reconstruct.
  if (booking.stripe_payment_intent_id) {
    const stripeKey = getStripeKey();
    const refundBody = new URLSearchParams();
    refundBody.append("payment_intent", booking.stripe_payment_intent_id);

    let refundResp: Response;
    try {
      refundResp = await fetch("https://api.stripe.com/v1/refunds", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: refundBody.toString(),
      });
    } catch (err) {
      // Network error reaching Stripe. Persist the failure on the booking
      // and return 502 so the caller knows the cancel was not completed.
      const message = err instanceof Error ? err.message : "stripe_unreachable";
      await supabase
        .from("bookings")
        .update({ refund_status: "failed", refund_error: message })
        .eq("id", checkoutId);
      console.error(`ACP refund network error for booking ${checkoutId}:`, message);
      return res.status(502).json({
        error: "Refund could not be issued — booking left in non-final state",
        refund_status: "failed",
        refund_error: message,
      });
    }

    if (!refundResp.ok) {
      const errJson = await refundResp.json().catch(() => ({}));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (errJson as any).error?.code ?? (errJson as any).error?.message ?? refundResp.statusText;
      await supabase
        .from("bookings")
        .update({ refund_status: "failed", refund_error: String(code) })
        .eq("id", checkoutId);
      console.error(`ACP refund 4xx for booking ${checkoutId}:`, code);
      return res.status(502).json({
        error: "Refund rejected by Stripe — booking left in non-final state",
        refund_status: "failed",
        refund_error: String(code),
      });
    }

    refund = await refundResp.json();
    // Mark refund pending. The webhook (charge.refunded) is the authoritative
    // writer of refund_status='succeeded' once Stripe confirms.
    await supabase
      .from("bookings")
      .update({ refund_status: "pending", refund_id: refund.id })
      .eq("id", checkoutId);
  }

  const { error: updateErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", checkoutId);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  const state = await buildACPState(checkoutId, base);
  if (state && refund) {
    state.messages.push({ type: "info", text: `Refund issued: ${refund.id}` });
  }
  return res.json(state);
}

// ── HTTP Router ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Origin is intentionally unrestricted — ACP agents are not browsers.
  // Browser-based CSRF is mitigated by requiring Authorization on all
  // mutating methods (POST, PUT); browsers cannot send that header
  // cross-origin without a preflight that explicitly grants it.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Parse path: /acp/checkouts, /acp/checkouts/:id, /acp/checkouts/:id/complete, /acp/checkouts/:id/cancel
  const url = new URL(req.url || "", `https://${req.headers.host}`);
  const pathParts = url.pathname.replace(/^\/api\/acp/, "").replace(/^\/acp/, "").split("/").filter(Boolean);
  // pathParts: ["checkouts"] or ["checkouts", ":id"] or ["checkouts", ":id", "complete"|"cancel"]

  if (pathParts[0] !== "checkouts") {
    return res.status(200).json({
      protocol: "agentic-commerce-protocol",
      version: "1.0",
      seller: "HemmaBo Federation",
      description: "ACP-compatible vacation rental checkout. First vacation rental with agentic commerce support.",
      endpoints: {
        create: "POST /acp/checkouts",
        retrieve: "GET /acp/checkouts/:id",
        update: "PUT /acp/checkouts/:id",
        complete: "POST /acp/checkouts/:id/complete",
        cancel: "POST /acp/checkouts/:id/cancel",
      },
      payment_provider: { provider: "stripe", supported_payment_methods: ["card", "klarna", "swish"] },
      supported_tokens: ["SharedPaymentToken (spt_...)", "PaymentMethod (pm_...)"],
    });
  }

  const checkoutId = pathParts[1];
  const action = pathParts[2]; // "complete" or "cancel" or undefined
  const isMutation = req.method === "POST" || req.method === "PUT";
  const base = baseUrl(req);

  // Rate-limit (#65). Applied to ALL routed /acp/checkouts traffic, before
  // the auth gate, so unauthenticated probes are also throttled. The "kind"
  // is "bearer" when an Authorization header is present (per-token bucket,
  // higher quota) and "anon" otherwise (per-IP bucket, lower quota). This
  // matches the same scheme used by api/mcp.ts so legitimate AI agents see
  // consistent limits across both surfaces.
  const authHeader = req.headers["authorization"] as string | undefined;
  const rlKind = authHeader ? "bearer" : "anon";
  const rlIdent = authHeader
    ? bearerIdentifier(authHeader)
    : anonIdentifier(req.headers as Record<string, string | string[] | undefined>);
  const rl = await checkRateLimit(rlKind, rlIdent);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec ?? 60));
    if (rl.limit !== undefined) res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", "0");
    return res.status(429).json({
      error: "rate_limit_exceeded",
      message: `Too many requests. Retry in ${rl.retryAfterSec ?? 60}s.`,
    });
  }
  if (rl.limit !== undefined && rl.remaining !== undefined) {
    res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  }

  // Auth gate on every checkout-scoped request, including GET. The response
  // from buildACPState() contains guest PII (name, email, phone, dates).
  // Without this gate, anyone holding (or guessing) a booking UUID can read
  // that PII — a GDPR exposure surface (#67). Discovery doc (no pathParts
  // beyond "checkouts") stays public. Mutations still require auth via the
  // same gate (the `isMutation` branch is now subsumed by `requiresAuth`).
  const requiresAuth = isMutation || Boolean(checkoutId);
  if (requiresAuth) {
    const authErr = validateApiKey(req.headers["authorization"]);
    if (authErr) {
      return res.status(401).json({
        error: `${authErr}. ACP agents must pass: Authorization: Bearer <key>`,
      });
    }
  }

  // Idempotency-Key handling (#66). Optional but strongly recommended by the
  // ACP spec. Applied to ALL mutating routes (POST/PUT) so a retried request
  // never double-books, double-charges, or double-refunds. Cache backend is
  // Upstash Redis (24h TTL); without it the cache is a no-op and requests
  // execute every time (fail-open — same policy as the rate-limiter).
  //
  // Contract:
  //   Same key + same body  → return cached prior response verbatim.
  //   Same key + diff body  → 409 Conflict (HTTP semantics, not RPC error).
  //   New key               → execute, cache 2xx response on success.
  const idemKeyRaw = req.headers["idempotency-key"];
  const idemKey = isMutation
    ? normaliseIdempotencyKey(Array.isArray(idemKeyRaw) ? idemKeyRaw[0] : idemKeyRaw)
    : null;
  // Reject malformed keys explicitly so clients aren't silently treated as
  // "no idempotency". A header present but unusable is almost certainly a
  // bug at the caller worth surfacing.
  if (isMutation && idemKeyRaw !== undefined && idemKey === null) {
    return res.status(400).json({
      error: "invalid_idempotency_key",
      message:
        "Idempotency-Key must be 1-200 chars matching [A-Za-z0-9._:-]. See ACP spec.",
    });
  }

  let bodyFp: string | null = null;
  if (idemKey) {
    bodyFp = idemFingerprint({
      method: req.method,
      path: url.pathname,
      body: req.body ?? {},
    });
    const outcome = await idemLookup(idemKey, bodyFp);
    if (outcome.kind === "conflict") {
      return res.status(409).json({
        error: "idempotency_conflict",
        message:
          "Idempotency-Key was reused with a different request body. " +
          "Use a fresh key for a different request.",
      });
    }
    if (outcome.kind === "hit") {
      // Tag the response so callers can detect a replay if they care.
      res.setHeader("Idempotent-Replay", "true");
      return res.status(outcome.status).json(outcome.body);
    }
  }

  // Wrap `res` so that on a cache miss we can record the outgoing response
  // for future retries. We only capture status() / json(); other methods
  // (setHeader, end, etc.) pass through unchanged.
  let capturedStatus = 200;
  let capturedBody: unknown = undefined;
  const recordingRes = idemKey
    ? (new Proxy(res, {
        get(target, prop, receiver) {
          if (prop === "status") {
            return (code: number) => {
              capturedStatus = code;
              target.status(code);
              return receiver;
            };
          }
          if (prop === "json") {
            return (body: unknown) => {
              capturedBody = body;
              return target.json(body);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as VercelResponse)
    : res;

  try {
    // POST /acp/checkouts — Create
    if (!checkoutId && req.method === "POST") {
      await createCheckout(req.body || {}, recordingRes, base);
    }
    // GET /acp/checkouts/:id — Retrieve
    else if (checkoutId && !action && req.method === "GET") {
      await getCheckout(checkoutId, recordingRes, base);
    }
    // PUT /acp/checkouts/:id — Update
    else if (checkoutId && !action && req.method === "PUT") {
      await updateCheckout(checkoutId, req.body || {}, recordingRes, base);
    }
    // POST /acp/checkouts/:id/complete — Complete with payment
    else if (checkoutId && action === "complete" && req.method === "POST") {
      await completeCheckout(checkoutId, req.body || {}, recordingRes, base);
    }
    // POST /acp/checkouts/:id/cancel — Cancel
    else if (checkoutId && action === "cancel" && req.method === "POST") {
      await cancelCheckout(checkoutId, recordingRes, base);
    } else {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // On a successful 2xx response with an idempotency key in play, persist
    // the response for future retries. 4xx/5xx are NOT cached: a client
    // retrying after a transient failure should be allowed to succeed.
    if (idemKey && bodyFp && capturedStatus >= 200 && capturedStatus < 300) {
      await idemRecord(idemKey, bodyFp, capturedStatus, capturedBody);
    }
    return;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("ACP handler error:", message);
    return res.status(500).json({ error: message });
  }
}
