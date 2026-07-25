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
import { blocksAvailability } from "../lib/availability.js";

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
      requires_capture: "not_paid",
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

  it("never reports an uncaptured authorization as paid or as self-resolving", () => {
    // Manual capture holds funds without taking them, and nothing in this
    // repository calls /capture — so `in_flight` would promise a confirmation
    // no code path can deliver, leaving the hold to expire on the guest's card.
    assert.equal(classifyPaymentIntentOutcome("requires_capture"), "not_paid");
  });

  it("treats only 'processing' as self-resolving", () => {
    const inFlight = ALL_PAYMENT_INTENT_STATUSES.filter(
      (s) => classifyPaymentIntentOutcome(s) === "in_flight"
    );
    assert.deepEqual(
      inFlight,
      ["processing"],
      "only a status the webhook can actually resolve may be reported as in flight"
    );
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
    const { body, raw, parsed } = await readStripeBody(
      fakeResponse('{"id":"pi_123","status":"succeeded"}')
    );
    assert.equal(body.id, "pi_123");
    assert.equal(body.status, "succeeded");
    assert.equal(parsed, true);
    assert.ok(raw.includes("pi_123"));
  });

  it("survives an HTML error page from an edge or proxy", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head></html>";
    const resp = fakeResponse(html, 502, "Bad Gateway");
    const { body, raw, parsed } = await readStripeBody(resp);
    assert.deepEqual(body, {}, "an unparseable body yields no fields, not a throw");
    assert.equal(raw, html);
    assert.equal(parsed, false);
    const message = stripeErrorMessage(body, raw, resp, parsed);
    assert.match(message, /Non-JSON/, "a genuinely unparseable body may say so");
    assert.match(message, /502 Bad Gateway/, "the raw body must survive into the message");
  });

  it("does not call a well-formed JSON error 'Non-JSON'", async () => {
    // A Stripe error carrying only code/type used to be reported as a
    // transport failure, sending whoever debugs an SPT redemption hunting an
    // edge problem that does not exist.
    const payload = '{"error":{"code":"resource_missing","type":"invalid_request_error"}}';
    const resp = fakeResponse(payload, 402, "Payment Required");
    const { body, raw, parsed } = await readStripeBody(resp);
    const message = stripeErrorMessage(body, raw, resp, parsed);
    assert.doesNotMatch(message, /Non-JSON/);
    assert.match(message, /resource_missing/, "the Stripe error code must reach the caller");
  });

  it("survives an empty body", async () => {
    const resp = fakeResponse("", 500, "Internal Server Error");
    const { body, raw, parsed } = await readStripeBody(resp);
    assert.deepEqual(body, {});
    assert.equal(raw, "");
    assert.equal(parsed, false);
    assert.equal(stripeErrorMessage(body, raw, resp, parsed), "Internal Server Error");
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
    const message = stripeErrorMessage({}, "x".repeat(5000), resp, false);
    assert.ok(message.length < 300, `error message stayed bounded (${message.length} chars)`);
  });
});


