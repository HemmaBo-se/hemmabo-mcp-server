# ADR 0011 — VRP key lifecycle: rotation, revocation, and historical receipt verifiability

**Status:** Accepted — decisions LOCKED 2026-06-24. Spec/implementation gated to **before Phase 5** (dispute/insurance positioning); discharges ADR 0010 §3 and §8.
**Date:** 2026-06-24
**Author:** CEO + agent
**Related:** ADR `0010-vrp-receipt-envelope-attestations.md` (§3 key blast radius; D3 tlog; D4 status); ADR `0008-ap2-mandate-conformance.md` (offer key == AP2 merchant key); code `lib/vrp.ts` (`verifyCompactJws` `kid` matching, JWKS at `/.well-known/jwks.json`), `lib/vrp-receipt.ts` (per-attestation `kid` surfaced in results).

## 1. Context

ADR 0010 §3 flagged a key-lifecycle gap as a **hard risk** and deferred the decision
to "before Phase 5." Two facts make it load-bearing:

1. **Shared key, doubled blast radius (ADR 0008).** The node signs VRP offers and acts
   as the AP2 *merchant* with the **same `did:web` Ed25519 key**. One compromise breaks
   **both** the `offer` and `payment` layers at once.
2. **Receipts are meant to outlive the key.** A VRP receipt is positioned as a dispute /
   insurance evidence record (ADR 0010 Phase 5). That only holds if a receipt signed at
   time *T* still verifies **years later**, including across routine key rotation — and
   if a *compromised* key does **not** retroactively validate forgeries.

The live verifier today is signature + freshness only: `verifyCompactJws` matches by
`kid` against the JWKS fetched at verification time (`lib/vrp.ts`), and
`lib/vrp-receipt.ts` surfaces the verifying `kid` per attestation. There is **no**
retired-key retention policy and **no** revocation concept. This ADR decides both,
without yet changing the v1 verifier.

## 2. Decision (normative; MUST)

### K1 — Every signature is key-identified; receipts pin the `kid`

Every attestation signature MUST carry a JWS `kid`, and a receipt records the verifying
`kid` per attestation (already surfaced by `lib/vrp-receipt.ts`). `kid` values MUST be
unique-per-key and SHOULD be non-reused, time-stamped strings (the live convention,
e.g. `villaakerlyckan.se-2026-05-18-01`).

### K2 — JWKS retains RETIRED public keys for the receipt-retention horizon

The published JWKS (`/.well-known/jwks.json`) MUST continue to serve a key's **public**
half after it stops signing, for at least the **receipt-retention horizon** (the longest
period a receipt must remain independently verifiable — set by the dispute/insurance
SLA, not by the offer `valid_until`). Each JWKS key entry MUST carry lifecycle metadata:

- `kid`
- `vrp_key_status`: `active` (currently signing) · `retired` (rotated out, still trusted
  for signatures it made while active) · `revoked` (compromised; see K4)
- `vrp_not_before` / `vrp_not_after`: the window during which this key was a legitimate
  signer.

A verifier doing **historical** verification resolves the `kid` against this retained
set; it MUST NOT treat "key no longer active" as a failure for a receipt signed inside
that key's `vrp_not_before`/`vrp_not_after` window.

### K3 — Rotation is overlapping and non-destructive

Rotation MUST be additive: publish the new `active` key, begin signing with its new
`kid`, and move the prior key to `retired` (keep its public half per K2). Rotation alone
does **not** invalidate receipts signed by the now-retired key. There MUST be an overlap
window where both keys are resolvable so in-flight receipts never hit a gap.

### K4 — Revocation is distinct from rotation and is time-anchored

`revoked` ≠ `retired`. Revocation means the private key is believed **compromised**. A
revocation MUST publish a `vrp_compromised_at` instant. The verification rule:

- A receipt whose signature can be proven to predate `vrp_compromised_at` MAY still be
  treated as authentic.
- A receipt that **cannot** be proven to predate `vrp_compromised_at` MUST be treated as
  `invalid` for that layer (fail-closed).

