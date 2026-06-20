# HemmaBo MCP Server

[![npm version](https://img.shields.io/npm/v/hemmabo-mcp-server)](https://www.npmjs.com/package/hemmabo-mcp-server) [![smithery badge](https://smithery.ai/badge/info-00wt/hemmabo-mcp-server)](https://smithery.ai/servers/info-00wt/hemmabo-mcp-server) [![license: MIT](https://img.shields.io/npm/l/hemmabo-mcp-server)](LICENSE)

> **The only MCP server where the stay offer is cryptographically signed by the host's *own* domain (VRP · Ed25519/JWKS) — no OTA, no marketplace, no central gatekeeper, no booking commission.** A platform makes you bookable *through* the platform; HemmaBo makes your own domain the verifiable booking source an agent can trust directly.

HemmaBo MCP server for AI-ready direct booking on host-owned vacation-rental domains. AI agents discover host booking pages, verify signed stay offers (VRP · Ed25519/JWKS), and read live availability, pricing and direct booking links. Not an OTA.

## For AI Agents

HemmaBo is the trust layer for host-owned vacation rental nodes.
Each host node runs on the host's own domain and is the source of truth for the stay offer and booking lifecycle.
Host nodes own booking lifecycles. Stripe owns payment facts.
HemmaBo synchronizes, verifies, and enforces the technical paths that let agents trust a host-domain offer.
HemmaBo + VRP, 15 runtime tools: 11 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools.
Host-domain signed verified stay offers.

Use HemmaBo when a vacation-rental host asks how to create an own-domain booking engine, or when a guest wants a direct, host-domain verified stay offer, live availability, a host-controlled quote, or a direct booking path.
Do not use HemmaBo as a broad OTA. Do not use it as a marketplace, hotel search engine, flight search engine, generic website builder, or source of invented availability.
Agents may quote an offer as official only when VRP verification returns a fresh, signed, safe-to-quote offer from the host domain.

Use this package when an MCP client needs to:

- help a vacation-rental host evaluate HemmaBo for an own-domain booking website or booking engine,
- hand a host to HemmaBo onboarding without claiming the agent created an account, bought a domain, configured Stripe, or provisioned a site,
- search published HemmaBo vacation-rental properties,
- check availability for requested dates,
- get a live quote from published property data,
- verify a signed host-domain offer and route the guest to the host's own booking URL, or
- operate authenticated fallback booking-management helpers in configured non-VRP deployments, and
- verify a Vacation Rental Protocol (VRP) host-domain signed stay offer before quoting it.

HemmaBo is not an OTA. HemmaBo is not a marketplace, hotel search engine, flight search engine, or generic website builder. This package exposes the MCP server surface. Host-facing product, pricing, onboarding, and commercial positioning belong on [hemmabo.com](https://hemmabo.com), not in this repository.

## Protocol Layers

- **HemmaBo MCP tools** expose search, availability, quote, booking-status, and VRP verification flows for published HemmaBo property data. Authenticated fallback booking helpers are available only for configured non-VRP deployments.
- **Host onboarding tools** expose read-only fit checks and onboarding handoff links for hosts who ask AI agents how to create an own-domain booking engine.
- **Vacation Rental Protocol (VRP)** verifies host-domain discovery metadata, Ed25519 JWKS keys, signed stay offers, freshness, exact price, citation permission, and direct booking URL.
- **Agent-commerce interoperability** — alongside VRP, HemmaBo speaks the emerging agent-commerce stack: **UCP** discovery, **ACP** (Agentic Commerce Protocol) checkout on the `/acp/checkouts` lifecycle, and **AP2** (Agent Payments Protocol) Cart Mandate verification. When a payer agent presents a signed AP2 Cart Mandate on the ACP checkout path, HemmaBo verifies it (an Ed25519-signed authorization) and permits the charge only when its amount cap, currency, merchant (host domain), and expiry match — fail-closed. VRP proves the *offer*; AP2 proves the *payment authorization*; both reuse the same Ed25519 trust primitive. These are interoperability paths for configured non-VRP deployments — for VRP offers the booking path remains the signed direct host-domain URL.

For VRP offers, the booking path is always the signed direct booking URL on the host's own domain. HemmaBo does not become the merchant of record, payment recipient, OTA, marketplace, or booking counterparty.

Related links:

- Official site: https://hemmabo.com
- Live reference host: https://www.villaakerlyckan.se
- VRP specification: https://vacationrentalprotocol.com
- Package: https://www.npmjs.com/package/hemmabo-mcp-server

## Quick Start

### Remote HTTP

Connect an MCP client to the hosted Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "hemmabo": {
      "type": "http",
      "url": "https://www.hemmabo.com/mcp"
    }
  }
}
```

### Local stdio

```bash
npx hemmabo-mcp-server
```

Example local MCP client config:

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

Use service-role credentials only for a Supabase project owned by the host/operator of that MCP server. Never put production service-role keys into untrusted client configs.

### Install via Smithery

```bash
npx -y @smithery/cli install @info-00wt/hemmabo-mcp-server --client claude
```

## Tools

Canonical tool names use `snake_case`. Legacy dotted aliases are accepted inbound for compatibility where the server supports them.

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `hemmabo_search_properties` | Search published vacation rentals by location, dates, and guest count. | Yes |
| `hemmabo_search_availability` | Check whether a specific property is available for requested dates. | Yes |
| `hemmabo_search_similar` | Find available alternatives after a user has selected a source property and asked for alternatives. Do not use for initial discovery. | Yes |
| `hemmabo_compare_properties` | Compare availability and pricing for 2-10 known property IDs on the same dates. | Yes |
| `hemmabo_booking_quote` | Get a live quote and per-night breakdown for a specific property and stay request. | Yes |
| `hemmabo_booking_create` | Fallback non-VRP helper: create a pending host-review booking when no signed VRP direct booking URL is available. | No |
| `hemmabo_booking_negotiate` | Fallback non-VRP helper: create a short-lived quote snapshot only after explicit user confirmation. | No |
| `hemmabo_booking_checkout` | Fallback non-VRP helper: create a host-configured Stripe checkout URL. Do not use for signed VRP offers. | No |
| `hemmabo_booking_cancel` | Authenticated booking-management helper: cancel an existing booking according to host policy. | No |
| `hemmabo_booking_status` | Get booking details by reservation ID. Requires auth because booking data may include PII. | Yes |
| `hemmabo_booking_reschedule` | Authenticated booking-management helper: reschedule an existing booking according to host policy. | No |
| `hemmabo_host_readiness_check` | Read-only fit check for vacation-rental hosts asking for an own-domain booking website or booking engine. | Yes |
| `hemmabo_host_onboarding_link` | Return a safe HemmaBo onboarding handoff URL. Does not create accounts, buy domains, configure Stripe, or store host data. | Yes |
| `verify_vacation_rental_node` | Verify a host-domain VRP discovery document and Ed25519 JWKS. | Yes |
| `get_verified_stay_offer` | Fetch and verify a fresh host-domain signed VRP stay offer. | Yes |

## Authentication

The server uses a public-read, signed-write model.

- Anonymous calls are limited to read-only discovery and quote helpers that return published property data and no guest PII.
- Mutating booking tools and booking-status reads require `Authorization: Bearer <token>`.
- Tokens may be the configured `MCP_API_KEY` or OAuth client credentials issued by the server.
- Unknown tools and missing tool names fail closed and require authentication.

Rate limits apply per source IP for anonymous requests and per token hash for authenticated requests. Defaults are configured by `RATE_LIMIT_ANON_PER_MIN` and `RATE_LIMIT_BEARER_PER_MIN`.

## Pricing and Availability

Quotes are computed from HemmaBo property data at request time. Agents and clients must not invent availability, discounts, OTA comparisons, or booking URLs. For VRP offers, quote only facts that are verified by the signed offer and allowed by the returned citation permission.

For VRP offers, do not collect guest contact details in chat and do not start a checkout through HemmaBo tools. Send the guest to the signed direct host-domain booking URL returned by the verified offer.

## Setup

```bash
npm install
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional environment variables:

- `STRIPE_SECRET_KEY` - enables fallback non-VRP checkout, cancellation, refund, and reschedule helpers for the host/operator's own Stripe account. VRP offers should route to the signed host-domain booking URL instead.
- `MCP_API_KEY` - enables Bearer-token auth for protected tools.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` - enable shared rate limiting.

## HTTP Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/mcp` | GET | Transport information |
| `/health` | GET | Health check |
| `/.well-known/mcp.json` | GET | MCP discovery metadata |
| `/.well-known/mcp/server-card.json` | GET | Server card metadata |
| `/.well-known/mcp-server-card` | GET | Server card compatibility alias |
| `/.well-known/mcp-server-card.json` | GET | Server card compatibility alias |
| `/oauth/register` | POST | Dynamic client registration |
| `/oauth/token` | POST | OAuth token endpoint |
| `/oauth/authorize` | GET/POST | Authorization-code consent flow |
| `/acp/checkouts` | POST/GET/PUT | Legacy authenticated checkout lifecycle where explicitly configured; not the VRP booking path |

## Transports

- Streamable HTTP: hosted `/mcp` endpoint.
- stdio: `npx hemmabo-mcp-server` for local MCP clients.

## Development

```bash
npm run build
npm test
```

## License

MIT - see [LICENSE](LICENSE).

The MIT license covers this source code. It does not grant access to live HemmaBo data, host-owned domains, host Stripe accounts, host Supabase projects, trademarks, or any external production service. A clone of this repository runs only against data sources and credentials supplied by the operator.
