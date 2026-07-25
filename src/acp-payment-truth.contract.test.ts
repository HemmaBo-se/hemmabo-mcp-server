/**
 * Contract test — a stay is confirmed only when Stripe took the money.
 *
 * Why this exists: Stripe answers HTTP 200 for a `confirm=true` PaymentIntent
 * that has NOT charged anyone — `requires_action` (3DS), `processing` (funds
 * in flight), `requires_payment_method` (soft decline). The ACP complete path
 * used to treat any 2xx as payment: it wrote `bookings.status = "confirmed"`,
 * blocked the host's calendar, and answered the agent with "Booking confirmed
 * and paid." while nothing had settled. ADR 0006 allows the synchronous ACP
 * write only "after Stripe has accepted and confirmed the payment intent" —
 * acceptance is the 2xx, confirmation is `status: "succeeded"`.
 *
 * What this locks:
 *   1. The outcome classification, exhaustively over Stripe's PaymentIntent
 *      statuses, including that unknown/malformed statuses fail closed.
 *   2. `requires_capture` is never "paid" — an authorization is not a stay.
 *   3. Stripe responses are read without a non-JSON body throwing.
 *   4. The wiring in api/acp.ts: the gate runs before the confirmed write, the
 *      PaymentIntent id is persisted regardless of outcome, and no bare
 *      `piResp.json()` can resurrect the opaque-500 failure mode.
 *
 * Run: npx tsx --test src/acp-payment-truth.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPaymentIntentOutcome,
  readStripeBody,
  stripeErrorMessage,
} from "./stripe.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const acpSource = readFileSync(join(root, "api", "acp.ts"), "utf8");

/** Every status a PaymentIntent can hold, per Stripe's object reference. */
const ALL_PAYMENT_INTENT_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
] as const;

/** Build a fake fetch Response carrying `text` with the given status. */
function fakeResponse(text: string, status = 200, statusText = "OK"): Response {
  return new Response(text, { status, statusText });
}

describe("PaymentIntent outcome classification", () => {
  it("treats only 'succeeded' as paid", () => {
    const paid = ALL_PAYMENT_INTENT_STATUSES.filter(
      (s) => classifyPaymentIntentOutcome(s) === "succeeded"
    );
    assert.deepEqual(
      paid,
      ["succeeded"],
      "exactly one PaymentIntent status may confirm a stay"
    );
  });

  it("classifies every documented status explicitly", () => {
    const expected: Record<(typeof ALL_PAYMENT_INTENT_STATUSES)[number], string> = {
      requires_payment_method: "not_paid",
      requires_confirmation: "not_paid",
      requires_action: "not_paid",
      processing: "in_flight",
      requires_capture: "in_flight",
      canceled: "not_paid",
      succeeded: "succeeded",
    };
    for (const status of ALL_PAYMENT_INTENT_STATUSES) {
      assert.equal(
        classifyPaymentIntentOutcome(status),
        expected[status],
        `status ${status} must classify as ${expected[status]}`
      );
    }
  });

  it("never reports an uncaptured authorization as paid", () => {
    // Manual capture holds funds without taking them. A held card is not a
    // paid stay, and the host must not see the dates sold on an auth alone.
    assert.equal(classifyPaymentIntentOutcome("requires_capture"), "in_flight");
  });

  it("fails closed on absent, malformed, or unexpected statuses", () => {
    const junk: unknown[] = [
      undefined,
      null,
      "",
      "SUCCEEDED",
      " succeeded",
      "succeeded ",
      0,
      1,
      true,
      {},
      [],
      { status: "succeeded" },
      "some_future_status_stripe_adds",
    ];
    for (const value of junk) {
      assert.equal(
        classifyPaymentIntentOutcome(value),
        "not_paid",
        `${JSON.stringify(value)} must not be read as a completed payment`
      );
    }
  });
});

