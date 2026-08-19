# ADR 0016: Availability gate before price lock and quote

- Status: Accepted (CEO decision "A", 2026-08-19)
- Date: 2026-08-19

## Context

`hemmabo_booking_negotiate` locked a price (15-minute quote snapshot) and
`hemmabo_booking_quote` priced a stay without any availability check. An
agent could lock or quote a window the node's booking engine refuses,
present it to the guest, and only fail at checkout. No double-booking risk
existed — the checkout/create paths re-check availability under a booking
lock — but the tools handed agents a bookability promise that could be
unkeepable, breaking the no-wall doctrine (an agent must never be led into
a dead end).

Separately, the tool NAME "negotiate" invites price-bargaining behavior
that the one-honest-price doctrine forbids (`must_not_invent_discounts`).
The tool has never negotiated — it locks the host's fixed price.

## Decision (CEO option A)

1. **Keep the tool.** Its substance — a price guarantee on ONE node's own
   fixed price, paid direct to host — crosses no OTA line (no ranking,
   comparing, or cut across hosts).
2. **Gate on availability.** Both `hemmabo_booking_negotiate` and
   `hemmabo_booking_quote` run `checkAvailability` (buffer-aware since
   ADR 0015 / PR #349) before pricing. Unavailable ⇒ no quote snapshot is
   written; the answer is `Not available` plus alternative bookable
   windows (min-nights-respecting, per ADR 0015).
3. **Sharpen the description**, not the name: the description now states
   explicitly that the tool never negotiates or discounts — it only locks
   the host's fixed price, and refuses undeliverable dates.
4. **Renaming is deferred**, not rejected: `hemmabo_booking_price_lock`
   would be the honest name, but a rename is a breaking change on a
   published surface (13-tool catalog pinned in federation manifests,
   registries, npm consumers, and an in-flight ChatGPT connector review).
   Revisit as part of the next coordinated surface revision AFTER the
   ChatGPT verdict — never mid-review.

## Consequences

- A locked or quoted window is bookable by construction at lock time.
  (The checkout re-check under lock remains the race authority.)
- One extra availability check (+ gap-scan on the unavailable path) per
  negotiate/quote call — bounded, and only on booking-intent calls.
- Guarded by `src/negotiate-availability-gate.contract.test.ts`.
