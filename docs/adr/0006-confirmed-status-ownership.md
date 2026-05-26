# ADR 0006 - Confirmed Status Ownership

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** HemmaBo core
- **Scope:** Documentation and guard only. No runtime behavior changes.
- **Supersedes:** ADR 0002 section 2.2 clause 3 for `bookings.status = confirmed`
- **Related:** ADR 0005, `hemmabo-smart-stays` booking status ownership decision

## 1. Context

HemmaBo is infrastructure and federation, not an OTA or marketplace.

The host node owns the booking lifecycle. Stripe owns payment event facts.
HemmaBo infrastructure may sync, verify, and enforce approved technical
transitions, but must not become the owner of the host/guest booking.

HEAD evidence shows two current `confirmed` writers in this repository:

- `api/acp.ts` writes `bookings.status = "confirmed"` synchronously after
  Stripe `confirm=true` succeeds in the ACP complete path.
- `api/stripe-webhook.ts` writes `bookings.status = "confirmed"` when Stripe
  sends `payment_intent.succeeded`.

ADR 0002 is still `Proposed` and claimed the webhook was the only writer of
terminal booking status. That statement no longer matches the code or ADR
0005.

## 2. Decision

No runtime behavior changes are made by this ADR.

ADR 0002's webhook-only terminal-status clause is superseded for
`bookings.status = confirmed`.

The current MCP/ACP compatibility contract is:

- ACP may synchronously write `confirmed` after Stripe has accepted and
  confirmed the payment intent.
- The Stripe webhook remains the authoritative Stripe-event reconciliation
  path and may also write `confirmed` for `payment_intent.succeeded`.
- `confirmed` remains a booking lifecycle status on the host-node booking row,
  not a standalone payment fact.
- Stripe payment/refund facts must remain explicit Stripe facts, such as
  `stripe_payment_intent_id`, `refund_status`, and webhook event handling.
  Do not introduce `paid`, `disputed`, or refund-state words as
  `bookings.status`.

This does not make HemmaBo an OTA, marketplace, merchant-of-record owner of
the stay, or central booking-status owner. It documents the current
infrastructure bridge between an ACP payment completion and the host-node
booking lifecycle.

## 3. Consequences

Future work may still split booking lifecycle and payment state into separate
fields. That requires a new accepted ADR, schema/migration plan, webhook
contract, and compatibility plan for existing rows.

Any future change that removes the ACP synchronous `confirmed` write, removes
the webhook `confirmed` write, or adds a payment/refund/dispute word such as
`paid`, `disputed`, `refund_status`, or refund-state words to
`bookings.status` must update the status vocabulary guard in the same PR.

`charge.dispute.created` stays outside HemmaBo-owned handling unless a new
accepted chargeback-boundary ADR changes that model. Hosts handle Stripe
chargebacks in their Stripe Dashboard. Do not model Stripe chargebacks as
`bookings.status`, `refund_status`, or a HemmaBo-owned dispute workflow.
