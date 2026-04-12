# Federation MCP Server

[![Smithery Badge](https://smithery.ai/badge/federation-mcp-server)](https://smithery.ai/server/federation-mcp-server)

MCP server for vacation rental direct bookings. Search properties, check availability, get real-time pricing quotes, and create bookings through the federation protocol.

Supports seasonal pricing, guest-count tiers (staircase model), weekly/biweekly package discounts, gap-night discounts, and host-controlled federation discounts.

## Install via Smithery

```bash
npx -y @smithery/cli install federation-mcp-server --client claude
```

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `search_properties` | Search vacation rentals by location, dates, and guest count. Returns available properties with live pricing (public + federation rates). | Yes |
| `check_availability` | Check if a property is available for specific dates. Verifies blocked dates, bookings, and booking locks. | Yes |
| `get_canonical_quote` | Get detailed pricing: publicTotal (website rate), federationTotal (direct booking rate), gapTotal (gap-night discount). Per-night breakdown included. | Yes |
| `create_booking` | Create a direct booking at federation price. Validates availability, calculates price, creates pending booking for host approval. | No |

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
```

## Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/mcp` | GET | Transport info |
| `/health` | GET | Health check |
| `/.well-known/mcp.json` | GET | MCP discovery metadata |
| `/.well-known/mcp/server-card.json` | GET | Smithery server card |

## Transport

Streamable HTTP (`POST /mcp`) — required for Smithery Gateway and remote MCP clients. Stateless (no session management needed).

## License

MIT
