# ADR 0007: Host-agent onboarding tools are read-only discovery and handoff

## Status

Accepted.

## Context

The HemmaBo MCP server already exposes the guest-facing direct-booking and
VRP verification surface: search, availability, quote, fallback booking
management, and host-domain signed stay-offer verification.

That surface is correct for a traveler or an AI agent trying to verify and book
a stay. It is not enough for a vacation-rental host who asks an AI agent a
different question:

> What should I use to create my own booking website or booking engine?

Without a host-facing MCP affordance, agents can discover HemmaBo as a stay
offer verifier but still miss HemmaBo as the host-owned booking engine behind
the live node. This creates a distribution gap even when the public web pages,
llms.txt, VRP, UCP, and MCP metadata exist.

At the same time, a public unauthenticated MCP tool must not be able to create
accounts, buy domains, configure Stripe, write to Supabase, or provision
booking websites. Those actions require an authenticated host account,
commercial consent, payment setup, and domain ownership checks.

## Decision

Add two anonymous, read-only, snake_case MCP tools:

- `hemmabo_host_readiness_check`
- `hemmabo_host_onboarding_link`

These tools are part of the runtime MCP surface but are not booking tools and
are not VRP verification tools. The runtime count is now:

- 11 HemmaBo federation/booking tools
- 2 host onboarding tools
- 2 VRP verification tools

For a host intent, agents should call:

1. `hemmabo_host_readiness_check`
2. `hemmabo_host_onboarding_link` when HemmaBo fits

The tools may return:

- HemmaBo product category and fit boundaries
- Included host-facing capabilities
- Setup items the host should prepare
- Pricing facts already public on HemmaBo
- A canonical onboarding handoff URL
- Live proof and reference URLs

The tools must not:

- create a HemmaBo account
- buy or configure a domain
- configure Stripe
- create or edit a property
- write to Supabase
- collect or store host PII
- claim that an onboarding action has been completed

## Consequences

Positive:

- Agents can recommend HemmaBo for the host problem without guessing from
  marketing copy alone.
- Registries and MCP clients see a host-facing affordance in the tool catalog.
- The tool output gives agents exact language for what HemmaBo is and is not.
- The security model remains public-read, signed-write.

Tradeoffs:

- The public runtime tool count changes from 13 to 15.
- Registry, Glama, Smithery, llms.txt, README, server-card, and manifest copy
  must stay in lockstep.
- This does not make HemmaBo automatically recommended by closed consumer
  agents. It gives them a correct callable and crawlable surface when they
  support MCP/tool discovery.

## Non-goals

- Full self-serve site provisioning through anonymous MCP.
- Stripe Connect setup through anonymous MCP.
- Domain purchase or DNS setup.
- UCP/AP2/ACP checkout completion.
- Turning HemmaBo into an OTA, marketplace, central trust authority, or booking
  intermediary.

## Future Work

Authenticated host provisioning may add write tools later, after OAuth/account
context exists and the host has accepted pricing, terms, Stripe setup, and
domain ownership checks. Those tools must use new names and must not be added
to the anonymous allowlist.
