/**
 * Stripe helpers — REST API via fetch (no SDK dependency)
 *
 * Used by both api/mcp.ts (HTTP) and src/stdio.ts (stdio)
 * Requires STRIPE_SECRET_KEY environment variable
 */

const FALLBACK_DOMAIN = "hemmabo.se";

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
}): Promise<{ id: string; url: string; payment_intent: string | null }> {
  const stripeKey = getStripeKey();
  const body = new URLSearchParams();
  body.append("mode", "payment");
  body.append("line_items[0][price_data][currency]", params.currency.toLowerCase());
  body.append("line_items[0][price_data][unit_amount]", String(params.amount * 100));
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
  body.append("amount", String(amount * 100));

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
}): Promise<{ id: string; client_secret: string; status: string }> {
  const stripeKey = getStripeKey();
  const body = new URLSearchParams();
  body.append("amount", String(params.amount * 100));
  body.append("currency", params.currency.toLowerCase());
  body.append("capture_method", params.captureMethod);
  for (const [k, v] of Object.entries(params.metadata)) {
    body.append(`metadata[${k}]`, v);
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
