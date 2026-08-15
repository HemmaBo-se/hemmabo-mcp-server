/**
 * Stripe helpers — REST API via fetch (no SDK dependency)
 *
 * Used by both api/mcp.ts (HTTP) and src/stdio.ts (stdio)
 * Requires STRIPE_SECRET_KEY environment variable
 */

const FALLBACK_DOMAIN = "hemmabo.se";

/**
 * Stripe preview API version required to redeem a SharedPaymentToken (SPT).
 *
 * SPT redemption lives behind a preview API version: on an account's default
 * version Stripe does not accept
 * `payment_method_data[shared_payment_granted_token]`, so this header is not
 * optional for the agent-checkout path — without it the redemption fails no
 * matter how correct the rest of the PaymentIntent is.
 *
 * Confirmed by Stripe (Agentic Commerce, case 00721792, 2026-07-25) as the
 * current version for SPT redemption on a PaymentIntent:
 *   https://docs.stripe.com/api/shared-payment/granted-token?api-version=2026-07-08.preview
 * Supersedes 2026-04-22.preview, which was only ever used in the June 2026
 * parameter probe (Stripe accepted the param shape; no redemption ever ran).
 *
 * Pin it here rather than at the call site so there is exactly one place to
 * change when Stripe rolls the next preview.
 */
export const SPT_API_VERSION_DEFAULT = "2026-07-08.preview";

/**
 * The preview API version to send when redeeming an SPT.
 *
 * `STRIPE_SPT_API_VERSION` overrides the pinned default so a Stripe-side
 * version roll can be followed from configuration — a preview version bump
 * must never require a code deploy mid-test-cycle. Blank or whitespace-only
 * values fall back to the pinned default rather than sending an empty header.
 */
export function sptApiVersion(): string {
  const override = process.env.STRIPE_SPT_API_VERSION?.trim();
  return override ? override : SPT_API_VERSION_DEFAULT;
}

/**
 * What a confirmed PaymentIntent's status means for a booking.
 *
 *   succeeded  — the money moved. The only outcome that may confirm a stay.
 *   in_flight  — no money yet, but the payment can still complete on its own.
 *                The booking stays pending; the `payment_intent.succeeded`
 *                webhook is the authoritative writer that confirms it later.
 *   not_paid   — the payment needs something (authentication, another payment
 *                method) or is dead. Fail closed and tell the caller.
 */
export type PaymentIntentOutcome = "succeeded" | "in_flight" | "not_paid";

/**
 * Stripe answers HTTP 200 for a `confirm=true` PaymentIntent that has NOT
 * taken the money — `requires_action` (3DS), `processing` (funds in flight),
 * `requires_payment_method` (soft decline). A 2xx is therefore not proof of
 * payment, and treating it as such would book the stay, block the host's
 * calendar, and report "confirmed and paid" with nothing settled.
 *
 * ADR 0006 permits the ACP path to write `confirmed` only *after Stripe has
 * accepted **and confirmed** the payment intent*. This function is that
 * "and confirmed" — the single place where the meaning of each status is
 * decided, so the money path reads as one rule rather than scattered
 * comparisons.
 *
 * `requires_capture` is deliberately NOT `succeeded`: under manual capture the
 * funds are authorized, not captured, and an authorization is not a paid stay.
 * Unknown/absent statuses fall through to `not_paid` — the safe direction.
 */
export function classifyPaymentIntentOutcome(status: unknown): PaymentIntentOutcome {
  if (status === "succeeded") return "succeeded";
  if (status === "processing") return "in_flight";
  // `requires_capture` is NOT in_flight: nothing in this repository ever calls
  // /capture, and the webhook does not handle amount_capturable_updated, so an
  // authorization would sit on the guest's card until it expires while the
  // booking waited for a confirmation that no code path can deliver. Report it
  // as unpaid — honest, and it routes the intent to cancellation on cancel.
  return "not_paid";
}

/**
 * Read a Stripe response body without letting a non-JSON payload throw.
 *
 * `await resp.json()` on an HTML 502 from Stripe's edge (or an empty body)
 * raises a SyntaxError that escapes to the router's catch and becomes an
 * opaque 500 — losing the payment status and version diagnostics that the
 * caller needs precisely when something murky happened. Returns the parsed
 * object when possible and always the raw text for the error message.
 */