describe("Stripe response reading never throws on a non-JSON body", () => {
  it("parses a normal JSON body", async () => {
    const { body, raw } = await readStripeBody(
      fakeResponse('{"id":"pi_123","status":"succeeded"}')
    );
    assert.equal(body.id, "pi_123");
    assert.equal(body.status, "succeeded");
    assert.ok(raw.includes("pi_123"));
  });

  it("survives an HTML error page from an edge or proxy", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head></html>";
    const resp = fakeResponse(html, 502, "Bad Gateway");
    const { body, raw } = await readStripeBody(resp);
    assert.deepEqual(body, {}, "an unparseable body yields no fields, not a throw");
    assert.equal(raw, html);
    const message = stripeErrorMessage(body, raw, resp);
    assert.match(message, /HTTP 502/);
    assert.match(message, /502 Bad Gateway/, "the raw body must survive into the message");
  });

  it("survives an empty body", async () => {
    const resp = fakeResponse("", 500, "Internal Server Error");
    const { body, raw } = await readStripeBody(resp);
    assert.deepEqual(body, {});
    assert.equal(raw, "");
    assert.equal(stripeErrorMessage(body, raw, resp), "Internal Server Error");
  });

  it("treats JSON null and scalars as no body rather than crashing", async () => {
    for (const payload of ["null", "42", '"a string"']) {
      const { body } = await readStripeBody(fakeResponse(payload));
      assert.deepEqual(body, {}, `${payload} must not become a field bag`);
    }
  });

  it("prefers Stripe's own error message when present", () => {
    const resp = { status: 402, statusText: "Payment Required" };
    const message = stripeErrorMessage(
      { error: { message: "No such shared_payment_token" } },
      '{"error":{"message":"No such shared_payment_token"}}',
      resp
    );
    assert.equal(message, "No such shared_payment_token");
  });

  it("truncates a long raw body so an error page cannot flood the response", () => {
    const resp = { status: 500, statusText: "" };
    const message = stripeErrorMessage({}, "x".repeat(5000), resp);
    assert.ok(message.length < 300, `error message stayed bounded (${message.length} chars)`);
  });
});

