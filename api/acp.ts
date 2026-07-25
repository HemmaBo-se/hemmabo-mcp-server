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
import { validateAuth } from "../src/auth.js";
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
import {
  classifyPaymentIntentOutcome,
  readStripeBody,
  sptApiVersion,
  stripeErrorMessage,
  toStripeMinorUnits,
  type PaymentIntentOutcome,
} from "../src/stripe.js";
import { verifyAp2PaymentMandate, resolveAp2IssuerJwks } from "../lib/ap2.js";

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
  status: "not_ready_for_payment" | "ready_for_payment" | "completed" | "canceled" | "in_progress" | "authentication_required";
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
  // `code` follows the ACP MessageError enum (e.g. "requires_3ds") — present
  // only on messages that carry a machine-actionable business error.
  messages: { type: string; text: string; code?: string }[];
  links: { rel: string; href: string }[];
  // HemmaBo-specific metadata
  metadata?: Record<string, unknown>;
}

async function buildACPState(
  bookingId: string,
  base: string
): Promise<ACPCheckoutState | null> {
  const supabase = getSupabase();
  const { data: booking, error } = await supabase
    .from("bookings")
    .select("*, properties(name, domain, currency, region, city, country, property_type)")
    .eq("id", bookingId)
    .single();

  if (error || !booking) return null;

  const prop = booking.properties;
  const status = deriveACPStatus(booking);
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
      supported_payment_methods: ["card"],
    },
    messages: status === "ready_for_payment"
      ? [{ type: "info", text: `Booking ready for payment: ${prop?.name}, ${booking.check_in_date} to ${booking.check_out_date}, ${booking.guests_count} guests.` }]
      : status === "completed"
      ? [{ type: "success", text: "Booking confirmed and paid." }]
      : status === "in_progress"
      ? [{ type: "info", text: `Payment is processing. Do not pay again — poll ${base}/acp/checkouts/${booking.id} until it reports completed or canceled.` }]
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

/**
 * The ACP status a booking row deserves, derived from data so every surface
 * agrees — GET, PUT and complete must never contradict each other.
 *
 * A `pending` booking that already carries a PaymentIntent is NOT
 * `ready_for_payment`: a charge exists and may still settle. Rendering it as
 * payable is an invitation to redeem a second token for the same stay, which
 * is exactly what the payment-truth gate in completeCheckout exists to
 * prevent. ADR 0005 keeps ACP protocol statuses as response states, so this
 * derives a *response* status and invents no `bookings.status` value.
 */
function deriveACPStatus(booking: {
  status: string;
  stripe_payment_intent_id?: string | null;
}): ACPCheckoutState["status"] {
  if (booking.status === "pending" && booking.stripe_payment_intent_id) {
    return "in_progress";
  }
  return mapStatus(booking.status);
}

/**
 * Read a PaymentIntent's live outcome from Stripe.
 *
 * The booking row cannot answer "did the money move": writes can fail between
 * a settled charge and `status = confirmed`, and a payment in flight leaves the
 * row `pending` by design. Both the complete and the cancel path ask Stripe
 * through this one helper, so they can never disagree about what "paid" means.
 *
 * `reachable: false` means the state could not be established at all — callers
 * must fail closed rather than assume the payment did or did not happen.
 */