export async function readStripeBody(
  resp: Response
): Promise<{ body: Record<string, unknown>; raw: string; parsed: boolean }> {
  const raw = await resp.text().catch(() => "");
  if (!raw) return { body: {}, raw: "", parsed: false };
  try {
    const value: unknown = JSON.parse(raw);
    return {
      body: value && typeof value === "object" ? (value as Record<string, unknown>) : {},
      raw,
      parsed: true,
    };
  } catch {
    return { body: {}, raw, parsed: false };
  }
}

/**
 * Human-readable failure text for a non-2xx Stripe response. Falls back to the
 * raw body (truncated) so an HTML error page still says something useful
 * instead of collapsing into "Internal error".
 */
export function stripeErrorMessage(
  body: Record<string, unknown>,
  raw: string,
  resp: { status: number; statusText: string },
  parsed = false
): string {
  const err = body.error as { message?: string; code?: string; type?: string } | undefined;
  if (err?.message) return err.message;
  // A well-formed Stripe error without a message still carries code/type. Say
  // so rather than blaming the transport: during the SPT test window a false
  // "Non-JSON response" would send whoever debugs it hunting an edge problem
  // that does not exist.
  if (err?.code || err?.type) return `Stripe error ${err.code ?? err.type} (HTTP ${resp.status})`;
  if (raw && !parsed) return `Non-JSON response from Stripe (HTTP ${resp.status}): ${raw.slice(0, 200)}`;
  if (raw) return `Stripe returned HTTP ${resp.status}: ${raw.slice(0, 200)}`;
  return resp.statusText || `HTTP ${resp.status}`;
}

/**
 * Convert a decimal price to Stripe minor units (cents / öre).
 *
 * Plain `price * 100` produces floating-point garbage (`19.99 * 100 ===
 * 1998.9999999999998`), which Stripe rejects as a non-integer amount and
 * which would silently over/undercharge by 1 unit for any price that
 * doesn't round cleanly. Always go through this helper. (#69)
 *
 * Throws on NaN, Infinity, or negative input — those indicate a logic bug
 * upstream that we never want to forward to Stripe.
 */
export function toStripeMinorUnits(price: number): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`Invalid price for Stripe conversion: ${price}`);
  }
  return Math.round(price * 100);
}

/**
 * Validates a property domain before embedding it in Stripe redirect URLs.
 *
 * Accepts only bare hostnames (e.g. "villaaakerlyckan.se") — no scheme,
 * no path, no port, no credentials. Returns the fallback domain when the
 * value is absent or fails validation so callers always get a safe URL.
 *
 * Attack prevented: a malicious or compromised `properties.domain` value
 * such as "evil.com/x?foo=" or "evil.com@legit.se" would otherwise redirect
 * paying guests to an attacker-controlled page after Stripe checkout, leaking
 * the session_id and enabling booking impersonation.
 */
export function sanitizeDomain(domain: string | null | undefined): string {
  if (!domain) return FALLBACK_DOMAIN;

  // Strip accidental scheme prefix so the regex below can do a clean check
  const stripped = domain.replace(/^https?:\/\//i, "");

  // Allow only hostname characters: labels separated by dots, optional port.
  // Rejects paths (/), query strings (?), credentials (@), and fragments (#).
  const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*(\:\d{1,5})?$/;
  if (!HOSTNAME_RE.test(stripped)) return FALLBACK_DOMAIN;

  // Reject private/loopback ranges that should never appear in production
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(stripped)) {
    return FALLBACK_DOMAIN;
  }

  return stripped;
}

export function getStripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return key;
}

