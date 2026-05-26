# ADR 0005 - Booking and Payment Status Vocabulary Audit

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** HemmaBo core
- **Scope:** Audit and guard only. No runtime behaviour changes.
- **Related:** ADR 0002, `hemmabo-smart-stays` ADR `2026-05-26-booking-status-vocabulary-audit.md`

## 1. Context

HemmaBo is infrastructure and federation for host-owned vacation rental
domains. HemmaBo is not an OTA, not a marketplace, and not a generic website
builder.

The host node owns the booking lifecycle record. Stripe owns payment event
facts. HemmaBo infrastructure verifies, syncs, and enforces technical state
changes through approved paths.

This repository exposes the MCP and ACP surfaces that agents call. It must not
silently drift from the host-node booking vocabulary in `hemmabo-smart-stays`,
and it must not turn payment facts such as disputes into booking lifecycle
states without an accepted decision.

## 2. Evidence Read

### ACP status surface

- `api/acp.ts` exposes ACP protocol statuses:
  `not_ready_for_payment`, `ready_for_payment`, `completed`, `canceled`,
  `in_progress`.
- Those are ACP response states, not automatically `bookings.status` values.

### ACP direct booking writes

- `api/acp.ts` creates checkout rows as `pending`.
- `api/acp.ts` currently writes `confirmed` synchronously after Stripe
  `confirm=true` succeeds.
- `api/acp.ts` writes `cancelled` after cancel/refund handling.

### Stripe webhook writes

- `api/stripe-webhook.ts` handles:
  `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `charge.refunded`, `charge.refund.updated`.
- `payment_intent.succeeded` writes `bookings.status = confirmed`.
- `payment_intent.payment_failed` writes `bookings.status = cancelled`.
- `charge.refunded` writes `bookings.status = cancelled` and
  `refund_status = succeeded`.
- `charge.refund.updated` may write `refund_status = failed`.
- `charge.dispute.created` is still a known gap and is not implemented.

### Public MCP booking schemas

- `hemmabo_booking_create` and `hemmabo_booking_status` publish the current
  compatibility enum:
  `pending`, `confirmed`, `cancelled`, `completed`.
- `hemmabo_booking_cancel` publishes `cancelled`.
- `hemmabo_booking_checkout` returns a string status without a closed enum,
  because it returns the current booking row while payment is still pending.

## 3. Vocabulary Classification

| Word | Current classification | Notes |
| --- | --- | --- |
| `pending` | Booking lifecycle | Used for created unpaid/pending rows. |
| `confirmed` | Booking lifecycle, overloaded | Used by ACP sync completion and webhook payment success. Needs follow-up with ADR 0002. |
| `cancelled` | Booking lifecycle | Used by ACP cancel and webhook failure/refund paths. |
| `completed` | Public MCP compatibility value | Present in MCP output schemas, not currently a write path in this repository. |
| `declined` | Host decision vocabulary in smart-stays | Not currently an MCP-server write or public MCP enum. |
| `paid` | Payment fact, not booking lifecycle | Must not be added as `bookings.status` without a decision. |
| `checked_in` | Stay operational state | Must not be added as `bookings.status` without a decision. |
| `checked_out` | Stay operational state | Must not be added as `bookings.status` without a decision. |
| `disputed` | Payment/dispute fact | Not implemented. Should be modelled deliberately as payment/dispute state if added. |
| `refund_status` | Payment/refund state | Separate from booking lifecycle status. Current values are `pending`, `succeeded`, `failed`. |

## 4. Decision

1. This ADR does not change runtime behaviour.
2. MCP/ACP booking vocabulary is locked by a contract test so new status words
   cannot be introduced silently.
3. `confirmed` remains a known overloaded word until a follow-up decision
   decides whether host approval and payment completion should be separated.
4. `charge.dispute.created` must stay unclaimed until a schema/status contract
   exists for dispute handling.
5. Payment facts (`paid`, `disputed`, refund states) and stay operations
   (`checked_in`, `checked_out`) must not be introduced as `bookings.status`
   values without a new accepted ADR.

## 5. Follow-Up Work

1. Resolve ADR 0002 vs `api/acp.ts`: decide whether ACP synchronous completion
   may write `confirmed`, or whether only the webhook may write payment-derived
   terminal state.
2. Decide whether booking lifecycle and payment state need separate fields.
3. If disputes are implemented, prefer an explicit payment/dispute field over
   overloading `bookings.status` without a new contract.
