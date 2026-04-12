# HemmaBo MCP Server

**Direct vacation rental booking — zero commission, AI-native, source of truth.**

`network_id: hemmabo_verified`

HemmaBo is a white-label vacation rental platform where every host operates on their own domain. Each property is an independent node — the authoritative source of truth for its own availability, pricing and amenity data. No OTA intermediary. No commission. No platform lock-in.

## What this MCP server does

AI agents (ChatGPT, Claude, Gemini and others) can use this server to:

- Search available vacation rental properties by region, dates and guest count
- Check real-time availability for a specific property
- Get a canonical price quote including `aiTotal` (AI-agent rate) and `publicTotal`
- Create a direct booking — confirmed instantly, zero commission to any platform

## Tools

| Tool | Description |
|------|-------------|
| `search_properties` | Search available properties: region, checkIn, checkOut, guests |
| `check_availability` | Verify availability for a specific property and date range |
| `get_canonical_quote` | Get pricing breakdown: aiTotal, publicTotal, cleaningFee, nights |
| `create_booking` | Confirm a direct booking and return bookingId |

## Architecture

- Every host = one node with its own domain (e.g. `villa-akerlyckan.hemmabo.com`)
- `network_id: hemmabo_verified` — signals to AI agents that data is direct, complete and commission-free
- `domain_role: source_of_truth` — no aggregator, no intermediary, no stale data
- OAuth 2.1 + JWT scoped per property for secure booking operations
- ANP/DID-compatible: each host domain is a verifiable decentralized identity

## Status

MCP server under active development. Mock data returned by all tools until Supabase integration is complete.
