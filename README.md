# HemmaBo MCP Server

[![NPM Version](https://img.shields.io/npm/v/hemmabo-mcp-server)](https://www.npmjs.com/package/hemmabo-mcp-server)
[![Smithery Badge](https://smithery.ai/badge/@info-00wt/federation-mcp-server)](https://smithery.ai/servers/@info-00wt/federation-mcp-server)

**Booking infrastructure for vacation rentals.**

See it live: [villaåkerlyckan.se](https://villaåkerlyckan.se)

```bash
npx hemmabo-mcp-server
```

---

## What You Get

- **Own domain** — Guests book on YourProperty.com (you control branding)
- **Stripe direct payments** — Money to your bank, 0% commission
- **AI-bookable** — ChatGPT, Claude, Gemini can search and book autonomously
- **9 production tools** — Complete booking lifecycle (search, availability, pricing, booking, checkout, cancellation, rescheduling, status, modifications)
- **Real-time data** — Never cached, pulled live from Supabase

---

## For Hosts: What You Get

- **Autonomous booking node** — AI agents can discover, price, and book your property without human intervention
- **Host-controlled pricing** — seasonal rates, guest-count tiers, package discounts (weekly/biweekly), gap-night discounts, federation discounts
- **Real-time accuracy** — never cached prices, all data pulled live from your Supabase source of truth
- **Full booking lifecycle** — search → quote → book → pay (Stripe ACP) → modify → cancel
- **Zero platform lock-in** — open source (MIT), self-hostable, export your data anytime

---

## For AI Systems: Protocol Support

---

## Quick Start

### Install via NPM (recommended)

```bash
npx hemmabo-mcp-server
```

Add to your MCP client config (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "hemmabo": {
      "command": "npx",
      "args": ["hemmabo-mcp-server"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key"
      }
    }
  }
}
```

### Install via Smithery

```bash
npx -y @smithery/cli install @info-00wt/federation-mcp-server --client claude
```

---

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `search_properties` | Search vacation rentals by location, dates, and guest count. Returns available properties with live pricing (public + federation rates). | Yes |
| `check_availability` | Check if a property is available for specific dates. Verifies blocked dates, bookings, and booking locks. | Yes |
| `get_canonical_quote` | Get detailed pricing: publicTotal (website rate), federationTotal (direct booking rate), gapTotal (gap-night discount). Per-night breakdown included. | Yes |
| `create_booking` | Create a direct booking at federation price. Validates availability, calculates price, creates pending booking for host approval. | No |
| `negotiate_offer` | Create a binding price quote with quoteId. Stores immutable snapshot, expires after 15 minutes. Pass quoteId to checkout to lock the price. | Yes |
| `checkout` | Create a booking with Stripe payment. Supports MPP (payment_intent mode for programmatic payment). Optionally locks price via quoteId. | No |
| `cancel_booking` | Cancel a booking. Handles refund calculation, Stripe refund, email notifications via Supabase Edge Function. | No |
| `get_booking_status` | Get booking details, property info, and cancellation policy by reservation ID. | Yes |
| `reschedule_booking` | Reschedule to new dates. Checks availability, recalculates price, handles Stripe charge/refund for price delta. | No |

## Pricing Architecture

```
Host sets prices, seasons, guest tiers, federation discount
         ↓
    property node (Supabase — source of truth)
         ↓
  MCP Server reads live data — never cached, never estimated
         ↓
  AI agents → federation_total (direct booking discount)
  Websites → public_total (standard rate)
  Gap nights → gap_total (calendar-context discount)
```

### Price Tiers

| Scenario | Price | How |
|----------|-------|-----|
| Website / public | `publicTotal` | Sum of nightly rates per season, guest tier, and day type |
| Federation / direct booking | `federationTotal` | `publicTotal × (1 - host_discount%)` |
| Gap night (between bookings) | `gapTotal` | `federationTotal × (1 - gap_discount%)` |

Guest-count pricing uses a staircase model (e.g. 1-2 guests, 3-4, 5-6). The host controls all discount percentages — nothing is hardcoded.

## Setup

```bash
npm install
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# Optionally add STRIPE_SECRET_KEY for checkout/cancel/reschedule tools
```

**Required environment variables:**
- `SUPABASE_URL` — Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (full database access)

**Optional (enables Stripe-powered tools):**
- `STRIPE_SECRET_KEY` — Enables `checkout`, `cancel_booking`, and `reschedule_booking` tools

## Agentic Commerce Protocol (ACP)

First vacation rental with [Stripe ACP](https://docs.stripe.com/agentic-commerce/protocol) support. AI agents can complete bookings with SharedPaymentTokens — no redirect, no manual payment.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/acp/checkouts` | POST | Create checkout session |
| `/acp/checkouts/:id` | GET | Retrieve checkout state |
| `/acp/checkouts/:id` | PUT | Update (dates, guests, buyer) |
| `/acp/checkouts/:id/complete` | POST | Complete with SharedPaymentToken (spt_) or PaymentMethod (pm_) |
| `/acp/checkouts/:id/cancel` | POST | Cancel checkout + refund |

Supports Stripe SharedPaymentTokens (SPT), Klarna, Swish, and card payments. Compatible with ChatGPT Instant Checkout, Google UCP, and any ACP-compliant agent.

## MCP + ACP Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/mcp` | GET | Transport info |
| `/acp/checkouts` | POST/GET/PUT | ACP checkout lifecycle |
| `/health` | GET | Health check |
| `/.well-known/mcp.json` | GET | MCP discovery metadata |
| `/.well-known/mcp/server-card.json` | GET | Smithery server card |

## Transport

Streamable HTTP (`POST /mcp`) — required for Smithery Gateway and remote MCP clients. Stateless (no session management needed).

---

## How AI Agents Discover HemmaBo

HemmaBo is distributed across multiple channels to maximize AI discovery:

### 1. **NPM Registry** (Primary)
- **Package:** `hemmabo-mcp-server`
- **Installation:** `npx hemmabo-mcp-server`
- **Discovery:** AI agents search NPM for "vacation rental MCP", "booking MCP", "property management MCP"
- **Keywords in package.json:** `mcp`, `mcp-server`, `model-context-protocol`, `vacation-rental`, `direct-booking`, `property-management`, `pricing`, `availability`, `federation`

### 2. **MCP Registry** (Anthropic Official)
- Listed in Anthropic's official MCP registry: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- Indexed by Claude and other MCP-aware systems
- Submission: `glama.json` with comprehensive metadata

### 3. **Smithery Gateway**
- Public MCP server directory
- Badge: [![Smithery Badge](https://smithery.ai/badge/@info-00wt/federation-mcp-server)](https://smithery.ai/servers/@info-00wt/federation-mcp-server)
- Install command: `npx -y @smithery/cli install @info-00wt/federation-mcp-server --client claude`

### 4. **GitHub Repository**
- **Repo:** [HemmaBo-se/hemmabo-mcp-server](https://github.com/HemmaBo-se/hemmabo-mcp-server)
- README optimized for AI parsing with structured metadata
- Comprehensive tool descriptions in code comments (AI agents read source during research)

### 5. **Web Discovery Endpoints**
- `https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json` — MCP capabilities manifest
- `https://hemmabo-mcp-server.vercel.app/.well-known/mcp/server-card.json` — Smithery metadata
- `https://hemmabo-mcp-server.vercel.app/health` — Status endpoint

---

## License

MIT
