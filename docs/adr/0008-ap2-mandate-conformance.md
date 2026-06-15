# ADR 0008 — AP2 mandate conformance: verify against the canonical schema

**Status:** Proposed (analysis; implementation gated on the decision below — payment-security code, do not patch on inference)
**Date:** 2026-06-15
**Author:** CEO + agent
**Related:** ADR `0002-auth-payments-and-privacy-contracts.md`; `lib/ap2.ts`; `api/acp.ts`

## Context

We advertise AP2-compatibility (HemmaBo platform `llms.txt`: "payment
authorization delegated to AP2 mandates, verified at the ACP checkout layer").
`lib/ap2.ts` is real and wired: `api/acp.ts` `completeCheckout` calls
`verifyAp2CartMandate` before charging — Ed25519 signature verify + amount/
currency/merchant/expiry checks, fail-closed, unit-tested (`src/ap2.test.ts`).
The crypto primitive and the fail-closed logic are sound.

`lib/ap2.ts` flagged its own risk: the live AP2 spec could not be fetched at
build time, so the wire-format field names are best-guess (`MANDATE_FIELD_CANDIDATES`),
predicted to be "an isolated one-place edit". This ADR records an audit of the
code against the **now-fetchable canonical schema**
(`google-agentic-commerce/AP2`, `code/sdk/python/ap2/models/`) — and the gap is
larger than field names.

## Findings (locked against the canonical schema)

1. **Wrong mandate (conceptual).** `models/mandate.py`: `CartContents` *"is signed
   by the merchant to create a CartMandate."* The user's authorization to pay is a
   **separate, user-signed `PaymentMandate`** that references the cart.
   `lib/ap2.ts` verifies a single "CartMandate" *as if it were the payer's
   authorization* — i.e. it verifies the merchant's own document, not the guest's
   consent. To prove the guest authorized **this** charge, verify the
   `PaymentMandate`.

2. **Amount/currency (structural + units).** The total lives at the W3C
   PaymentRequest path `...details.total.amount`, a `PaymentCurrencyAmount`
   (`models/payment_request.py`) = `{ currency: str, value: float }` where
   `value` is **major units** ("The monetary value", e.g. `603.49`).
   `lib/ap2.ts` looks shallow (`amount`/`total`/`max_amount`) and `normaliseMinor`
   treats an integer as **already minor units** — so it both fails to reach the
   nested value and would mis-scale it. (Note: the repo also ships
   `sdk/generated/types/amount.py` = `{ amount: int (minor units), currency }` — a
   *second* convention; the PaymentRequest path is the W3C major-units one. Pick
   per the mandate object actually verified.)

3. **Field names.** Merchant → `merchant_name` (a display name, not a domain);
   expiry → `cart_expiry` / `intent_expiry`; cart id → `id` (this one matches).
   The code's `merchant`/`payee`/`expires_at` candidates do not match.

4. **Net effect:** a real AP2 mandate would be **rejected** — fail-closed, so
   never wrongly charged (safe), but **not interoperable**. "AP2-compatible" is
   true for the crypto primitive + fail-closed logic; it is **not** yet true for a
   real published-spec mandate.

## Decision

Implement against the canonical schema, with this design (charter-aligned):

- **Verify the `PaymentMandate`** (user-signed) as the payment authorization, and
  bind it to the **merchant-signed `CartMandate`** it references.
- **The node IS the AP2 merchant.** It signs `CartContents` with the **same
  `did:web` Ed25519 key it already uses for VRP signed offers.** Merchant binding
  therefore = verify the cart's signature against the node's `did:web` JWKS — not a
  `merchant_name` string compare. The VRP moat (did:web) *is* the AP2 merchant
  identity; the two layers share one key.
- **Amount:** extract from the PaymentRequest total (`PaymentCurrencyAmount`),
  convert major-units `value` → integer minor units (×100, rounded) for the
  Stripe/VRP comparison.
- Keep **fail-closed** throughout.

## Consequences

- This is a **multi-object implementation** (IntentMandate → CartMandate →
  PaymentMandate chain), not the "one-place rename" the code comment assumed. Do
  it deliberately against the canonical files; feed tests spec-shaped mandates.
  **No code patched in this ADR** — payment-security; the rename-on-inference path
  is explicitly rejected.
- **Honesty (charter):** until the implementation is conformant, soften the public
  claim — "AP2 mandate verification scaffolded (Ed25519, fail-closed); wire-format
  conformance to the published AP2 spec pending" — do NOT imply a real AP2 mandate
  currently passes. The smart-stays `llms.txt` line and the
  `ap2-positioning.contract.test.ts` should track this wording.
- **Upside:** the did:web merchant binding means the AP2 merchant side is
  essentially already built (the node's VRP signing key). The remaining work is
  the payer-side PaymentMandate verification + correct extraction — meaningful but
  bounded.

## References

- Canonical: `google-agentic-commerce/AP2` →
  `code/sdk/python/ap2/models/mandate.py` (CartContents/CartMandate/IntentMandate),
  `models/payment_request.py` (PaymentCurrencyAmount: `value` float, major units),
  `models/cart.py`, `sdk/generated/payment_mandate.py`,
  `sdk/generated/types/amount.py` (minor-units variant).
- Local: `lib/ap2.ts` (`MANDATE_FIELD_CANDIDATES`, `verifyAp2CartMandate`),
  `api/acp.ts` (`completeCheckout`), `src/ap2.test.ts`, ADR 0002.
