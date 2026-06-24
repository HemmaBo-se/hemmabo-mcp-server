# ADR 0010 — VRP receipt envelope: flat `attestations[]` as the v1 core

**Status:** Accepted — v1 scope LOCKED 2026-06-24; spec authoring + reference implementation pending (tracked in §7).
**Date:** 2026-06-24
**Author:** CEO + agent
**Related:** ADR `0008-ap2-mandate-conformance.md` (AP2 verification status); ADR `0002-auth-payments-and-privacy-contracts.md` (MoR / payment boundary); ADR `0009-offer-coherence-and-agent-discoverability.md` (offer reconstructibility); code `lib/vrp.ts` (`verifyCompactJws`, `stableStringify`), `lib/ap2.ts` (mandate verification + reason codes), `api/mcp.ts` (stateless MCP transport); spec home `vacationrentalprotocol.com`; IANA well-known-uris registration #93.

## 1. Context

A multi-model strategy review (Perplexity / Grok / Claude) converged on turning VRP
from "a host-domain signed stay offer" into "a verifiable booking record" — a small,
versioned **receipt envelope** that other trust/payment layers (MCP, Visa TAP, AP2)
can reference. The only real fork was **how much structure belongs in v1**: Grok
argued for recursive Merkle-forest receipts + selective disclosure now; Perplexity
argued for a minimal flat receipt with extension points; Claude sided with Perplexity
and pulled in three cheap verifiability wins.

Before locking scope we audited the **live code** against the pitch. The gap matters,
because a credible standard is judged on what its reference implementation actually
does, not on its positioning:

- **There is no `attestations[]` envelope today.** `get_verified_stay_offer`
  verifies a **single** Ed25519 compact JWS (`verifyCompactJws`, `lib/vrp.ts`) and
  returns a flat agent view. A repo-wide search for `attestation|receipt|tlog|
  inclusion_proof` returns **zero hits in runtime code** — only in ops/evidence docs.
  **Conclusion: the envelope is new design, not "just formalizing" an existing object.**
- **No transparency-log inclusion proof is in the verification path.** `lib/vrp.ts`
  checks signature + `valid_until` freshness + signed-payload-matches-offer. It does
  not read or verify any Merkle/tlog inclusion proof. The "tlog (tree_size 2)" claim
  is infrastructure adjacent to the offer, not a checked field of the verified result.
- **"did:web" is positioning, not the resolution path.** The verifier fetches
  `/.well-known/jwks.json` directly; it does not resolve a `did:web:…` → `did.json`
  document. The spec MUST describe the key-discovery mechanism it actually uses.
- **AP2 is "conformant parsing, live proof pending" — not enforced.** ADR 0008
  records that AP2 mandate verification had real wire-format gaps (wrong mandate type,
  units, field names); a real mandate would have been rejected. It is now parsed
  spec-precisely but a live ACP+AP2 end-to-end run is still pending. So one of the two
  external layers we want to *compose* into the envelope cannot yet be *verified*
  end-to-end.

Net: we stand on **one strong implementer of a one-layer signed offer**, not on a
multi-layer trust framework. This ADR locks a v1 scope that closes that gap honestly,
maximizes the odds of a second implementer, and reserves — without building — the
ambitious extensions.

## 2. Decision — v1 receipt envelope (normative; MUST)

### D1 — Flat `attestations[]` is the core; recursion and ZK are reserved, not built

The VRP receipt is a versioned object with a **flat array** of attestations:

```jsonc
{
  "vrp_receipt_version": "1.0",
  "subject":  { /* what the receipt is about: property, stay window, offer id */ },
  "issuer":   { /* the node identity that assembled the receipt */ },
  "attestations": [
    {
      "layer":       "offer",            // offer | transport | payment | …(open)
      "source":      "https://host.example/.well-known/jwks.json",
      "signature":   "<compact JWS>",    // the signed artifact itself
      "ref":         "offer:…",          // opaque correlator
      "valid_from":  "2026-06-24T00:00:00Z",
      "valid_until": "2026-06-25T00:00:00Z",
      "status":      "verified",         // see D4
      "tlog":        { /* optional inclusion proof; see D3 */ }
    }
  ]
}
```

- **MUST** be a flat array in v1. A new trust layer = a new array entry; **no central
  approval** to add a layer (this is what "open to compose" means concretely).
- Recursive / chained sub-receipts (an attestation pointing to another receipt) and
  BBS+ / selective-disclosure / ZK are **reserved v2 extension points**, expressed in
  v1 only as **named-but-empty** optional fields (`sub_receipt`, `disclosure`) so v2
  can add them without breaking v1. They are **not implemented in v1**.
  *Rationale:* DID/VC is the cautionary example of adoption lost to early abstraction;
  OAuth2 won on simplicity. Reserve ambition, ship simplicity.

