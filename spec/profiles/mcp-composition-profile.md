# VRP Composition Profile — MCP (Model Context Protocol)

**Profile version:** 1.0
**Layer:** `transport`
**Status:** Reference profile for the VRP receipt envelope v1 (see ADR `0010`).
**Reference implementation:** `lib/vrp-mcp-profile.ts`; verified by `lib/vrp-receipt.ts`.

## Purpose

This profile defines how an MCP interaction becomes a `transport` attestation in
a VRP receipt (`spec/vrp-receipt.v1.schema.json`). It is the first composition
profile because the node is already MCP-native (`api/mcp.ts`), so it is the
fastest credible proof that the envelope composes real layers.

## The core rule: sign the assertion, not the transport (ADR 0010 D6)

MCP has **no native message signing**, and the deployed MCP endpoint
(`api/mcp.ts`) is a **stateless per-request transport**. A tool call is therefore
**not** a signed artifact and MUST NOT be treated as one.

Instead, the node signs an **assertion about the interaction**:

> "This verified offer was served in response to MCP tool call `<tool>` with
> arguments `<arguments_sha256>` at `<served_at>`, by `<issuer>`."

The **subject of the attestation is the node's assertion about the interaction**,
not the (unsigned) tool call itself. The node signs the assertion with the **same
Ed25519 key it uses for VRP signed offers** (`did:web` / JWKS over `.well-known`),
so the `transport` layer and the `offer` layer share one key and one verifier
path.

## Assertion object

The signed payload (`buildMcpTransportAssertion`) is:

```jsonc
{
  "vrp_mcp_profile_version": "1.0",
  "type": "vrp.mcp.transport.1",
  "tool": "get_verified_stay_offer",
  "arguments_sha256": "<hex sha-256 of canonical arguments>",
  "served_at": "2026-06-24T11:40:00Z",
  "issuer": "villaakerlyckan.se",
  "offer_ref": "offer:villaakerlyckan.se:2026-09-02/05",   // optional: binds to the offer attestation
  "session_id": "mcp-sess-abc"                              // optional
}
```

- `arguments_sha256` is the hex SHA-256 of the **JCS-style canonical JSON** of the
  tool-call arguments (recursive key sort; array order preserved). Arguments are
  **hashed, never stored raw**, which keeps guest-identifying inputs out of the
  receipt while still letting a verifier confirm *which* call produced the offer.
- This canonicalization applies **only** to the hash input. It does **not**
  re-derive the JWS signing input — that is always the JWS bytes as received
  (ADR 0010 D5).

## As a receipt attestation

The node signs the assertion as a compact JWS (`alg: EdDSA`) and wraps it
(`mcpTransportAttestation`) as a flat `attestations[]` entry:

```jsonc
{
  "layer": "transport",
  "source": "https://villaakerlyckan.se/.well-known/jwks.json",
  "signature": "<compact JWS over the assertion>",
  "ref": "offer:villaakerlyckan.se:2026-09-02/05",
  "valid_from": "2026-06-24T11:40:00Z",
  "valid_until": "2026-06-24T12:40:00Z"
}
```

A verifier checks it with `verifyReceipt` exactly like the `offer` attestation:
signature over the JWS bytes (D5), mandatory freshness window (D2), per-layer
status with partial verification (D4). A `transport` layer that fails to verify
never silently passes — it surfaces as `unverifiable` / `invalid`, distinct from
`verified`.

## Binding the assertion to an observed call

`assertionMatchesToolCall(assertion, { tool, arguments })` lets a verifier confirm
a signature-verified transport assertion actually describes the call the agent
claims it made (same `tool`, same canonical `arguments_sha256`). Signature
validity is the receipt verifier's job; this binds the verified assertion to the
claimed interaction.

## Security considerations

- **No transport authenticity from MCP itself.** All trust comes from the node's
  signature over the assertion. An unsigned or mis-signed `transport` layer is
  `unverifiable` / `invalid`, never `verified`.
- **Replay / freshness.** `served_at` plus the attestation's mandatory
  `valid_from` / `valid_until` (D2) bound how long the assertion is acceptable.
  Verifiers reject stale or not-yet-valid windows.
- **Offer binding.** `offer_ref` ties the transport assertion to the specific
  `offer` attestation in the same receipt. v1 does not enforce cross-layer
  binding automatically (no recursion, D1); a profile-aware verifier MAY require
  `offer_ref` to match an `offer` attestation's `ref`.
- **Privacy.** Arguments are hashed, not embedded; guest-identifying inputs do
  not land in the receipt.
- **Key blast radius.** Sharing the offer key for the transport layer is
  intentional (one moat key) but means key rotation/revocation must preserve
  historical receipt verifiability (ADR 0010 §3).

## Relationship to ADR 0010

Implements **D6** (MCP composition profile) on top of the v1 envelope (**D1**
flat attestations, **D2** freshness, **D3** optional tlog, **D4** partial
verification + error registry, **D5** verify JWS bytes). This is the Phase-2 /
step-4 deliverable: the first per-layer composition profile.
