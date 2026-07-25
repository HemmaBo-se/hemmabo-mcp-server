# ADR 0012 - ACP `authentication_required` for payments needing customer authentication

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** Decision delegated by the CEO (2026-07-25, in session) to the
  controlling AI; recorded here per the charter's A/B/C rule.
- **Scope:** One addition to the ACP response-status union and the
  `/acp/checkouts/:id/complete` response for `requires_action` payments.
- **Related:** ADR 0005 (status vocabulary), ADR 0006 (confirmed ownership).

## 1. Context

The payment-truth gate (PR #279) stopped `/complete` from confirming a stay
on any 2xx from Stripe. A payment that needs customer authentication (3DS —
a state Stripe's SPT documentation explicitly reaches via the token's own
`requires_action` transition) was answered with **HTTP 402** and a custom
body.

The ACP specification (`agentic-commerce-protocol`, `2026-04-17`,
`openapi.agentic_checkout.yaml`, verified against the published spec
2026-07-25) says otherwise, in three places:

- The CheckoutSession `status` enum includes **`authentication_required`**.
- `messages[]` carries **`MessageError`** on 2xx responses — with enum codes
  including **`requires_3ds`** — documented as: *"Business-logic error within
  a valid CheckoutSession response. Use MessageError — not Error — when you
  can return a valid CheckoutSession."*
- The `Error` schema (4xx/5xx) is reserved for *"when the server cannot
  return a valid CheckoutSession at all."*

A payment awaiting authentication is a valid session. Our 402 was therefore
non-conformant by the spec's own philosophy, and an ACP-speaking agent would
read it as a generic failure — retry with a new token or abort — instead of
completing the authentication.

## 2. Decision

`ACPCheckoutState["status"]` gains **`authentication_required`**
(vocabulary guard updated in the same PR, per ADR 0006's rule).

`/complete`, when Stripe answers 2xx with PaymentIntent status
`requires_action`, returns **HTTP 200** with:

- `status: "authentication_required"`,
- one `messages[]` entry shaped as a MessageError (`type: "error"`,
  `code: "requires_3ds"`, human-readable `text`),
- `metadata` carrying `payment_intent_id`, `next_action_type`, `next_action`
  and (for SPT redemptions) `stripe_api_version`. No client secret — the
  endpoint answers unauthenticated callers in open mode.

An unparseable 2xx body from Stripe now returns **502** (`processing_error`)
instead of a 402 that read as a clean decline. The payment state is unknown,
not declined; fail closed and keep the intent traceable.

`authentication_required` remains an ACP **response** state (ADR 0005):
`bookings.status` stays `pending` and the `payment_intent.succeeded` webhook
remains the writer that confirms the booking when authentication completes.

## 3. Deliberately out of scope

- **Declines stay HTTP 402.** The spec would prefer 200 +
  `payment_declined`, but `payment_intent.payment_failed` writes
  `bookings.status = cancelled` today (ADR 0005) — making a declined
  checkout retryable is a webhook-vocabulary change, not a response-shape
  change, and was not delegated. Open follow-up.
- **`CheckoutSessionWithOrder`.** The spec's 200-on-complete carries an
  order object we do not emit. Pre-existing deviation, unchanged.
- **GET after `authentication_required` reports `in_progress`.** The row
  cannot distinguish `requires_action` from `processing` without a live
  Stripe read per poll. `in_progress` is a truthful superset ("a payment
  exists — do not pay again"); the agent that must act already holds
  `next_action` from the `/complete` response. Revisit only with e2e
  evidence that agents rely on polling GET for the authentication signal.