### D2 — Per-attestation freshness is mandatory

Every attestation **MUST** carry `valid_from` / `valid_until`. This generalizes the
freshness gate that already exists for offers (`lib/vrp.ts` rejects an offer whose
`valid_until` is past) to every layer, and is what lets the receipt express
mandate/credential expiry per layer rather than as one all-or-nothing gate.

### D3 — Transparency-log inclusion proof is an OPTIONAL per-attestation field

Each attestation **MAY** carry a `tlog` inclusion proof. v1 verifiers **MUST** treat a
missing `tlog` as `status: "verified"` (signature-only) rather than a failure, and
**MUST NOT** claim log-anchored properties for an attestation that lacks one. We do not
promote tlog to a required field because it is not in the verification path today
(see §1); making it mandatory in v1 would be a spec that over-claims its own evidence.

### D4 — Normative error registry + partial verification (reuse existing codes)

A verifier **MUST** return a per-attestation `status` and, on failure, a code from a
**single normative error registry**. The registry is seeded by **unifying the error
vocabularies that already exist in code** — not by inventing new ones:

- VRP `blocked_reason` (`lib/vrp.ts`): `agent_permission_denied`, `not_available`,
  `price_not_exact`, `direct_booking_url_missing`.
- AP2 `reason` (`lib/ap2.ts`): `mandate_expired`, `mandate_missing_amount`,
  `invalid_charge_amount`, `amount_exceeds_mandate`, `currency_mismatch`,
  `merchant_mismatch`, `cart_mismatch`.
- Plus envelope-level: `sig_invalid`, `sig_expired`, `key_unresolvable`,
  `layer_unverifiable` (present but opaque), `canonicalization_mismatch`.

The verifier **MUST** support **partial verification**: it reports per-layer status
("offer + transport verified, payment layer present-but-unverifiable") rather than a
single boolean. A `status: "unverifiable"` (present, signature could not be checked —
e.g. an AP2 mandate we store but cannot yet verify per ADR 0008) is **distinct** from
`status: "verified"`. A receipt **MUST NOT** represent an unverifiable layer as verified.

### D5 — Canonicalization MUST be pinned in v1 (the silent interop killer)

The bytes that are signed and verified **MUST** have a single, normative rule. v1
**MUST** verify over the **compact-JWS bytes as received** and **MUST NOT**
re-canonicalize JSON to re-derive the signing input. Where a canonical JSON form is
unavoidable (e.g. cross-layer correlators), the spec **MUST** reference **JCS
(RFC 8785)**. The current homegrown recursive key-sort (`stableStringify` in
`lib/vrp.ts`) is adequate for one implementer but **will diverge** across two
(Unicode, number formatting, nested ordering); it is replaced as the normative rule by
"verify the JWS bytes; JCS where canonical JSON is required."

### D6 — MCP composition profile: the node signs an assertion about the interaction

MCP has no native message signing, and `api/mcp.ts` is a stateless per-request
transport. Therefore an MCP tool call **MUST NOT** be treated as a signed artifact.
The MCP composition profile defines a `layer: "transport"` attestation in which **the
node signs a statement** — e.g. *"this signed offer was served in response to MCP tool
call `get_verified_stay_offer` with parameters P at time T"*. The attestation's subject
is the **node's assertion about the interaction**, not the (unsigned) tool call itself.

### D7 — Licensing: CC0 spec text, Apache-2.0 code with explicit patent grant

The specification text **MUST** be released **CC0**; the reference implementation and
test vectors **MUST** be **Apache-2.0 with an explicit royalty-free patent grant**.
Without a patent grant, large payment networks (Visa/Mastercard) cannot adopt it. This
is the cheapest neutrality lock and is done **first**, before schema authoring.

### D8 — Neutrality discipline in spec language

The spec, schema, and conformance suite **MUST** read vendor-neutral. HemmaBo is "the
reference implementation," not the authority. Founder attribution is fine; governance,
error registry, and composition profiles **MUST NOT** route through a HemmaBo product
manifest. `vacationrentalprotocol.com` hosts the spec but is not a gatekeeper.

### D9 — Honest public framing (charter)

Public copy **MUST** describe what the reference implementation actually does:
"JWKS-over-`.well-known` Ed25519 signed offer + receipt envelope," **not** "multi-layer
trust layer," until ≥2 layers verify end-to-end against a second implementer.
"AP2 composition" is described as **read-only capture** (`status: "unverifiable"`)
until ADR 0008's live AP2 proof lands. Reuse the ADR 0008 honesty rule as policy.

## 3. Key lifecycle (the single-key blast-radius decision)

