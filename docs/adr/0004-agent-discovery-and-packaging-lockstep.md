# ADR 0004 - Agent Discovery and Packaging Lockstep

- **Status:** Proposed
- **Date:** 2026-05-18
- **Deciders:** HemmaBo core
- **Verified against:** `origin/main` @ `c1ce342` (commit "fix: summarize signed VRP agent direct total (#100)")
- **Companions:** [ADR 0001](./0001-single-source-of-truth-and-tool-naming.md), [ADR 0002](./0002-auth-payments-and-privacy-contracts.md), [ADR 0003](./0003-oauth-authorization-code-and-dcr.md)
- **Scope:** Public agent-discovery, public packaging, catalog metadata, ChatGPT Apps submission, and VRP standard positioning for `hemmabo-mcp-server` plus companion public surfaces.

---

## 1. Context

HemmaBo now has 13 MCP tools in the live runtime:

1. `hemmabo_search_properties`
2. `hemmabo_search_availability`
3. `hemmabo_search_similar`
4. `hemmabo_compare_properties`
5. `hemmabo_booking_quote`
6. `hemmabo_booking_create`
7. `hemmabo_booking_negotiate`
8. `hemmabo_booking_checkout`
9. `hemmabo_booking_cancel`
10. `hemmabo_booking_status`
11. `hemmabo_booking_reschedule`
12. `verify_vacation_rental_node`
13. `get_verified_stay_offer`

The last two tools introduce the Vacation Rental Protocol (VRP) proof path:

```text
villaakerlyckan.se
-> /.well-known/vacation-rental.json
-> /.well-known/jwks.json
-> verify_vacation_rental_node
-> get_verified_stay_offer
-> signed verified_stay_offer
-> direct booking URL
```

The live runtime and the strongest product strategy now say:

```text
HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.
```

However, public discovery surfaces are not guaranteed to say the same thing. Some surfaces were written before VRP existed, before the two VRP tools shipped, or before the ChatGPT Apps submission matured. This creates an agent-discovery failure: even if runtime behaviour is correct, agents and registries may learn stale or conflicting descriptions.

This is more serious than a documentation bug. Agent clients choose tools through metadata, descriptions, prompts, registry listings, manifests, and public pages. If those surfaces disagree, HemmaBo leaks trust and discoverability before a guest ever reaches a tool call.

## 2. Decision

We adopt an **Agent Discovery and Packaging Lockstep** contract.

No new non-critical feature work should be prioritised ahead of making the public HemmaBo/VRP discovery surface consistent, unless the work fixes a production incident, security issue, payment issue, or double-booking risk.

### 2.1 Three-layer positioning doctrine

Every public discovery surface must use the same three-layer model.

#### HemmaBo

Canonical positioning:

```text
HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer.
```

Role:

```text
HemmaBo = provider/federation/app
```

Meaning:

- HemmaBo is not an OTA.
- HemmaBo is not a marketplace.
- HemmaBo is not merely a website builder.
- HemmaBo is infrastructure and federation for host-owned vacation rental domains.
- HemmaBo can provide hosted implementation, booking, payments, calendar, pricing, and MCP access.

#### Vacation Rental Protocol (VRP)

Canonical positioning:

```text
Vacation Rental Protocol is an open protocol for host-domain signed vacation rental offers.
```

Role:

```text
VRP = standard
```

Meaning:

- VRP is neutral and implementable by others.
- VRP defines how an AI agent verifies host-domain discovery, JWKS, signatures, freshness, direct booking URL, and citation permission.
- VRP must not be described as HemmaBo-only.
- VRP v0.1 is not an OTA, marketplace, central registry, public traffic proxy, or central key issuer.

#### Villa Akerlyckan

Canonical positioning:

```text
Villa Akerlyckan is the reference proof node: villaakerlyckan.se -> discovery -> JWKS -> signed stay offer -> direct booking.
```

Role:

```text
Villa Akerlyckan = proof node
```

Meaning:

- Villa Akerlyckan is the live reference implementation for host-domain signed stay offers.
- It proves that a real host-owned domain can publish a verifiable, AI-agent-readable, bookable offer.
- It must not be framed as the whole product or the whole protocol.

### 2.2 Public-surface lockstep invariant

The following surfaces must stay consistent with the doctrine above:

