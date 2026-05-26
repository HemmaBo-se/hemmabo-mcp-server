# ADR 0005 - Booking and Payment Status Vocabulary Audit

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** HemmaBo core
- **Scope:** Audit and guard only. No runtime behaviour changes.
- **Related:** ADR 0002, ADR 0006, `hemmabo-smart-stays` ADR `2026-05-26-booking-status-vocabulary-audit.md`

## 1. Context

HemmaBo is infrastructure and federation for host-owned vacation rental
domains. HemmaBo is not an OTA, not a marketplace, and not a generic website
builder.

The host node owns the booking lifecycle record. Stripe owns payment event
facts. The host operates Stripe chargebacks in the host's Stripe Dashboard.
HemmaBo infrastructure verifies, syncs, and enforces technical state changes
through approved paths, but does not mediate or operate chargebacks.

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

- `supabase/migrations/2026-05-12-bookings-refund-status.sql` defines
  `bookings.refund_status` as a payment/refund field with values:
  `none`, `pending`, `succeeded`, `failed`.
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
| `confirmed` | Booking lifecycle, compatibility-bridged | Used by ACP sync completion and webhook payment success. ADR 0006 locks this current behavior without making HemmaBo the booking-status owner. |
| `cancelled` | Booking lifecycle | Used by ACP cancel and webhook failure/refund paths. |
| `completed` | Public MCP compatibility value | Present in MCP output schemas, not currently a write path in this repository. |
| `declined` | Host decision vocabulary in smart-stays | Not currently an MCP-server write or public MCP enum. |
| `paid` | Payment fact, not booking lifecycle | Must not be added as `bookings.status` without a decision. |
| `checked_in` | Stay operational state | Must not be added as `bookings.status` without a decision. |
| `checked_out` | Stay operational state | Must not be added as `bookings.status` without a decision. |
| `disputed` | Stripe chargeback fact, host-operated in Stripe Dashboard | Not implemented in HemmaBo. Must not be modelled as booking lifecycle status. |
| `refund_status` | Payment/refund state | Separate from booking lifecycle status. Current values are `none`, `pending`, `succeeded`, `failed`. |

## 4. Decision

1. This ADR does not change runtime behaviour.
2. MCP/ACP booking vocabulary is locked by a contract test so new status words
   cannot be introduced silently.
3. `confirmed` remains the current compatibility bridge for successful ACP
   payment completion and Stripe webhook reconciliation. ADR 0006 locks this
   behavior without changing runtime.
4. `charge.dispute.created` must stay unclaimed by HemmaBo. Hosts handle
   Stripe chargebacks in Stripe Dashboard.
5. Payment facts (`paid`, `disputed`, refund states) and stay operations
   (`checked_in`, `checked_out`) must not be introduced as `bookings.status`
   values without a new accepted ADR.
6. This repository must not introduce a HemmaBo-owned dispute workflow,
   dedicated HemmaBo chargeback table, or
   the `disputed` value on `bookings.status` as cleanup work.

## 5. Follow-Up Work

1. Decide whether booking lifecycle and payment state need separate fields.
2. If the Stripe chargeback operating model changes, write a new accepted ADR
   first. The default remains: the host operates chargebacks in Stripe
   Dashboard, not HemmaBo.
