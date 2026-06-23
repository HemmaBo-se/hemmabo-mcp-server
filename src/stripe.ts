/**
 * Stripe helpers — REST API via fetch (no SDK dependency)
 *
 * Used by both api/mcp.ts (HTTP) and src/stdio.ts (stdio)
 * Requires STRIPE_SECRET_KEY environment variable
 */

const FALLBACK_DOMAIN = "hemmabo.se";

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
  amount: number
): Promise<{ id: string; amount: number; status: string }> {
  const stripeKey = getStripeKey();
  const body = new URLSearchParams();
  body.append("payment_intent", paymentIntentId);
  body.append("amount", String(toStripeMinorUnits(amount)));

  const resp = await fetch("https://api.stripe.com/v1/refunds", {
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
  return resp.json();
}

export async function createPaymentIntent(params: {
  amount: number;
  currency: string;
  captureMethod: string;
  metadata: Record<string, string>;
  hostStripeAccountId?: string | null;
  hostOnboardingComplete?: boolean | null;
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

  const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
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
  return resp.json();
}
