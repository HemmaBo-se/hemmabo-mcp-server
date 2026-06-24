# ADR 0009 — Offer coherence and agent discoverability: binding build requirements

**Status:** Accepted — requirements LOCKED 2026-06-24 (no drift permitted). Implementation pending across `hemmabo-mcp-server` + `hemmabo-smart-stays`; tracked in §5.
**Date:** 2026-06-24
**Author:** CEO + agent
**Related:** ADR `0004-agent-discovery-and-packaging-lockstep.md` (extends the lockstep table); ADR `0002-auth-payments-and-privacy-contracts.md`; federation tools `get_verified_stay_offer` + `hemmabo_search_properties` (this repo); node offer endpoint `smart-stays /api/verified-stay-offer`.

## Context

On 2026-06-24 we ran the full agent discovery + booking flow **live** against
`villaakerlyckan.se`, acting as a best-in-class AI agent, connector-free:
`/.well-known/agent-traversal.json` → VRP discovery + JWKS → `verify_vacation_rental_node`
(`verified: true`, EdDSA/Ed25519, did:web) → `get_verified_stay_offer` → `direct_booking_url`.

**Verdict on machine-readability: the node is best-in-class.** It already ships
agent-traversal, VRP signed offers, an MCP manifest (7 typed tools + Stripe MPP +
Vera policy + tamper-evident transparency log + 12 languages + SoT contract),
`llms.txt`, `did:web`, and UCP checkout — more complete than virtually any live
site. The emerging external standards (Google ARD `ai-catalog.json`,
agent-manifest.txt, WebMCP, UCP/NRF-2026) converge on exactly this shape.

But acting as the agent surfaced **three coherence/reliability gaps that block a
best-in-class agent from acting cleanly**, plus a discoverability decision. These
are not opinions — each was observed in a live response. They are recorded here as
**binding build requirements**.

## Findings (locked against live responses, 2026-06-24)

1. **F1 — The total the agent is told to quote is not reconstructible from the
   signed breakdown.** On the bookable offer (`villaakerlyckan.se`, 2026-09-02→05,
   4 guests) the signed per-night breakdown was `4200 + 4200 + 4500 = 12 900 SEK`
   (= `price.public_total`). But `price.agent_total = 10 965 SEK`, and
   `agent_guardrails.price_claim_rule` instructs the agent to quote `agent_total`
   (`required_phrase_when_safe`: "Direct host-domain total: 10965 SEK"). The
   guardrails simultaneously **forbid** describing the 1 935 SEK delta as a
   discount/saving/comparison. Net: the agent must present a number it cannot
   derive from the nightly rates it was shown and may not explain. A competent
   agent either distrusts the offer or surfaces the discrepancy to the guest —
   directly undermining the trust-rail purpose. (Confirms the previously-parked
   pricing-coherence finding, now reproduced on the *bookable* path, not only in
   theory.)

2. **F2 — Federation search returns 500 on a schema-valid query.**
   `hemmabo_search_properties` for `2026-09-02 → 2026-09-05`, region "Skåne",
   4 guests returned **HTTP 500**, while the identical call for `2026-07-15`
   returned 200. An agent that discovers via search can drop the node on a server
   error.

3. **F3 — Search and offer disagree on alternative dates.** For blocked dates,
   `hemmabo_search_properties` returned `unavailableMatches[].alternativeDates: []`,
   while `get_verified_stay_offer` for the same property returned
   `host_alternatives.next_available = 2026-09-02 → 2026-09-05`. An agent that only
   searches sees no way forward, although the node itself knows the open window.

4. **F4 — Discoverability bottleneck is citation + registry verification, not more
   `.well-known` files.** Machine-readability is complete. External evidence:
   "agents discover brands through LLM citations first, then act"; MCP registries
   (Glama/Smithery) rank on verified ownership + crisp typed tool descriptions +
   complete required fields. The `hemmabo-mcp-server` repo `Website` field also
   pointed at a raw `*.vercel.app` URL (weak signal) rather than the canonical
   `https://www.hemmabo.com`.

## Decision — binding requirements (MUST; no drift)

Each requirement has a testable acceptance criterion. "MUST" is normative.

