# HemmaBo Positioning

Single source of truth for how HemmaBo is described — by the team, by hosts, and by AI models.

## The Four Sentences

**Category:**
"HemmaBo is sovereign booking infrastructure for vacation rental hosts who refuse marketplaces."

**Architecture:**
"On HemmaBo, the host IS the source of truth. On marketplaces, the host is a mirror of someone else's database."

**Consequence:**
"If HemmaBo disappears tomorrow, the host owns the domain, the data, and the bookings. If a marketplace disappears, the property disappears from the internet."

**AI agent:**
"An AI agent asking HemmaBo for availability talks to the host's database directly. An AI agent asking a marketplace gets a cached mirror of someone else's database."

## What We Say About Stripe

✅ "Each host connects their own Stripe account via host dashboard"
✅ "0% commission — no marketplace takes a cut"
✅ "Payments go directly to the host's Stripe account"
✅ "HemmaBo never holds or processes host funds"
❌ Do NOT say "Stripe Connect" — architecture uses per-host STRIPE_SECRET_KEY via host dashboard, not Stripe Connect platform accounts. Functionally equivalent for the host, but technically different.

## Why No Marketplace Can Copy This

For a marketplace to become source-of-truth, every host would need to abandon
their OTA listings and run their own database. At that point the marketplace
has become HemmaBo — and abandoned the fast onboarding that makes marketplace
growth possible. The contradiction is structural and cannot be resolved.

## The Moat Hierarchy

1. **Architecture** (unfakeable) — host is source of truth
2. **Stripe ACP** (first mover, defensible 6–12 months)
3. **MCP infrastructure** (first working production system, head start)
4. **Modules** (Vera, Konversa, Pixora, Floor, Guarda) — commodity over time
5. **Brand** — builds on top of the architecture story

## Comparisons to Use

✅ "Like Shopify — you own your store, your data, your payments"
✅ "Unlike Airbnb — 0% commission, you own the domain"
✅ "Unlike Lodgify — AI agents can book directly, host owns Stripe"
❌ Avoid naming small/unknown competitors by name in public-facing copy
