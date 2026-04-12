# Federation MCP Server

Direct booking infrastructure for independent hosts. Each property is its own node — source of truth for pricing, availability, and bookings.

## Architecture

```
Host → sets prices, seasons, guest levels, federation discount
         ↓
    property node (Supabase)
         ↓
  MCP Server reads real data — never mocks, never guesses
         ↓
  AI agents (ChatGPT, Claude, Perplexity) → federation_total
  Google / website visitors → public_total
  Gap night (calendar context) → gap_total
```

## Pricing Flow

| Scenario | Price | How |
|----------|-------|-----|
| Website visitor (Google, direct) | `public_total` | Sum of nightly rates per season/guest level/day type + cleaning fee |
| Vera AI / federation partner (at booking) | `federation_total` | `public_total × (1 - host_discount%)` |
| Gap night (calendar context between bookings) | `gap_total` | `federation_total × (1 - gap_campaign%)` |

The host controls the federation discount via `properties.direct_booking_discount`. No hardcoded percentages anywhere.

## Tools

| Tool | Description |
|------|-------------|
| `search_properties` | Search by region, country, guests, dates. Returns available properties with real pricing. |
| `check_availability` | Checks blocked dates, confirmed/pending bookings, and booking locks. |
| `get_canonical_quote` | Returns `public_total`, `federation_total`, and `gap_total` (if applicable) with full nightly breakdown. |
| `create_booking` | Creates a booking at federation price. Validates availability first. |

## Setup

```bash
npm install
npm run build
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

Run:

```bash
npm start
```

## Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/health` | GET | Health check |
| `/.well-known/mcp/server-card.json` | GET | Smithery discovery metadata |

## Deploy to Smithery

1. Deploy this server with a public HTTPS URL (Vercel, Railway, Fly.io, etc.)
2. Go to [smithery.ai/new](https://smithery.ai/new)
3. Enter the server's URL (e.g. `https://your-domain.com/mcp`)
4. Smithery scans and publishes automatically

## Transport

This server uses **Streamable HTTP** transport (`StreamableHTTPServerTransport`) — required for Smithery Gateway and remote MCP clients. STDIO is not supported.