async function readPaymentIntentOutcome(paymentIntentId: string): Promise<{
  reachable: boolean;
  outcome: PaymentIntentOutcome;
  status: string;
  detail?: string;
}> {
  const stripeKey = getStripeKey();
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      { headers: { "Authorization": `Bearer ${stripeKey}` } }
    );
  } catch (err) {
    return {
      reachable: false,
      outcome: "not_paid",
      status: "unknown",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const { body, raw, parsed } = await readStripeBody(resp);
  if (!resp.ok) {
    return {
      reachable: false,
      outcome: "not_paid",
      status: "unknown",
      detail: stripeErrorMessage(body, raw, resp, parsed),
    };
  }
  return {
    reachable: true,
    outcome: classifyPaymentIntentOutcome(body.status),
    status: typeof body.status === "string" ? body.status : "unknown",
  };
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
  // A charge exists for this checkout. Repricing it now would leave the stay's
  // dates and total disagreeing with the payment already in flight for the old
  // ones — cancel and start a new checkout instead of mutating a paid-for stay.
  if (booking.stripe_payment_intent_id) {
    return res.status(409).json({
      error: "Checkout has a payment in progress and can no longer be modified",
      hint: "Cancel this checkout and create a new one to change dates or guests.",
    });
  }

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
    .select("*, properties(name, domain, currency, stripe_account_id, stripe_onboarding_complete)")
    .eq("id", checkoutId)
    .single();
  if (bookErr || !booking) return res.status(404).json({ error: "Checkout not found" });
  if (booking.status === "confirmed") return res.status(409).json({ error: "Checkout already completed" });
  if (booking.status === "cancelled") return res.status(409).json({ error: "Checkout is cancelled" });

  // Re-entrancy: a charge already exists for this checkout. The booking status
  // alone cannot guard this any more — a payment left in flight keeps the row
  // `pending`, which is precisely when a retrying agent would create a SECOND
  // PaymentIntent for the same stay. Read the existing intent and answer from
  // it instead of charging again. Stripe's own Idempotency-Key covers an
  // identical retry; this covers a retry that arrives with a different token.
  if (booking.stripe_payment_intent_id) {
    const existing = await readPaymentIntentOutcome(booking.stripe_payment_intent_id);
    if (existing.reachable && existing.outcome !== "not_paid") {
      if (existing.outcome === "succeeded") {
        // The charge settled but the booking never reached confirmed (a write
        // failed, or the process died between the two). Self-heal rather than
        // charging the guest a second time.
        await supabase.from("bookings").update({ status: "confirmed" }).eq("id", checkoutId);
      }
      const state = await buildACPState(checkoutId, base);
      if (!state) return res.status(404).json({ error: "Checkout not found" });
      return res.json(state);
    }
    if (!existing.reachable) {
      // Unknown payment state. Fail closed: creating a new intent here risks
      // charging twice for one stay.
      return res.status(502).json({
        error: "Could not read the existing payment for this checkout",
        hint: "A PaymentIntent already exists for this booking and Stripe could not be reached to check it. Retry shortly; no new charge was created.",
      });
    }
  }

  // ── Direct-to-host routing (Stripe Connect destination charge) ──────
  // The host is merchant of record: funds settle to the host's own connected
  // account via on_behalf_of + transfer_data.destination, with 0% platform
  // fee. Same destination-charge shape as the proven guest-payment flow
  // (smart-stays create-guest-payment). FAIL CLOSED in live mode: if the host
  // has not completed Stripe Connect onboarding we refuse rather than charge
  // HemmaBo's platform account — HemmaBo is never merchant of record and never
  // holds host funds. Test mode may proceed without a connected account so the
  // SPT + Connect path can be exercised end-to-end.
  const hostProperty = booking.properties as
    | { stripe_account_id?: string | null; stripe_onboarding_complete?: boolean | null; domain?: string }
    | null;
  const hostAccountId =
    hostProperty?.stripe_account_id && hostProperty.stripe_account_id.length > 0
      ? hostProperty.stripe_account_id
      : null;
  const isTestMode = stripeKey.startsWith("sk_test_");
  const routeToHost = Boolean(hostAccountId) && Boolean(hostProperty?.stripe_onboarding_complete);
  if (!routeToHost && !isTestMode) {
    return res.status(409).json({
      error: "Host has not completed Stripe Connect onboarding",
      hint: "Agent checkout settles directly to the host's own Stripe (host is merchant of record). The host must finish Stripe Connect before this booking can be paid.",
    });
  }

  const paymentData = body.payment_data as
    | { token?: unknown; provider?: string; billing_address?: Record<string, string> }
    | undefined;

  // Type the token, don't just truth-test it: a JSON number or object here
  // used to reach .startsWith() below and surface as a 500 "not a function"
  // instead of telling the agent its request was malformed.
  const token = typeof paymentData?.token === "string" ? paymentData.token.trim() : "";
  if (!token) {
    return res.status(400).json({
      error: "Missing or invalid payment_data.token",
      hint: "payment_data.token must be a non-empty string: a SharedPaymentToken (spt_...) or a Stripe PaymentMethod (pm_...).",
    });
  }

  const amountCents = toStripeMinorUnits(booking.total_price);
  const currency = (booking.currency || "SEK").toLowerCase();

  // ── AP2 (Agent Payments Protocol) — optional, additive ──────────────
  // If the agent presents a signed AP2 Payment Mandate, verify it authorizes
  // THIS charge (amount cap, currency, merchant, expiry) before paying.
  // Absent → existing behavior. Present but invalid → reject (fail closed).
  const ap2Raw = body.ap2_mandate ?? (paymentData as Record<string, unknown> | undefined)?.ap2_mandate;
  const ap2Mandate = typeof ap2Raw === "string" && ap2Raw.length > 0 ? ap2Raw : null;
  if (ap2Mandate) {
    const merchantDomain = (booking.properties as { domain?: string } | null)?.domain ?? "";
    const jwksInline =
      body.ap2_issuer_jwks && typeof body.ap2_issuer_jwks === "object"
        ? (body.ap2_issuer_jwks as Record<string, unknown>)
        : null;
    const jwksUri = typeof body.ap2_issuer_jwks_uri === "string" ? body.ap2_issuer_jwks_uri : null;
    const issuerJwks = jwksInline ?? (jwksUri ? await resolveAp2IssuerJwks(jwksUri) : null);
    if (!issuerJwks) {
      return res.status(400).json({
        error: "AP2 mandate present but issuer JWKS not resolvable",
        hint: "Provide ap2_issuer_jwks (inline JWKS) or ap2_issuer_jwks_uri (https).",
      });
    }
    let ap2Result;
    try {
      ap2Result = verifyAp2PaymentMandate(ap2Mandate, issuerJwks, {
        amountMinor: amountCents,
        currency,
        merchantDomain,
      });
    } catch (e) {
      return res.status(403).json({
        error: "AP2 mandate signature verification failed",
        detail: (e as Error).message,
      });
    }
    if (!ap2Result.authorized) {
      return res.status(403).json({
        error: "AP2 mandate did not authorize this charge",
        ap2_reason: ap2Result.reason,
      });
    }
  }

  // Create PaymentIntent with SharedPaymentToken (SPT)
  const piBody = new URLSearchParams();
  piBody.append("amount", String(amountCents));
  piBody.append("currency", currency);
  piBody.append("confirm", "true");
  piBody.append("metadata[booking_id]", booking.id);
  piBody.append("metadata[property_id]", booking.property_id);
  piBody.append("metadata[acp_checkout]", "true");

  // Use SharedPaymentToken if it starts with spt_, otherwise treat as payment_method
  const isSpt = token.startsWith("spt_");
  if (isSpt) {
    piBody.append("payment_method_data[shared_payment_granted_token]", token);
  } else {
    piBody.append("payment_method", token);
  }

  // Settle directly to the host's connected Stripe account (host = merchant of
  // record, 0% platform fee). Destination charge — identical shape to the
  // guest-payment flow. Gated by routeToHost (live mode requires the host's
  // Connect account; test mode may charge the platform to exercise the path).
  if (routeToHost && hostAccountId) {
    piBody.append("application_fee_amount", "0");
    piBody.append("transfer_data[destination]", hostAccountId);
    piBody.append("on_behalf_of", hostAccountId);
  }

  // SPT redemption requires the preview API version header (see
  // src/stripe.ts:SPT_API_VERSION_DEFAULT). Send it ONLY on the SPT branch:
  // a preview version changes request/response behaviour across the whole
  // API surface, and an ordinary pm_ charge must keep running on the
  // account's default version.
  const piHeaders: Record<string, string> = {
    "Authorization": `Bearer ${stripeKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (isSpt) piHeaders["Stripe-Version"] = sptApiVersion();

  // Charge at most once per (checkout, token). Two guards that used to cover
  // this are not enough: our own Idempotency-Key cache fails open when Upstash
  // is unconfigured (lib/idempotency.ts), and the booking no longer flips to
  // `confirmed` while a payment is still in flight — so a retried /complete
  // would otherwise create a SECOND PaymentIntent for the same stay. Keying on
  // the token as well as the checkout keeps legitimate retries working: the
  // same token replays Stripe's original result, a different payment method
  // after a decline is a genuinely new attempt.
  // The amount is part of the key: Stripe replays the ORIGINAL PaymentIntent
  // for 24h, so a checkout repriced between attempts would otherwise replay a
  // charge for the old total and be read as payment for the new one.
  piHeaders["Idempotency-Key"] =
    `acp_complete_${booking.id}_${amountCents}_${currency}_${idemFingerprint(token).slice(0, 24)}`;

  const piResp = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: piHeaders,
    body: piBody.toString(),
  });

  const { body: piJson, raw: piRaw, parsed: piParsed } = await readStripeBody(piResp);

  if (!piResp.ok) {
    return res.status(402).json({
      error: "Payment failed",
      stripe_error: stripeErrorMessage(piJson, piRaw, piResp, piParsed),
      hint: "Provide a valid SharedPaymentToken (spt_...) or payment_method (pm_...)",
      // Surfaced so a failed SPT redemption can be told apart from a wrong
      // preview version without re-reading the deploy's env.
      stripe_api_version: isSpt ? sptApiVersion() : null,
    });
  }

  const pi = piJson as { id?: unknown; status?: unknown; next_action?: { type?: string } };
  const paymentStatus = typeof pi.status === "string" ? pi.status : "unknown";
  const outcome = classifyPaymentIntentOutcome(pi.status);

  // The PaymentIntent id is a Stripe fact the moment the PI exists, whatever
  // its status. Persist it before deciding anything about the booking: cancel
  // and refund look the charge up by this column, and a payment left in flight
  // must not become unrefundable because the booking never reached confirmed.
  if (typeof pi.id === "string" && pi.id.length > 0) {
    const { error: piIdErr } = await supabase
      .from("bookings")
      .update({ stripe_payment_intent_id: pi.id })
      .eq("id", checkoutId);
    if (piIdErr) return res.status(500).json({ error: piIdErr.message });
  }

  if (outcome === "in_flight") {
    // No money yet, but it can still arrive on its own. The booking stays
    // `pending` and the `payment_intent.succeeded` webhook — the authoritative
    // Stripe-event reconciler per ADR 0006 — confirms it if and when the funds
    // land. The state now reads `in_progress` (derived from the persisted
    // PaymentIntent id), so a polling agent is never told to pay again.
    const inFlightState = await buildACPState(checkoutId, base);
    if (!inFlightState) return res.status(404).json({ error: "Checkout not found" });
    return res.json(inFlightState);
  }

  if (outcome !== "succeeded") {
    if (paymentStatus === "requires_action") {
      // ADR 0012: a payment awaiting customer authentication is a VALID
      // session, and the ACP spec answers it on 200 — status
      // `authentication_required` plus a MessageError (`requires_3ds`) in
      // messages[]. A 402 here reads as a generic failure and makes the agent
      // retry with a fresh token instead of completing the authentication.
      const authState = await buildACPState(checkoutId, base);
      if (!authState) return res.status(404).json({ error: "Checkout not found" });
      authState.status = "authentication_required";
      authState.messages = [
        {
          type: "error",
          code: "requires_3ds",
          text: "The payment needs customer authentication. Complete next_action (see metadata), then poll this checkout — the booking confirms automatically when the authentication succeeds.",
        },
      ];
      // The agent drives the authentication, so give it what that takes: the
      // intent to act on and Stripe's own next_action payload. No client
      // secret — this endpoint answers unauthenticated callers in open mode.
      authState.metadata = {
        ...authState.metadata,
        payment_intent_id: typeof pi.id === "string" ? pi.id : null,
        next_action_type: pi.next_action?.type ?? null,
        next_action: pi.next_action ?? null,
        ...(isSpt ? { stripe_api_version: sptApiVersion() } : {}),
      };
      return res.json(authState);
    }

    if (paymentStatus === "unknown") {
      // Stripe answered 2xx but the body yielded no readable status. The
      // payment may well have happened — this is not a decline, and saying so
      // would invite a second charge. Fail closed; the intent id (persisted
      // above when readable) and the webhook carry reconciliation.
      return res.status(502).json({
        type: "processing_error",
        error: "Payment state unreadable",
        message: "Stripe's response could not be parsed, so the payment outcome is unknown. Do not retry blindly — poll the checkout; the booking confirms via webhook if the payment succeeded.",
        stripe_api_version: isSpt ? sptApiVersion() : null,
      });
    }

    // Declined or dead (requires_payment_method, canceled, requires_capture):
    // Stripe took no money and will not on its own. Fail closed. Kept on 402
    // deliberately — the ACP-pure alternative (200 + payment_declined, session
    // payable again) requires changing what payment_intent.payment_failed
    // writes, which ADR 0005 locks. See ADR 0012 §3.
    return res.status(402).json({
      error: "Payment not completed",
      payment_status: paymentStatus,
      payment_intent_id: typeof pi.id === "string" ? pi.id : null,
      hint:
        paymentStatus === "requires_capture"
          ? "The payment is authorized but not captured. This integration does not capture authorizations, so the booking cannot be confirmed; cancel the checkout to release the hold."
          : "Stripe did not take the payment. Retry with a valid, unused token; the booking is still pending.",
      stripe_api_version: isSpt ? sptApiVersion() : null,
    });
  }

  // Update booking to confirmed — reached only when Stripe reported
  // status "succeeded" (the gate above). ADR 0006 allows this synchronous
  // write "after Stripe has accepted and confirmed the payment intent";
  // a 2xx alone is acceptance, not confirmation.
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
  const paymentIntentId = booking.stripe_payment_intent_id as string | null;
  let liveOutcome: PaymentIntentOutcome | null = null;
  let livePaymentStatus = "unknown";

  if (paymentIntentId) {
    // Ask Stripe what the money actually did — never infer it from the booking
    // row. Two writes stand between a settled charge and status='confirmed',
    // so a real payment can sit on a booking that still reads `pending`, and
    // trusting the row would cancel a paid stay while refunding nothing.
    const live = await readPaymentIntentOutcome(paymentIntentId);

    if (!live.reachable) {
      // We cannot establish what the money did. Refuse to finalise: a cancel
      // that abandons a live payment is how a guest ends up charged for a stay
      // that no longer exists.
      console.error(
        `ACP cancel: payment state unreadable for booking ${checkoutId} (PI ${paymentIntentId}):`,
        live.detail
      );
      return res.status(502).json({
        error: "Could not read the payment status — booking left in non-final state",
        detail: live.detail ?? "stripe_unreachable",
      });
    }

    livePaymentStatus = live.status;
    liveOutcome = live.outcome;

    if (liveOutcome === "in_flight") {
      // The money is on its way and can be neither cancelled nor refunded yet.
      // Cancelling the booking now would let the charge settle against a stay
      // that no longer exists — and the payment_intent.succeeded webhook would
      // then confirm the cancelled booking straight back to life.
      return res.status(409).json({
        error: "Payment still processing — cannot cancel yet",
        payment_status: livePaymentStatus,
        hint: "The charge has not settled. Retry the cancellation once the payment reaches a final state; the booking stays pending until then.",
      });
    }

    if (liveOutcome === "not_paid") {
      // Nothing settled. Cancel the intent so an authentication completed after
      // this point cannot charge a guest for a cancelled stay, and so a held
      // authorization is released. Best-effort: an intent Stripe already closed
      // must never block the cancellation the guest asked for.
      try {
        const cancelResp = await fetch(
          `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${getStripeKey()}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        if (!cancelResp.ok) {
          const { body: cancelErr, raw, parsed } = await readStripeBody(cancelResp);
          console.warn(
            `ACP cancel: PaymentIntent ${paymentIntentId} (status ${livePaymentStatus}) not cancellable for booking ${checkoutId}:`,
            stripeErrorMessage(cancelErr, raw, cancelResp, parsed)
          );
        }
      } catch (err) {
        console.warn(
          `ACP cancel: could not reach Stripe to cancel PaymentIntent for booking ${checkoutId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // ADR 0002 §2.2 clause 5: do not flip booking to 'cancelled' until refund
  // is confirmed (or no refund was needed). Refund failures must surface to
  // the caller and persist on the booking row so support can reconstruct.
  if (paymentIntentId && liveOutcome === "succeeded") {
    const stripeKey = getStripeKey();
    const refundBody = new URLSearchParams();
    refundBody.append("payment_intent", paymentIntentId);
    // Destination charge: without reverse_transfer the host keeps the guest's
    // money and the refund is drawn from HemmaBo's platform balance — putting
    // HemmaBo in the flow of funds for a stay, which the charter forbids.
    // Stripe: "the destination account keeps the funds that were transferred
    // to it, leaving the platform account to cover the negative balance"
    // (docs.stripe.com/connect/destination-charges#issue-refunds).
    refundBody.append("reverse_transfer", "true");

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
      description: "ACP-compatible vacation rental checkout for host-owned vacation rental domains.",
      endpoints: {
        create: "POST /acp/checkouts",
        retrieve: "GET /acp/checkouts/:id",
        update: "PUT /acp/checkouts/:id",
        complete: "POST /acp/checkouts/:id/complete",
        cancel: "POST /acp/checkouts/:id/cancel",
      },
      payment_provider: { provider: "stripe", supported_payment_methods: ["card"] },
      supported_tokens: ["SharedPaymentToken (spt_...)", "PaymentMethod (pm_...)"],
      // The response-status set agents can observe (ADR 0005/0012). Advertised
      // so an integrator never has to reverse-engineer it from responses.
      statuses: [
        "not_ready_for_payment",
        "ready_for_payment",
        "in_progress",
        "authentication_required",
        "completed",
        "canceled",
      ],
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
  // beyond "checkouts") stays public. Uses async validateAuth (#64) which
  // resolves bearer tokens against the runtime OAuth registry rather than
  // the legacy static MCP_API_KEY.
  const requiresAuth = isMutation || Boolean(checkoutId);
  if (requiresAuth) {
    const authErr = await validateAuth(
      Array.isArray(req.headers["authorization"])
        ? req.headers["authorization"][0]
        : req.headers["authorization"],
    );
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
