# LAUNCHGUIDE — com.hemmabo/federation

This file is the MCP Marketplace launch guide for the HemmaBo federation MCP server. It tells the marketplace (and users installing the server) what the server does, how to run it, and which credentials it needs.

---

## 1. Server identity

- **MCP name:** `com.hemmabo/federation`
- **npm package:** [`hemmabo-mcp-server`](https://www.npmjs.com/package/hemmabo-mcp-server)
- **Binary:** `hemmabo-mcp-server`
- **Repository:** https://github.com/HemmaBo-se/hemmabo-mcp-server
- **Website:** https://hemmabo.com
- **Live host running on it:** https://www.villaakerlyckan.se
- **License:** MIT
- **Maintainer:** HemmaBo (hello@hemmabo.com)
- **Current version:** 3.2.3
- **Scope:** **Global.** The MCP server itself declares support for 5 currencies in its `configSchema` (SEK, EUR, USD, NOK, DKK — see [api/server-card.ts](api/server-card.ts)) and is multi-region. The broader HemmaBo platform that this server fronts supports additional currencies and multi-language guest chat, but those capabilities live in separate services and are not part of this repository.

---

## 2. What this server does

HemmaBo is booking infrastructure for independent vacation rental hosts worldwide. Each host owns their own domain, their own Supabase database, and their own Stripe account. This MCP server exposes that infrastructure to AI agents (any MCP client) so an agent acting on behalf of a guest can discover properties, get binding quotes, and complete a booking end-to-end — including payment — without leaving the conversation.

The server talks **directly** to each host's own Supabase database. There is no marketplace cache in between — the host is the source of truth. Pricing is live (seasonal tiers, guest-count staircase, weekend premiums, weekly/biweekly packages, host-controlled federation discount). Availability is live (direct bookings + iCal sync from Airbnb / Booking.com / VRBO).

### Tools exposed (11)

All tools are prefixed `hemmabo_`.

| # | Tool | Purpose |
|---|---|---|
| 1 | `hemmabo_search_properties` | Discover available properties globally by region/country, guests, and dates. Returns live pricing per property. |
| 2 | `hemmabo_search_availability` | Confirm a specific property is available for dates. Returns conflict details if not. |
| 3 | `hemmabo_search_similar` | Find similar properties (same region and type) to a given property. |
| 4 | `hemmabo_compare_properties` | Side-by-side comparison of 2–10 properties on the same dates, sorted by price. |
| 5 | `hemmabo_booking_quote` | Non-binding price quote (public rate). |
| 6 | `hemmabo_booking_negotiate` | **Binding** quote with `quoteId` — federation rate, required before checkout. |
| 7 | `hemmabo_booking_checkout` | Completes the booking with payment (Stripe Checkout or Stripe ACP SharedPaymentToken). |
| 8 | `hemmabo_booking_create` | Legacy path: creates a pending booking without payment (host approves manually). |
| 9 | `hemmabo_booking_status` | Retrieves current status and details of a booking. |
| 10 | `hemmabo_booking_reschedule` | Moves an existing booking to new dates. |
| 11 | `hemmabo_booking_cancel` | Cancels a booking and triggers any applicable Stripe refund. |

**Full agent flow:** `hemmabo_search_properties` → `hemmabo_booking_negotiate` → `hemmabo_booking_checkout` → `hemmabo_booking_status` (→ optional `hemmabo_booking_reschedule` / `hemmabo_booking_cancel`).

### Stripe integration

HemmaBo has **first-class Stripe integration**, connected in two ways:

1. **Stripe Checkout** — standard hosted checkout session for classic booking flows. Used by `hemmabo_booking_checkout`.
2. **Stripe ACP (Agentic Commerce Protocol)** — implementation of Stripe's ACP spec at `/acp/checkouts` (create, retrieve, update, complete, cancel). This lets AI agents pay with a `SharedPaymentToken` without redirecting the user to a browser. See [api/acp.ts](api/acp.ts) for the full implementation.

All payments go **directly to each host's own Stripe account**. HemmaBo does not hold, route, or take a cut of host funds. No platform fees, no commission.

### Transports

- **Remote (recommended):** `https://hemmabo-mcp-server.vercel.app/mcp` (Streamable HTTP)
- **Remote ACP endpoint:** `https://hemmabo-mcp-server.vercel.app/acp/*`
- **Local (stdio):** `npx hemmabo-mcp-server`

---

## 3. Required credentials / API keys

The server needs four environment variables for self-hosted/stdio deployment. The hosted remote (`hemmabo-mcp-server.vercel.app/mcp`) is already configured and needs no credentials from the client — it is multi-tenant and routes per property.

| Variable | Where to find it | Secret? | Required? |
|---|---|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Project → Settings → API → Project URL | No | Yes |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project → Settings → API → Project API keys → `anon public` | Yes | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project → Settings → API → Project API keys → `service_role` | Yes | Yes |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys → Secret key (`sk_live_…` or `sk_test_…`) | Yes | Yes |

### Optional

| Variable | Purpose | Default |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhook signatures for booking confirmation. | unset (verification disabled) |
| `PORT` | HTTP port for Streamable HTTP transport. | `3000` |
| `NODE_ENV` | `production` or `development`. | `production` |

### What these keys are used for

- **Supabase keys** → read availability and pricing rules, write pending bookings, confirm bookings under RLS.
- **Stripe secret key** → create Checkout sessions, create ACP agentic checkout sessions, retrieve payment intents, issue refunds.
- **Stripe webhook secret** → verify that `checkout.session.completed` events actually came from Stripe before marking a booking as confirmed.

The server never stores, logs, or transmits these keys anywhere except to the Supabase and Stripe APIs themselves. Sensitive fields (guest email, phone, card tokens) are redacted in logs.

---

## 4. Installation

### Option A — Use the hosted remote (simplest)

```json
{
  "mcpServers": {
    "hemmabo": {
      "url": "https://hemmabo-mcp-server.vercel.app/mcp"
    }
  }
}
```

No credentials needed — this endpoint is multi-tenant.

### Option B — Run locally via npx (per host)

```json
{
  "mcpServers": {
    "hemmabo": {
      "command": "npx",
      "args": ["-y", "hemmabo-mcp-server"],
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_ANON_KEY": "eyJ…",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ…",
        "STRIPE_SECRET_KEY": "sk_live_…"
      }
    }
  }
}
```

### Option C — Docker

```bash
docker build -t hemmabo-mcp-server .
docker run --rm -i \
  -e SUPABASE_URL=... \
  -e SUPABASE_ANON_KEY=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e STRIPE_SECRET_KEY=... \
  hemmabo-mcp-server
```

---

## 5. Security

- All database reads go through Supabase Row Level Security — see [`supabase/rls_policies.sql`](supabase/rls_policies.sql). The `service_role` key is used only server-side for writing confirmed bookings.
- Stripe keys are used server-side only. Card data never touches HemmaBo infrastructure — Stripe Checkout / Stripe ACP handles all PCI scope.
- All payments go directly to the **host's own Stripe account**. HemmaBo does not hold or route host funds.
- Structured logs redact `stripe_token`, `spt_token`, `card_number`, `email`, `phone`, and `guest_name`.
- Input validation with Zod on every tool: dates are strictly `YYYY-MM-DD`, property IDs are UUIDs, guest counts are bounded integers.

---

## 6. Pricing

- The MCP server itself is **free and open source (MIT)**.
- HemmaBo's hosted booking infrastructure is **$39/month per host**, domain included. First 100 hosts: 1 year free.
- **0% commission. No per-booking fees. No Stripe markup.**

---

## 7. Support

- Email: hello@hemmabo.com
- Issues: https://github.com/HemmaBo-se/hemmabo-mcp-server/issues
- Website: https://hemmabo.com