export async function createCheckoutSession(params: {
  amount: number;
  currency: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestEmail: string;
  propertyId: string;
  bookingId: string;
  domain: string;
  hostStripeAccountId?: string | null;
  hostOnboardingComplete?: boolean | null;
}): Promise<{ id: string; url: string; payment_intent: string | null }> {
  const stripeKey = getStripeKey();
  // Direct-to-host: funds settle to the host's connected Stripe (host = merchant
  // of record, 0% platform fee). FAIL CLOSED in live mode — never charge
  // HemmaBo's platform for a host stay when the host's Connect account is missing.
  const routeToHost = Boolean(params.hostStripeAccountId) && Boolean(params.hostOnboardingComplete);
  if (!routeToHost && !stripeKey.startsWith("sk_test_")) {
    throw new Error("Host has not completed Stripe Connect — refusing to charge the platform for a host stay.");
  }
  const body = new URLSearchParams();
  body.append("mode", "payment");
  body.append("line_items[0][price_data][currency]", params.currency.toLowerCase());
  body.append("line_items[0][price_data][unit_amount]", String(toStripeMinorUnits(params.amount)));
  body.append(
    "line_items[0][price_data][product_data][name]",
    `${params.propertyName} — ${params.checkIn} to ${params.checkOut} (${params.guests} guests)`
  );
  body.append("line_items[0][quantity]", "1");
  body.append("customer_email", params.guestEmail);
  body.append("metadata[property_id]", params.propertyId);
  body.append("metadata[booking_id]", params.bookingId);
  body.append("payment_intent_data[metadata][property_id]", params.propertyId);
  body.append("payment_intent_data[metadata][booking_id]", params.bookingId);
  if (routeToHost && params.hostStripeAccountId) {
    body.append("payment_intent_data[application_fee_amount]", "0");
    body.append("payment_intent_data[transfer_data][destination]", params.hostStripeAccountId);
    body.append("payment_intent_data[on_behalf_of]", params.hostStripeAccountId);
  }

  const safeDomain = sanitizeDomain(params.domain);
  const successUrl = `https://${safeDomain}/booking/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `https://${safeDomain}/booking/cancelled`;

  body.append("success_url", successUrl);
  body.append("cancel_url", cancelUrl);

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Stripe error: ${err.error?.message ?? resp.statusText}`);
  }

  const session = await resp.json();
  return { id: session.id, url: session.url, payment_intent: session.payment_intent ?? null };
}

export async function retrievePaymentIntent(paymentIntentId: string): Promise<{
  id: string;
  client_secret: string;
  status: string;
}> {
  const stripeKey = getStripeKey();
  const resp = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Stripe error: ${err.error?.message ?? resp.statusText}`);
  }
  return resp.json();
}

export async function createRefund(
  paymentIntentId: string,
  amount: number,
  idempotencyKey?: string
): Promise<{ id: string; amount: number; status: string }> {
  const stripeKey = getStripeKey();
  const body = new URLSearchParams();
  body.append("payment_intent", paymentIntentId);
  body.append("amount", String(toStripeMinorUnits(amount)));
  // Every stay is a destination charge to the host's connected account. Stripe:
  // "When refunding a charge that has a transfer_data[destination], by default
  // the destination account keeps the funds that were transferred to it,
  // leaving the platform account to cover the negative balance from the
  // refund." (docs.stripe.com/connect/destination-charges#issue-refunds)
  // Without reverse_transfer the host keeps the guest's money and HemmaBo pays
  // the refund out of its own balance — HemmaBo would be in the flow of funds
  // for a stay, which the charter forbids outright. The platform fee is 0, so
  // refund_application_fee has nothing to return and stays unset.
  body.append("reverse_transfer", "true");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Stripe replays the original refund for 24h when the same Idempotency-Key
  // is sent — so a retried or concurrent-duplicate reschedule refund collapses
  // to one movement instead of refunding twice.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const resp = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Stripe error: ${err.error?.message ?? resp.statusText}`);
  }
  return resp.json();
}

export async function createPaymentIntent(params: {
  amount: number;
  currency: string;
  captureMethod: string;
  metadata: Record<string, string>;
  hostStripeAccountId?: string | null;
  hostOnboardingComplete?: boolean | null;
  idempotencyKey?: string;
}): Promise<{ id: string; client_secret: string; status: string }> {
  const stripeKey = getStripeKey();
  // Direct-to-host (host = merchant of record, 0% platform fee). FAIL CLOSED in
  // live mode — never charge HemmaBo's platform for a host stay.
  const routeToHost = Boolean(params.hostStripeAccountId) && Boolean(params.hostOnboardingComplete);
  if (!routeToHost && !stripeKey.startsWith("sk_test_")) {
    throw new Error("Host has not completed Stripe Connect — refusing to charge the platform for a host stay.");
  }
  const body = new URLSearchParams();
  body.append("amount", String(toStripeMinorUnits(params.amount)));
  body.append("currency", params.currency.toLowerCase());
  body.append("capture_method", params.captureMethod);
  for (const [k, v] of Object.entries(params.metadata)) {
    body.append(`metadata[${k}]`, v);
  }
  if (routeToHost && params.hostStripeAccountId) {
    body.append("application_fee_amount", "0");
    body.append("transfer_data[destination]", params.hostStripeAccountId);
    body.append("on_behalf_of", params.hostStripeAccountId);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Stripe replays the original PaymentIntent for 24h on the same
  // Idempotency-Key, so a retried or concurrent-duplicate reschedule charge
  // collapses to one movement instead of charging twice.
  if (params.idempotencyKey) headers["Idempotency-Key"] = params.idempotencyKey;

  const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Stripe error: ${err.error?.message ?? resp.statusText}`);
  }
  return resp.json();
}