| Surface | Repo / owner | Required state |
|---|---|---|
| `README.md` | `hemmabo-mcp-server` | Mentions HemmaBo + VRP, 13 tools, host-domain signed verified stay offers. |
| `package.json` | `hemmabo-mcp-server` | NPM description and keywords include VRP, verified stay offer, host-domain signature, and 13 tools when possible. |
| `glama.json` | `hemmabo-mcp-server` | Lists all 13 tools, including both VRP tools. |
| `smithery.yaml` | `hemmabo-mcp-server` | Uses canonical positioning and 13-tool count. |
| `/.well-known/mcp.json` | live MCP server | Uses canonical positioning and lists all 13 tools. |
| `/.well-known/mcp/server-card.json` | live MCP server | Uses canonical positioning, 13 tools, and correct prompts. |
| `submission/chatgpt-app-submission.json` | `hemmabo-mcp-server` | Includes the two VRP tools and updated positive/negative test prompts. |
| `llms.txt` | `hemmabo.com` / public web | Uses the three-layer doctrine and references VRP neutrally. |
| Custom GPT description | ChatGPT GPT editor | Uses the three-layer doctrine and does not overclaim. |
| `vacationrentalprotocol.com` | VRP standard site | Teaches neutral host-domain verification, not HemmaBo marketing. |
| Villa Akerlyckan proof page | `villaakerlyckan.se` / host node | Shows the live proof path and safe agent wording. |

If any of these surfaces changes the tool count, VRP wording, proof path, or HemmaBo positioning, all affected surfaces must be reviewed in the same PR or operational task.

### 2.3 Canonical trigger doctrine

Agent-discovery copy must make clear when HemmaBo should and should not be selected.

#### Should trigger HemmaBo

Use HemmaBo when the user asks for direct host-domain booking, HemmaBo properties, or official direct offers:

```text
Book Villa Akerlyckan
Verify villaakerlyckan.se
Get official direct price from this property domain
Can I book this vacation rental directly?
Find direct-bookable HemmaBo properties in Skane
Is this host-domain offer verified?
Get a signed stay offer
```

#### Should trigger VRP

Use VRP verification when the user asks whether a vacation rental domain is a verified node or whether an offer is official:

```text
Does this vacation rental domain have a verified node?
Check /.well-known/vacation-rental.json
Verify signed stay offer
Is this the official host-domain offer?
```

#### Should not trigger HemmaBo

Do not trigger HemmaBo for unrelated travel verticals, broad OTA search, or generic inspiration:

```text
Find me a Hilton hotel
Book a flight
Find all hotels in Paris
Compare Expedia packages
General travel tips
```

This avoids tool spam and keeps HemmaBo's app-discovery profile honest.

### 2.4 Safe agent wording

Agents may cite a verified offer only when the returned guardrails say it is safe to quote.

Canonical safe phrase:

```text
I found the official host-domain verified offer for this stay. AI/direct booking total: <amount> <currency>.
```

Rules:

- Do not claim an OTA price comparison without signed or otherwise authorised OTA price data.
- Do not say "world first" as a legal absolute.
- Use the cautious first-mover wording from the VRP evidence memo when needed:

```text
To our knowledge, Vacation Rental Protocol is the first open protocol focused on host-domain signed, AI-agent-readable vacation rental stay offers.
```

### 2.5 Open standard boundary

`vacationrentalprotocol.com` must be built and written as a neutral protocol site.

Minimum content:

1. What VRP is.
2. What VRP is not.
3. Host-domain proof path.
4. `/.well-known/vacation-rental.json` example.
5. `/.well-known/jwks.json` example.
6. `verified_stay_offer` example.
7. Signature verification rules.
8. Freshness and `valid_until` rules.
9. Citation permission rules.
10. Reference proof: `villaakerlyckan.se`.
11. Implementation guide for non-HemmaBo nodes.
12. Link to HemmaBo as one provider/federation implementation, not the owner of the standard.

This site is required for the standard strategy. Without it, "VRP" risks looking like only HemmaBo product copy.

### 2.6 Directory and submission discipline

Every registry or app surface is treated as a distribution channel, not as afterthought documentation.

Required channels:

- NPM
- GitHub README
- Glama
- Smithery
- MCP.so or equivalent MCP directories where HemmaBo is already indexed
- ChatGPT Apps submission
- Custom GPT
- `hemmabo.com` / `llms.txt`
- `vacationrentalprotocol.com`
- `villaakerlyckan.se` proof page

The ChatGPT Apps submission from before the VRP work is stale. The next OpenAI follow-up should be treated as a new review packet or a materially updated supplement, not a small typo correction.

### 2.7 Runtime non-goal

This ADR does not add endpoints, tools, schema fields, booking logic, pricing logic, payments logic, or Supabase migrations.

The immediate implementation work is metadata, documentation, submission, registry, and packaging consistency only.

## 3. Implementation plan

Each implementation item should be small enough to review independently. Runtime logic must not change unless explicitly called out in a later ADR or issue.

### Phase 1 - Inventory and stale-surface audit

Create a public-surface audit that records current state for:

- `README.md`
- `package.json`
- `glama.json`
- `smithery.yaml`
- `/.well-known/mcp.json`
- `/.well-known/mcp/server-card.json`
- `submission/chatgpt-app-submission.json`
- `AI_CITATION_STRATEGY.md`
- `llms.txt` on `hemmabo.com`
- Custom GPT description
- `vacationrentalprotocol.com`
- Villa Akerlyckan proof page
- Glama live listing
- Smithery live listing
- MCP.so live listing
- NPM live package metadata

