# VRP Composition Profile — Payment (AP2)

**Profile version:** 1.0
**Layer:** `payment`
**Status:** Reference profile for the VRP receipt envelope v1 (see ADR `0010`, ADR `0008`).
**Reference implementation:** `lib/vrp-payment-profile.ts`; verified by `lib/vrp-receipt.ts` + `lib/ap2.ts`.

## Purpose

This profile defines how an external, payer-signed **AP2 Payment Mandate** is
captured as a `payment` attestation in a VRP receipt. It is the Phase-3 link of
ADR 0010: composing a signature the node does **not** own into the envelope.

An AP2 mandate is already an Ed25519 compact JWS, so it composes directly with
the receipt verifier — no new crypto. The payer's credentials provider (the
issuer) signs the mandate; the receipt verifier resolves the issuer's JWKS to
check it.

## The honesty model: authentic ≠ authorized (ADR 0010 D9 + ADR 0008)

Two **distinct** levels, never conflated:

| Level | Question | Where it is decided |
|-------|----------|---------------------|
| 1. **Authentic** | Is this an authentic, fresh AP2 mandate JWS? | The receipt `payment` attestation status (`verifyReceipt`). |
| 2. **Authorized** | Does the verified mandate authorize *this* charge? | `assessAp2Payment` → `lib/ap2.ts` `mandateAuthorizesCharge` (fail-closed). |

A `payment` attestation that is `verified` means **"we hold an authentic, fresh
mandate"** — it does **not** mean the charge is authorized. Authorization (amount
cap, currency, merchant, expiry, cart binding) is the separate level-2 decision.

Per ADR 0008, AP2 wire-format conformance to the published spec is "conformant
parsing, live proof pending." So:

- Public copy MUST describe this as **AP2 mandate verification / read-only
  capture**, not "AP2 enforced," until the live ACP+AP2 proof lands.
- When the issuer key cannot be resolved, the layer is captured **read-only** as
  `unverifiable` (`key_unresolvable`) — stored and logged in the envelope even
  before all links can be verified — never silently `verified`.

## As a receipt attestation

```jsonc
{
  "layer": "payment",
  "source": "https://issuer.example/.well-known/jwks.json",  // issuer (payer) keys, NOT the node's
  "signature": "<AP2 mandate compact JWS>",
  "ref": "vrp_cart_villaakerlyckan_2026-09-02",              // correlator to the offer/cart
  "valid_from": "2026-06-24T11:40:00Z",
  "valid_until": "2026-06-24T12:40:00Z"
}
```

`verifyReceipt` checks it like any layer: signature over the JWS bytes (D5),
mandatory freshness (D2), per-layer status with partial verification (D4). A
receipt with a `verified` offer + a `payment` whose issuer key is unresolvable
returns `fully_verified: false` with `offer: verified`, `payment: unverifiable` —
the honest "offer ok, payment captured but not yet verified" state.

## Level-2 authorization

```ts
assessAp2Payment(mandateJws, issuerJwks, {
  amountMinor: 6800, currency: "SEK",
  merchantDomain: "villaakerlyckan.se",
  cartId: "vrp_cart_villaakerlyckan_2026-09-02",
})
// → { signature_verified: true, charge_authorized: true|false, reason?, claims? }
```

This reuses `lib/ap2.ts` unchanged (fail-closed): expiry, amount cap, currency,
merchant host domain, and cart binding. The merchant identity binds to the host
domain — the same `did:web` moat the node uses for VRP offers (ADR 0008).

## Security considerations

- **Authentic ≠ authorized.** Never present a `verified` payment attestation as
  proof a charge is authorized; run level 2.
- **Fail-closed.** A present-but-unparseable or over-cap mandate is `not
  authorized`, never charged.
- **Read-only capture.** Unresolvable issuer key → `unverifiable`, not a failure
  and not a pass; the mandate is retained as evidence.
- **Key blast radius / rotation.** Same lifecycle requirement as ADR 0010 §3 for
  historical receipt verifiability.
- **Regulatory boundary (ADR 0002).** Embedding a mandate reference does not make
  the node a payment service provider; host = merchant of record, Stripe moves
  the money. Take fintech-legal review before enforcing live mandates.

## Relationship to ADR 0010 / 0008

Implements the **D9** read-only payment capture on the v1 envelope (D1–D5) and
makes ADR 0008's "authentic vs authorized" split explicit and testable.
