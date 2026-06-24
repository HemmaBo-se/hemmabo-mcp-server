# VRP receipt — public conformance vectors

Self-contained test vectors for the VRP receipt envelope v1
(`spec/vrp-receipt.v1.schema.json`, ADR `0010` Phase 4). A second implementer
can verify their own verifier against the **same bytes** without reading any
TypeScript.

## Vector format

Each `NN-*.json` file is one vector:

```jsonc
{
  "name": "...",
  "description": "...",
  "now": "2026-06-24T12:00:00Z",   // the clock to evaluate freshness against
  "jwks": { "keys": [ ... ] },      // public Ed25519 key(s) to verify signatures
  "receipt": { ... },               // the VRP receipt envelope under test
  "expected": {                     // the reference verifier's result
    "receipt_valid": true,
    "fully_verified": false,
    "errors": [],
    "attestations": [
      { "index": 0, "layer": "offer", "status": "verified", "error": null, "kid": "..." }
    ]
  }
}
```

A conforming verifier, given `receipt` + `jwks` evaluated at `now`, MUST produce
`expected` (statuses + error codes from the normative registry in ADR 0010 D4).

## Cases

| Vector | What it proves |
|--------|----------------|
| `01-offer-transport-verified` | Multi-layer happy path → `fully_verified`. |
| `02-partial-payment-unverifiable` | Partial verification (D4): offer verified, unsigned payment `unverifiable`, NOT fully verified. |
| `03-tampered-signature` | Corrupted signature → `invalid` / `sig_invalid`. |
| `04-expired-window` | Authentic signature, stale window → `expired` / `sig_expired`. |
| `05-unsupported-version` | Envelope version ≠ 1.0 → rejected. |
| `06-malformed-empty-attestations` | Empty `attestations[]` → `malformed_receipt`. |

## Running the reference verifier

```bash
# verify a self-contained vector:
npx tsx scripts/verify-receipt.ts spec/vectors/01-offer-transport-verified.json

# verify your own receipt against a JWKS file:
npx tsx scripts/verify-receipt.ts ./receipt.json ./jwks.json
```

Exit code: `0` fully verified · `2` valid but partially verified · `1` invalid.

## Regenerating

Vectors are produced deterministically (fixed non-secret test key):

```bash
npx tsx scripts/gen-receipt-vectors.ts
```

The conformance test `src/vrp-receipt-vectors.test.ts` asserts every committed
vector's `expected` matches the reference verifier (`lib/vrp-receipt.ts`).
