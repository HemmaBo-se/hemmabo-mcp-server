/**
 * Stripe webhook handler — single authoritative source for terminal
 * payment / refund state on bookings.
 *
 * ADR 0002 §2.2 clause 3:
 *   "A Stripe webhook handler at api/stripe-webhook.ts verifies
 *    Stripe-Signature (constant-time HMAC against STRIPE_WEBHOOK_SECRET)
 *    and is the single writer of bookings.status = confirmed and
 *    bookings.refund_status. The synchronous HTTP path may write
 *    pending / processing but must not write a terminal status."
 *
 * Events handled:
 *   - payment_intent.succeeded     → bookings.status = 'confirmed'
 *   - payment_intent.payment_failed → bookings.status = 'cancelled'
 *   - charge.refunded              → bookings.refund_status = 'succeeded'
 *   - charge.refund.updated        → may set 'failed'
 *
 * Known gap:
 *   - charge.dispute.created is not handled yet; it needs an explicit
 *     bookings status / schema contract before enabling.
 *
 * Endpoint: POST /api/stripe-webhook
 * Vercel rewrite: see vercel.json. Configure the URL in Stripe Dashboard
 * → Developers → Webhooks → "Add endpoint" and copy the signing secret
 * into STRIPE_WEBHOOK_SECRET on Vercel.
 *
 * Security:
 *   - Verifies Stripe-Signature using HMAC-SHA256 with timingSafeEqual.
 *   - Rejects timestamps older than 5 minutes (replay protection per
 *     Stripe's signature spec).
 *   - Returns 400 on any verification failure. Never 401 — Stripe retries
 *     on non-2xx, and we don't want it to retry on signature failures.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

const FIVE_MINUTES_S = 5 * 60;

// ── Supabase ─────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// ── Signature verification ───────────────────────────────────────

/**
 * Parse the Stripe-Signature header: "t=1234567890,v1=hex,v1=hex,v0=hex".
 */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split("=", 2);
    if (k === "t") {
      timestamp = Number(v);
    } else if (k === "v1" && v) {
      signatures.push(v);
    }
  }
  if (timestamp === null || Number.isNaN(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Constant-time compare two hex-encoded HMAC signatures.
 */
function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a Stripe webhook signature against the raw request body.
 * Exported for the contract test (uses the same code, no shortcut).
 *
 * `nowSeconds` is injectable so tests can run with a fixed clock.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { valid: true } | { valid: false; reason: string } {
  if (!signatureHeader) return { valid: false, reason: "Missing Stripe-Signature header" };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: "Malformed Stripe-Signature header" };

  if (Math.abs(nowSeconds - parsed.timestamp) > FIVE_MINUTES_S) {
    return { valid: false, reason: "Signature timestamp outside tolerance window" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest("hex");

  for (const sig of parsed.signatures) {
    if (safeCompareHex(sig, expected)) return { valid: true };
  }
  return { valid: false, reason: "No matching signature" };
}

// ── Raw body reader ──────────────────────────────────────────────

/**
 * Vercel's default body parser converts JSON before we see it, which
 * breaks signature verification because Stripe signs the exact bytes
 * sent. We must read the raw stream ourselves.
 */
async function readRawBody(req: VercelRequest): Promise<string> {
  // If a previous middleware already parsed the body, fall back to JSON
  // stringify. This is a degraded path used only in tests; in prod the
  // route is configured with bodyParser disabled (see export config).
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any;
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    r.on("error", reject);
  });
}

// ── Event dispatch ───────────────────────────────────────────────

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function handleEvent(event: StripeEvent): Promise<{ status: "ok" | "ignored"; detail?: string }> {
  const supabase = getSupabase();
  const obj = event.data.object;

  // PaymentIntent metadata.booking_id is the canonical link from Stripe to
  // our bookings table. createCheckout() in api/acp.ts sets it. If it's
  // missing, we cannot route the event safely — log and ignore.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata = (obj as any).metadata as Record<string, string> | undefined;
  const bookingId = metadata?.booking_id;

  switch (event.type) {
    case "payment_intent.succeeded": {
      if (!bookingId) return { status: "ignored", detail: "no booking_id in metadata" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const paymentIntentId = (obj as any).id as string;
      const { error } = await supabase
        .from("bookings")
        .update({ status: "confirmed", stripe_payment_intent_id: paymentIntentId })
        .eq("id", bookingId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
      return { status: "ok" };
    }

    case "payment_intent.payment_failed": {
      if (!bookingId) return { status: "ignored", detail: "no booking_id in metadata" };
      const { error } = await supabase
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", bookingId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
      return { status: "ok" };
    }

    case "charge.refunded": {
      // For refunds, Stripe sends a Charge object with refunds list. The
      // PaymentIntent is on .payment_intent. We map back to booking via
      // stripe_payment_intent_id (set on the booking when the charge was
      // created).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const paymentIntentId = (obj as any).payment_intent as string | undefined;
      if (!paymentIntentId) return { status: "ignored", detail: "no payment_intent on charge" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refunds = ((obj as any).refunds?.data ?? []) as Array<{ id: string; status: string }>;
      const latestRefund = refunds[refunds.length - 1];
      const { error } = await supabase
        .from("bookings")
        .update({
          status: "cancelled",
          refund_status: "succeeded",
          refund_id: latestRefund?.id ?? null,
          refund_error: null,
        })
        .eq("stripe_payment_intent_id", paymentIntentId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
      return { status: "ok" };
    }

    case "charge.refund.updated": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refund = obj as any;
      if (refund.status !== "failed") return { status: "ignored", detail: `refund status: ${refund.status}` };
      const paymentIntentId = refund.payment_intent as string | undefined;
      if (!paymentIntentId) return { status: "ignored", detail: "no payment_intent on refund" };
      const { error } = await supabase
        .from("bookings")
        .update({
          refund_status: "failed",
          refund_id: refund.id ?? null,
          refund_error: refund.failure_reason ?? refund.failure_message ?? "unknown",
        })
        .eq("stripe_payment_intent_id", paymentIntentId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
      return { status: "ok" };
    }

    default:
      return { status: "ignored", detail: `unhandled event type: ${event.type}` };
  }
}

// ── HTTP handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Without the signing secret we cannot verify anything. Returning 500
    // signals to Stripe that the endpoint is broken so it will retry, and
    // surfaces the misconfiguration in dashboards instead of silently
    // accepting unverified events.
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: "Could not read body", detail: String(err) });
  }

  const sig = req.headers["stripe-signature"];
  const sigHeader = Array.isArray(sig) ? sig[0] : sig;
  const verify = verifyStripeSignature(rawBody, sigHeader, secret);
  if (!verify.valid) {
    console.error("Stripe signature verification failed:", verify.reason);
    return res.status(400).json({ error: "Invalid signature", reason: verify.reason });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    const result = await handleEvent(event);
    return res.status(200).json({ received: true, event_id: event.id, ...result });
  } catch (err) {
    // Re-throw to Stripe by returning 500 — Stripe will retry. We log so
    // the failure is observable.
    const message = err instanceof Error ? err.message : "Internal error";
    console.error(`Stripe webhook handler error for event ${event.id} (${event.type}):`, message);
    return res.status(500).json({ error: message });
  }
}

// Disable Vercel's default body parser so we can read the raw bytes
// Stripe signed. See https://vercel.com/docs/functions/edge-functions/edge-runtime#api-routes
export const config = {
  api: { bodyParser: false },
};