ADR 0008 binds the AP2 merchant identity to the **same** `did:web` Ed25519 key VRP uses
for offers. This is elegant (one moat key) but means **one key compromise breaks both
the offer layer and the payment-merchant layer at once**. v1 therefore **MUST**:

- Pin the verifying `kid` inside each attestation (the JWS `kid` is already matched in
  `lib/vrp.ts`), so historical receipts remain verifiable across key rotation.
- Define a rotation + revocation story for **historical** receipt verifiability before
  the receipt is marketed as dispute/insurance evidence (a rotated/revoked key must not
  silently invalidate already-issued, still-valid receipts).
- This work is **required before Phase 5**, not before Phase 1.

## 4. Phases (delivery order)

- **Phase 0 — live today:** single Ed25519 JWS signed offer, `.well-known` discovery +
  JWKS, freshness + payload-match verification, MCP server. (Done.)
- **Phase 1 — the envelope (this ADR):** author the versioned `attestations[]` receipt
  schema (D1–D5) on `vacationrentalprotocol.com`.
- **Phase 2 — reference implementation (layers we own):** node emits a receipt
  embedding the offer JWS + the MCP `transport` assertion (D6); runnable proof point.
- **Phase 3 — compose external signatures (read-only):** capture a Visa TAP / AP2
  mandate into the envelope as `status: "unverifiable"` until verifiable (ADR 0008).
  Fintech-lawyer review enters **here** (live mandates), not at Phase 1–2.
- **Phase 4 — open verifier + test vectors:** anyone can verify a receipt against the
  key source + `attestations[]`; ship **negative** vectors and the D4 error registry.
  Registry-optional, no gatekeeper.
- **Phase 5 — dispute / insurance:** expose the receipt as the evidence record;
  requires the §3 key lifecycle.

## 5. Consequences

### Positive
- A second implementer reads a spec whose normative rules (error codes,
  canonicalization, freshness) **match the reference code** — the fastest path to "yes."
- Composition is genuinely open: new layer = new array entry, no central approval.
- Partial verification (D4) makes the receipt useful for dispute ("payment layer
  missing") instead of an opaque true/false.
- CC0 + patent grant (D7) removes the blocker for payment-network adoption up front.

### Negative / cost
- Phase 1 is real new design (no envelope exists), not documentation of an existing
  object — scoped honestly here so it is not under-estimated.
- D9 forces public copy to track implementation reality (no "trust layer" until 2
  layers verify on a 2nd implementer).

### Risks
- **Pitch-vs-code gap (high):** a skeptical implementer #2 sees a one-layer, one-key
  signed-offer verifier. Mitigation: D9 honesty + D1 open envelope; market only what
  runs.
- **Single-key blast radius (high):** §3 must land before Phase 5.
- **Canonicalization drift (high if unaddressed):** D5 pins it in v1.
- **AP2 not yet verifiable (medium):** D4 `unverifiable` status + D9 framing prevent
  over-claiming; ADR 0008 tracks the fix.
- **Neutrality signal (medium):** D7/D8 mitigate; spec must not route through HemmaBo
  product surfaces.

## 6. Non-goals
- No recursive/chained receipts, BBS+, selective disclosure, or ZK in v1 (reserved v2).
- No change to the 0% host-commission / host = merchant-of-record model (ADR 0002);
  embedding a TAP/AP2 reference does not make the node a payment service provider.
- No central registry-as-gatekeeper; composition profiles are published, not approved.
- This ADR does not author the JSON Schema or write code — it locks the v1 scope and
  the normative rules the schema/code MUST follow.

## 7. Positioning target (calibrated)

Aim for **Level 2** — *the verifiable booking record that payment/trust layers
reference in Europe* — and keep `subject` generic enough that a Level-3 ("generic
verifiable event receipt") future is not foreclosed, but **never market beyond Level
2** until ≥2 layers verify end-to-end on a second implementer. Level 1 (5–10 Nordic/EU
adopters) is the near-term bar gating any IETF/W3C effort.

## 8. Acceptance for closing this ADR

ADR may be marked **fully delivered** when:

- [ ] D7 done: spec repo carries CC0 (spec) + Apache-2.0 + patent grant (code/vectors).
- [ ] Phase 1: versioned `attestations[]` schema published with D1–D5 normative rules.
- [ ] Phase 2: node emits a receipt embedding the offer JWS + MCP transport assertion
      (D6), verified live.
- [ ] Phase 4: open verifier + positive **and** negative test vectors using the D4
      error registry.
- [ ] §3 key-lifecycle (rotation/revocation for historical receipts) decided before any
      Phase 5 dispute/insurance positioning.
- [ ] A documented commitment from **implementer #2** to emit/verify VRP receipts.