- **R1 — Signed offers MUST be internally reconstructible.** The total an agent is
  instructed to quote (`agent_total` when present, else `public_total`) MUST equal
  the sum of signed line items: `sum(breakdown[].nightly_rate) + sum(signed
  adjustments)`. If an agent-channel total differs from the public nightly sum,
  the offer MUST carry a **signed, labeled** adjustment line (e.g.
  `breakdown[].kind = "agent_channel_adjustment"` with a negative amount) that
  accounts for the full delta. **No unexplained delta may reach the agent.** The
  underlying pricing-model question (why an agent channel differs from public, tied
  to the deferred Wallet/discount review) MUST be decided and then expressed as a
  signed line — it may not remain an implicit, unsigned gap.
  *Acceptance:* for every signed offer where `agent_total` is present and exact,
  `sum(breakdown nightly + signed adjustments) === agent_total`; enforced by a
  contract test in `smart-stays` (offer signer) and re-verified by a federation
  conformance test in `hemmabo-mcp-server`; confirmed on a live offer.

- **R2 — `hemmabo_search_properties` MUST NOT 5xx on a schema-valid query.** On a
  downstream failure it MUST degrade gracefully (200 with empty results + a
  structured `reason`), never a 500. *Acceptance:* regression test reproducing the
  2026-09-02 query returns 200; fault-injection on the downstream dependency yields
  a graceful 200, not a 5xx.

- **R3 — Search and offer MUST agree on alternative dates.** When a property is
  unavailable for the requested window, `hemmabo_search_properties`
  `unavailableMatches[].alternativeDates` MUST contain the same `next_available`
  window that `get_verified_stay_offer` `host_alternatives` returns (single source
  of truth = the node's availability). *Acceptance:* a test asserts
  `search.alternativeDates` ⊇ `offer.host_alternatives.next_available` for the same
  property + dates.

- **R4 — Repo/registry discoverability lockstep (extends ADR 0004 §2.2).** The
  `hemmabo-mcp-server` GitHub repo MUST carry: `Website = https://www.hemmabo.com`;
  the canonical agent-native `Description` (see §appendix); and `Topics` including
  `ucp`. These MUST stay in lockstep with `package.json`, `glama.json`,
  `smithery.yaml`, and `/.well-known/mcp.json`. *Acceptance:* the ADR 0004 lockstep
  audit includes these three fields.

- **R5 — Win citation + registry verification (the real discovery bottleneck).**
  We MUST (a) hold verified-owner ("Official") listings on Glama and Smithery, and
  (b) pursue Google ARD parity by publishing/aligning an `ai-catalog.json` at a
  well-known path so intent-search registries can crawl + verify the publisher.
  *Acceptance:* Glama/Smithery show verified ownership; an `ai-catalog.json`
  decision is recorded (adopt or explicitly defer with reason).

## Consequences

### Positive
- An agent that finds the node can quote the price **with confidence** — the
  number is signed, reconstructible, and explainable. This is the whole point of a
  trust rail.
- Search becomes a reliable discovery entry point (no 5xx, consistent alternatives).
- Repo/registry signals match the canonical positioning; the federation is
  discoverable where agents actually look.

### Negative / cost
- R1 forces the deferred pricing-model decision (agent_total vs public_total) to be
  made explicit and signed — it can no longer be postponed silently.
- R2/R3 require federation ↔ node availability parity work in two repos.

### Risks
- If R1 is implemented as a signed "adjustment" without resolving the pricing model
  first, the line label could imply a discount — which public-copy rules forbid.
  The label MUST be neutral and the pricing decision MUST precede the wording.

## Non-goals
- No change to the 0% host commission model; HemmaBo never becomes merchant of
  record (host = MoR, payment to host). See `0002`.
- No reintroduction of connectors, registries-as-gatekeepers, or any central
  booking authority — discovery stays connector-free.
- This ADR does not decide the *value* of the agent channel price; it requires only
  that whatever value is chosen be signed and reconstructible.

## §Appendix — canonical repo `Description` (R4)

> Agent-native direct booking for vacation rentals on the host's OWN domain. AI
> agents discover via /.well-known/agent-traversal.json + VRP, verify Ed25519-signed
> stay offers (JWKS/did:web), read live pricing & availability, and book direct —
> 0% commission, pay the host. Connector-free. Federation catalog — not an OTA.

## §5 — Implementation tracking

| Req | Repo(s) | Surface |
|-----|---------|---------|
| R1 | `smart-stays` (signer) + `hemmabo-mcp-server` (conformance) | `/api/verified-stay-offer` payload breakdown; `get_verified_stay_offer` validation |
| R2 | `hemmabo-mcp-server` | `hemmabo_search_properties` error handling |
| R3 | `hemmabo-mcp-server` + `smart-stays` | search `alternativeDates` ← node `host_alternatives` |
| R4 | `hemmabo-mcp-server` | GitHub repo About; `package.json`; `glama.json`; `smithery.yaml`; `/.well-known/mcp.json` |
| R5 | `hemmabo-mcp-server` (registries) + node (`ai-catalog.json`) | Glama/Smithery verified ownership; Google ARD parity |