describe("ACP status is derived from data, so every surface agrees", () => {
  it("reports in_progress for a pending booking that already carries a charge", () => {
    // GET and PUT build their state from the same helper as /complete. If only
    // /complete knew about the in-flight payment, the agent's very next poll
    // would say "ready for payment" and invite a second charge for the stay.
    assert.match(
      acpSource,
      /function deriveACPStatus\(/,
      "the ACP status must be derived, not passed in at one call site"
    );
    assert.match(
      acpSource,
      /booking\.status === "pending" && booking\.stripe_payment_intent_id[\s\S]{0,80}?return "in_progress"/,
      "a pending booking with a PaymentIntent must render as in_progress"
    );
    assert.match(
      acpSource,
      /const status = deriveACPStatus\(booking\)/,
      "buildACPState must use the derived status for every caller"
    );
    assert.doesNotMatch(
      acpSource,
      /statusOverride/,
      "a per-call override would let one surface contradict another"
    );
  });

  it("tells an in-flight caller to poll rather than pay again", () => {
    assert.match(acpSource, /Do not pay again/);
    assert.match(
      acpSource,
      /poll \$\{base\}\/acp\/checkouts\/\$\{booking\.id\}/,
      "the message must name where to observe the outcome"
    );
  });
});

describe("ACP complete path wiring", () => {
  const gateIndex = acpSource.indexOf('if (outcome !== "succeeded")');
  const inFlightIndex = acpSource.indexOf('if (outcome === "in_flight")');
  const confirmedIndex = acpSource.indexOf("// Update booking to confirmed");
  const piIdIndex = acpSource.indexOf("stripe_payment_intent_id: pi.id");

  it("classifies the outcome through the shared helper, not an inline comparison", () => {
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
    assert.ok(
      inFlightIndex > -1 && inFlightIndex < confirmedIndex,
      "the in-flight branch must return before the confirmed write"
    );
  });

  it("persists the PaymentIntent id regardless of outcome, before the gate", () => {
    assert.ok(piIdIndex > -1, "the PaymentIntent id must be recorded as soon as it exists");
    assert.ok(
      piIdIndex < gateIndex,
      "refund/cancel must be able to find the charge even when the booking never confirms"
    );
  });

  it("refuses to create a second PaymentIntent when one already exists", () => {
    // Gating `confirmed` on success removed the accidental re-entry guard: an
    // in-flight payment keeps the booking pending, which is exactly when a
    // retrying agent would charge the same stay twice.
    assert.match(
      acpSource,
      /if \(booking\.stripe_payment_intent_id\) \{[\s\S]{0,400}?readPaymentIntentOutcome\(booking\.stripe_payment_intent_id\)/,
      "completeCheckout must inspect an existing intent before creating another"
    );
    const guardIndex = acpSource.indexOf("readPaymentIntentOutcome(booking.stripe_payment_intent_id)");
    const chargeIndex = acpSource.indexOf("https://api.stripe.com/v1/payment_intents\"");
    assert.ok(guardIndex > -1 && guardIndex < chargeIndex, "the guard must precede the charge");
    assert.match(
      acpSource,
      /Could not read the existing payment for this checkout/,
      "an unreadable existing payment must fail closed, never fall through to a new charge"
    );
  });

  it("self-heals a settled charge whose confirmed write was lost", () => {
    assert.match(
      acpSource,
      /existing\.outcome === "succeeded"[\s\S]{0,400}?status: "confirmed"/,
      "a succeeded intent on a pending booking must confirm it, not charge again"
    );
  });

  it("sends Stripe an Idempotency-Key scoped to checkout, amount, currency and token", () => {
    assert.match(
      acpSource,
      /piHeaders\["Idempotency-Key"\][\s\S]{0,160}?acp_complete_\$\{booking\.id\}_\$\{amountCents\}_\$\{currency\}_\$\{idemFingerprint\(token\)/,
      "the key must cover the amount — Stripe replays the original PaymentIntent for 24h"
    );
    const keyIndex = acpSource.indexOf('piHeaders["Idempotency-Key"]');
    const fetchIndex = acpSource.indexOf('https://api.stripe.com/v1/payment_intents"');
    assert.ok(keyIndex > -1 && keyIndex < fetchIndex, "the key must be set before the charge is sent");
  });

  it("answers requires_action with 200 + authentication_required, per ADR 0012", () => {
    // The ACP spec reserves 4xx Error for "no valid session state to return".
    // A payment awaiting 3DS is a valid session: status authentication_required
    // with a MessageError (requires_3ds) in messages[]. A 402 here makes an
    // ACP agent retry with a fresh token instead of completing the auth.
    assert.match(
      acpSource,
      /paymentStatus === "requires_action"[\s\S]{0,600}?authState\.status = "authentication_required"/,
      "requires_action must set the spec-defined session status"
    );
    assert.match(
      acpSource,
      /code: "requires_3ds"/,
      "the message must carry the ACP MessageError code"
    );
    const authIdx = acpSource.indexOf('authState.status = "authentication_required"');
    const declineIdx = acpSource.indexOf('"Payment not completed"');
    assert.ok(
      authIdx > -1 && authIdx < declineIdx,
      "the authentication branch must run before the 402 decline fallback"
    );
  });

  it("gives an agent what it needs to finish an authentication", () => {
    assert.match(acpSource, /payment_intent_id: typeof pi\.id === "string"/);
    assert.match(acpSource, /next_action: pi\.next_action \?\? null/);
    assert.doesNotMatch(
      acpSource,
      /client_secret: /,
      "no client secret on an endpoint that answers unauthenticated callers in open mode"
    );
  });

  it("fails closed on an unreadable payment outcome instead of calling it a decline", () => {
    // Stripe said 2xx but the body was unparseable: the money may have moved.
    // A 402 would read as a clean decline and invite a second charge.
    assert.match(
      acpSource,
      /paymentStatus === "unknown"[\s\S]{0,400}?res\.status\(502\)/,
      "an unknown payment state must be a 502 processing_error, not a 402 decline"
    );
  });

  it("leaves no bare piResp.json() that could throw into an opaque 500", () => {
    assert.doesNotMatch(
      acpSource,
      /await piResp\.json\(\)/,
      "read Stripe responses through readStripeBody so a non-JSON body cannot crash the handler"
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

describe("Cancel path asks Stripe what the money did", () => {
  it("never infers 'paid' from the booking row", () => {
    // Two writes stand between a settled charge and status='confirmed', so a
    // real payment can sit on a booking that still reads pending. Cancelling
    // on the row alone would refund nothing and keep the guest's money.
    assert.doesNotMatch(
      acpSource,
      /const wasPaid = booking\.status === "confirmed"/,
      "the cancel path must not use bookings.status as a proxy for 'money moved'"
    );
    assert.match(
      acpSource,
      /const live = await readPaymentIntentOutcome\(paymentIntentId\)/,
      "the cancel path must read the live PaymentIntent"
    );
    assert.match(acpSource, /liveOutcome === "succeeded"/, "refunds are gated on a settled charge");
  });

  it("refuses to finalise a cancellation while money is still in flight", () => {
    assert.match(
      acpSource,
      /liveOutcome === "in_flight"[\s\S]{0,400}?res\.status\(409\)/,
      "cancelling a processing payment would let it settle against a stay that no longer exists"
    );
    assert.match(
      acpSource,
      /Could not read the payment status — booking left in non-final state/,
      "an unreadable payment must block the cancel, not be assumed harmless"
    );
  });

  it("cancels an unpaid intent so it can never charge later", () => {
    assert.match(
      acpSource,
      /liveOutcome === "not_paid"[\s\S]{0,600}?payment_intents\/\$\{encodeURIComponent\(paymentIntentId\)\}\/cancel/,
      "an intent on a cancelled booking must be cancelled at Stripe"
    );
    const cancelBlock = acpSource.slice(
      acpSource.indexOf('if (liveOutcome === "not_paid")'),
      acpSource.indexOf("ADR 0002 §2.2 clause 5")
    );
    assert.ok(cancelBlock.length > 0, "expected the unpaid-intent block before the refund block");
    assert.doesNotMatch(
      cancelBlock,
      /return res\.status\(/,
      "a failed intent-cancel must never abort the guest's cancellation"
    );
  });
});

describe("Refunds pull the money back from the host, not from HemmaBo", () => {
  const stripeHelpers = readFileSync(join(root, "src", "stripe.ts"), "utf8");

  it("sets reverse_transfer on every refund of a destination charge", () => {
    // Stripe: "the destination account keeps the funds that were transferred
    // to it, leaving the platform account to cover the negative balance from
    // the refund". Without this, HemmaBo pays for host refunds out of its own
    // balance — HemmaBo would be in the flow of funds for a stay, which the
    // charter forbids outright.
    for (const [name, source] of [
      ["api/acp.ts", acpSource],
      ["src/stripe.ts", stripeHelpers],
    ] as const) {
      const refundCalls = source.split("v1/refunds").length - 1;
      assert.ok(refundCalls > 0, `${name} should still create refunds`);
      assert.match(
        source,
        /reverse_transfer["']?,\s*["']true["']|reverse_transfer=true/,
        `${name} must reverse the transfer so the host funds the refund`
      );
    }
  });

  it("does not refund the application fee — there is none to return", () => {
    // application_fee_amount is 0 on every charge (0% commission), so
    // refund_application_fee would be meaningless noise on the wire. Match a
    // parameter actually being sent, not the word in a comment explaining why
    // it is absent.
    for (const [name, source] of [
      ["api/acp.ts", acpSource],
      ["src/stripe.ts", stripeHelpers],
    ] as const) {
      assert.doesNotMatch(
        source,
        /append\(\s*["']refund_application_fee["']/,
        `${name} must not send refund_application_fee`
      );
    }
  });
});

describe("A stay with a live payment keeps its dates", () => {
  const CUTOFF = "2026-07-25T12:00:00.000Z";

  it("confirmed always blocks, whatever its age", () => {
    assert.equal(
      blocksAvailability({ status: "confirmed", created_at: "2020-01-01T00:00:00.000Z" }, CUTOFF),
      true
    );
  });

  it("a fresh pending checkout blocks", () => {
    assert.equal(
      blocksAvailability({ status: "pending", created_at: "2026-07-25T18:00:00.000Z" }, CUTOFF),
      true
    );
  });

  it("an abandoned pending checkout stops blocking", () => {
    assert.equal(
      blocksAvailability({ status: "pending", created_at: "2026-07-20T00:00:00.000Z" }, CUTOFF),
      false
    );
  });

  it("an old pending checkout with a live payment KEEPS blocking", () => {
    // The regression this guards: gating `confirmed` on a settled payment
    // leaves an in-flight charge on a pending row. Async methods take days,
    // so the 24h stale filter would have released the nights mid-payment —
    // a second guest books them, then the first payment settles and the
    // webhook confirms it too. Two confirmed bookings, one property.
    assert.equal(
      blocksAvailability(
        {
          status: "pending",
          created_at: "2026-07-01T00:00:00.000Z",
          stripe_payment_intent_id: "pi_live_123",
        },
        CUTOFF
      ),
      true
    );
  });

  it("cancelled and unknown statuses never block", () => {
    for (const status of ["cancelled", "completed", "", undefined]) {
      assert.equal(
        blocksAvailability({ status, stripe_payment_intent_id: "pi_x" }, CUTOFF),
        false,
        `status ${JSON.stringify(status)} must not hold dates`
      );
    }
  });

  it("a pending row with neither a payment nor a timestamp does not block", () => {
    assert.equal(blocksAvailability({ status: "pending" }, CUTOFF), false);
  });
});