"Proven to predate" requires an **independent time anchor** — it cannot rely on the
self-asserted `served_at`/`valid_from` inside the (possibly forged) signature. This is
exactly the role of the optional transparency-log inclusion proof (ADR 0010 D3): a
`tlog` proof anchors a receipt's existence at a log time. **Therefore: any receipt
intended to survive a future key revocation (i.e. Phase-5 dispute/insurance receipts)
MUST carry a `tlog` inclusion proof.** Without one, a revoked-key receipt fails closed.

### K5 — Per-layer key separation is permitted (mitigate the shared-key blast radius)

To bound the ADR 0008 shared-key risk, the node MAY sign the `payment`/merchant layer
with a **distinct `kid` (or distinct key)** from the `offer` layer. The receipt model
already supports this — each attestation resolves its own key via its `source` + `kid`,
and `verifyReceipt` verifies each layer independently. Sharing one key remains the simple
default; this decision only forbids the **schema/verifier from assuming** a single key,
so a future split (or a compromise isolated to one layer) needs no envelope change.

### K6 — New error codes (extend the ADR 0010 D4 registry)

Add to the normative registry, used only by a lifecycle-aware (Phase-5) verifier:

- `key_retired_out_of_window` — `kid` resolved but the receipt's signing time is outside
  the key's `vrp_not_before`/`vrp_not_after`.
- `key_revoked` — `kid` is `revoked` and the receipt cannot be proven to predate
  `vrp_compromised_at`.
- `tlog_required` — a revocation is in effect for the `kid` and the receipt carries no
  `tlog` proof to establish ordering.

The v1 codes (`key_unresolvable`, `sig_invalid`, `sig_expired`, …) are unchanged.

## 3. Scope and sequencing (no v1 verifier change yet)

- The **current** verifier (`lib/vrp.ts` + `lib/vrp-receipt.ts`) stays signature +
  freshness only. K1/K5 are already satisfied by the existing `kid` handling and
  per-attestation resolution; **K2/K3/K4/K6 are forward spec** and MUST be implemented
  **before** Phase 5 (when receipts are marketed as dispute/insurance evidence), not
  before Phase 1–4.
- Until then, public framing MUST NOT claim long-term / post-revocation verifiability.

## 4. Consequences

### Positive
- Receipts can outlive routine rotation (K2/K3) — the precondition for dispute/insurance.
- Compromise is contained: time-anchored revocation (K4) + optional per-layer keys (K5)
  stop one leaked key from silently validating forgeries or nuking the other layer.
- Makes the business case for `tlog` concrete: it is what makes revocation survivable.

### Negative / cost
- JWKS retention + lifecycle metadata is new node (`smart-stays`) work.
- Phase-5 verification becomes stateful (resolve retired keys, honor `vrp_compromised_at`,
  require `tlog`) — materially more than v1 signature+freshness.

### Risks
- If `tlog` anchoring is not in place before Phase 5, revoked-key receipts fail closed —
  correct, but it removes the evidence value precisely when it is needed. So `tlog`
  emission (node side) is on the Phase-5 critical path.

## 5. Non-goals
- No change to the v1 envelope schema or the current verifier in this ADR (forward spec).
- No mandate that every receipt carry `tlog` (D3 keeps it optional); only Phase-5
  dispute/insurance receipts intended to survive revocation MUST.
- No change to the 0% commission / host = merchant-of-record model (ADR 0002).
- Choice of transparency-log implementation/operator is out of scope here.

## 6. Acceptance for closing this ADR

- [ ] JWKS serves `retired` keys with `vrp_key_status` + `vrp_not_before`/`vrp_not_after`
      for the agreed receipt-retention horizon (node `smart-stays`).
- [ ] Rotation runbook implements the K3 overlap window.
- [ ] A lifecycle-aware verifier path implements K2/K4/K6 (gated to before Phase 5).
- [ ] Phase-5 receipts carry a `tlog` inclusion proof (K4).
- [ ] Decision recorded on whether the `payment` layer uses a separate key (K5).