describe("ACP complete path wiring", () => {
  const gateIndex = acpSource.indexOf('if (outcome !== "succeeded")');
  const inFlightIndex = acpSource.indexOf('if (outcome === "in_flight")');
  const confirmedIndex = acpSource.indexOf("// Update booking to confirmed");
  const piIdIndex = acpSource.indexOf(".update({ stripe_payment_intent_id: pi.id })");

  it("classifies the outcome through the shared helper, not an inline comparison", () => {
    assert.match(acpSource, /classifyPaymentIntentOutcome/);
    assert.match(
      acpSource,
      /const outcome = classifyPaymentIntentOutcome\(pi\.status\)/,
      "the money decision must come from the tested helper"
    );
  });

  it("runs the succeeded-gate before writing confirmed", () => {
    assert.ok(gateIndex > -1, "expected a not-succeeded gate in completeCheckout");
    assert.ok(confirmedIndex > -1, "expected the confirmed write to still exist");
    assert.ok(
      gateIndex < confirmedIndex,
      "the confirmed write must be unreachable unless the payment succeeded"
    );
  });

  it("answers in_progress for an in-flight payment instead of ready_for_payment", () => {
    assert.ok(inFlightIndex > -1, "expected an in-flight branch");
    assert.ok(
      inFlightIndex < confirmedIndex,
      "the in-flight branch must return before the confirmed write"
    );
    assert.match(
      acpSource,
      /buildACPState\(checkoutId, base, "in_progress"\)/,
      "an in-flight payment must not render as ready_for_payment — that invites a second charge"
    );
    assert.match(
      acpSource,
      /Do not pay again/,
      "the in-flight message must warn against re-paying a live charge"
    );
  });

  it("persists the PaymentIntent id regardless of outcome, before the gate", () => {
    assert.ok(piIdIndex > -1, "the PaymentIntent id must be recorded as soon as it exists");
    assert.ok(
      piIdIndex < gateIndex,
      "refund/cancel must be able to find the charge even when the booking never confirms"
    );
  });

  it("leaves no bare piResp.json() that could throw into an opaque 500", () => {
    assert.doesNotMatch(
      acpSource,
      /await piResp\.json\(\)/,
      "read Stripe responses through readStripeBody so a non-JSON body cannot crash the handler"
    );
  });

  it("sends Stripe an Idempotency-Key scoped to the checkout and the token", () => {
    // Gating `confirmed` on success removed an accidental re-entry guard: a
    // payment left in flight now keeps the booking `pending`, so a retried
    // /complete would charge again. Stripe's own key is the durable fix — our
    // Redis cache fails open when unconfigured.
    assert.match(
      acpSource,
      /piHeaders\["Idempotency-Key"\] = `acp_complete_\$\{booking\.id\}_\$\{idemFingerprint\(token\)/,
      "the PaymentIntent create must carry an Idempotency-Key derived from the checkout and the token"
    );
    const keyIndex = acpSource.indexOf('piHeaders["Idempotency-Key"]');
    const fetchIndex = acpSource.indexOf("https://api.stripe.com/v1/payment_intents");
    assert.ok(keyIndex > -1 && keyIndex < fetchIndex, "the key must be set before the charge is sent");
    assert.doesNotMatch(
      acpSource,
      /Idempotency-Key"\] = `acp_complete_\$\{booking\.id\}`/,
      "a checkout-only key would block a legitimate retry with a different payment method"
    );
  });

  it("refunds only a booking that actually reached confirmed", () => {
    // completeCheckout now records the PaymentIntent id even when no money
    // moved. Refunding such an intent returns a Stripe error, which the cancel
    // path turns into a 502 and a booking the guest cannot cancel.
    assert.match(
      acpSource,
      /const wasPaid = booking\.status === "confirmed";/,
      "cancelCheckout must distinguish a paid booking from a recorded-but-unpaid intent"
    );
    assert.match(
      acpSource,
      /if \(booking\.stripe_payment_intent_id && wasPaid\) \{/,
      "the refund attempt must be gated on the booking having been paid"
    );
    assert.match(
      acpSource,
      /if \(booking\.stripe_payment_intent_id && !wasPaid\) \{/,
      "an unpaid intent must be handled explicitly, not silently refunded"
    );
  });

  it("cancels an unpaid PaymentIntent instead of leaving it able to charge later", () => {
    assert.match(
      acpSource,
      /payment_intents\/\$\{encodeURIComponent\(booking\.stripe_payment_intent_id\)\}\/cancel/,
      "an intent on a cancelled booking must be cancelled at Stripe"
    );
    // The guest's cancellation must not depend on Stripe accepting the cancel:
    // a dead or already-processing intent still leaves the booking cancellable.
    const cancelBlock = acpSource.slice(
      acpSource.indexOf("if (booking.stripe_payment_intent_id && !wasPaid)"),
      acpSource.indexOf("ADR 0002 §2.2 clause 5")
    );
    assert.ok(cancelBlock.length > 0, "expected the unpaid-intent block before the refund block");
    assert.match(cancelBlock, /try \{/, "the Stripe cancel call must be wrapped");
    assert.doesNotMatch(
      cancelBlock,
      /return res\.status\(/,
      "a failed intent-cancel must never abort the guest's cancellation"
    );
  });

  it("rejects a non-string payment token with 400 rather than crashing on startsWith", () => {
    assert.match(
      acpSource,
      /typeof paymentData\?\.token === "string"/,
      "the token must be type-checked before any string method runs on it"
    );
    assert.doesNotMatch(
      acpSource,
      /paymentData\.token\.startsWith/,
      "startsWith must run on the validated local token, never the raw request field"
    );
  });
});