Mark each as:

- `current`
- `stale: missing VRP`
- `stale: wrong tool count`
- `stale: old positioning`
- `stale: overclaim`
- `missing`

### Phase 2 - Canonical copy update

Update all repo-owned metadata to use:

```text
HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer.
```

and:

```text
Vacation Rental Protocol is an open protocol for host-domain signed vacation rental offers.
```

and:

```text
HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.
```

### Phase 3 - ChatGPT Apps resubmission packet

Update `submission/chatgpt-app-submission.json` so it reflects the current app:

- 13 tools.
- Both VRP tools included.
- Positive trigger prompts from Section 2.3.
- Negative trigger prompts from Section 2.3.
- Safe wording from Section 2.4.
- Current screenshots if required.
- Clear note that the previous submission is stale because VRP and two additional tools shipped after the original submission.

If the dashboard allows a fresh submission, submit a new review packet. If the app is still stuck in an old review thread, send a concise follow-up email with:

1. What changed since the original submission.
2. The new 13-tool manifest URL.
3. The VRP proof path.
4. The updated submission JSON.
5. A request to restart or replace the old review.

### Phase 4 - Registry reindex and republication

After repo-owned metadata is updated:

1. Publish or republish NPM if `package.json` changed.
2. Request/retrigger Glama indexing.
3. Request/retrigger Smithery indexing.
4. Update MCP.so or any other listed MCP directory.
5. Verify each live listing says 13 tools and VRP.
6. Save proof links/screenshots in an operations note.

### Phase 5 - VRP standard site

Build or publish `vacationrentalprotocol.com` as the neutral standard surface.

Minimum pages:

- `/` - plain-language overview.
- `/spec/v0.1` - protocol fields and verification flow.
- `/examples/villaakerlyckan` - reference proof path.
- `/implement` - how another host/provider can implement VRP.
- `/agent-guide` - when agents should use VRP and what wording is safe.

### Phase 6 - Villa Akerlyckan proof page

Add or update a proof page on `villaakerlyckan.se` explaining:

```text
villaakerlyckan.se
-> /.well-known/vacation-rental.json
-> /.well-known/jwks.json
-> verify_vacation_rental_node
-> get_verified_stay_offer
-> signed verified_stay_offer
-> direct booking URL
```

The page must show Villa Akerlyckan as a proof node, not as the whole standard.

## 4. Consequences

### Positive

- HemmaBo stops leaking trust through inconsistent public descriptions.
- Agents and registries learn one coherent model.
- VRP becomes legible as a standard rather than a product claim.
- Villa Akerlyckan becomes a clear proof node.
- Future feature work inherits a stable discovery story.

### Negative / cost

- This pauses some feature work while public surfaces are aligned.
- Some work is operational, not code: registry reindexing, OpenAI follow-up, Custom GPT copy, and external site updates.
- A single wording change may require multiple files and external surfaces to be touched.

### Risks

- Over-optimising copy for one agent platform could reduce clarity for another. Mitigation: keep wording factual and protocol-driven.
- Re-submitting to OpenAI may reset or delay review. Mitigation: treat the old submission as materially stale and provide a concise change summary.
- Calling VRP a standard before the public standard site exists weakens credibility. Mitigation: prioritise `vacationrentalprotocol.com`.

## 5. Non-goals

- Do not add a new MCP tool in this phase.
- Do not implement `find_verified_stay_opportunities` in this phase.
- Do not add OTA price comparison.
- Do not scrape Airbnb, Booking.com, Expedia, or any logged-in OTA surface.
- Do not change pricing, calendar, payments, OAuth, or booking runtime logic.
- Do not describe HemmaBo as a marketplace or OTA.
- Do not describe VRP as HemmaBo-owned.

## 6. Acceptance criteria

ADR 0004 may be marked **Accepted** when:

- [ ] Every repo-owned public surface listed in Section 2.2 says HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.
- [ ] `glama.json` lists all 13 tools, including `verify_vacation_rental_node` and `get_verified_stay_offer`.
- [ ] `submission/chatgpt-app-submission.json` includes both VRP tools.
- [ ] ChatGPT Apps positive and negative test prompts match Section 2.3.
- [ ] `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json` are verified live and list 13 tools.
- [ ] NPM, Glama, Smithery, and MCP.so live listings are checked after reindex/republication.
- [ ] `vacationrentalprotocol.com` exists and teaches neutral host-domain VRP verification.
- [ ] Villa Akerlyckan has a proof page or equivalent public proof surface.
- [ ] No runtime code, endpoint, pricing, payment, calendar, or database logic changed as part of the packaging audit unless separately approved.
- [ ] This ADR is updated to `Status: Accepted` with the acceptance date.
