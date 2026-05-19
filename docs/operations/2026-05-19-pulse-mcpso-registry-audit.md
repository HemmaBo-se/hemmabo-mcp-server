# PulseMCP, MCP.so, and Official Registry Audit

Date: 2026-05-19
Scope: ADR 0004 discovery and packaging surfaces after `hemmabo-mcp-server@3.2.9`

## Locked Public Positioning

All public discovery surfaces must converge on:

> HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.

This is metadata/discovery/packaging work only.

Do not add runtime booking logic.
Do not add new MCP tools.
Do not create duplicate registry listings when an existing HemmaBo listing can be claimed, synced, or republished.

## Current Source of Truth

Repository:

- `https://github.com/HemmaBo-se/hemmabo-mcp-server`

NPM:

- `hemmabo-mcp-server@3.2.9`

Remote MCP endpoint:

- `https://hemmabo-mcp-server.vercel.app/mcp`

Live MCP discovery:

- `https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json`
- `https://hemmabo-mcp-server.vercel.app/.well-known/mcp/server-card.json`

The live MCP metadata exposes 13 tools, including:

- `verify_vacation_rental_node`
- `get_verified_stay_offer`

## Official MCP Registry State

Official registry API checked:

- `https://registry.modelcontextprotocol.io/v0/servers?search=hemmabo`
- `https://registry.modelcontextprotocol.io/v0/servers?search=hemmabo&version=latest`

Observed latest registry version before this audit:

- name: `com.hemmabo/hemmabo-mcp-server`
- version: `3.2.4`
- description: `Vacation rental booking infrastructure for independent hosts. 0% commission. MCP + Stripe ACP.`
- repository: `https://github.com/HemmaBo-se/hemmabo-mcp-server`
- remote: `https://hemmabo-mcp-server.vercel.app/mcp`

Older registry versions also exist and are stale:

- `1.0.0` points at `https://github.com/HemmaBo-se/hemmabo-smart-stays`
- `1.0.0` points at `https://mcp.hemmabo.se/mcp`
- `1.0.1` still uses old direct-booking positioning

Conclusion:

The official registry listing exists, but latest published metadata is stale against ADR 0004 and NPM `3.2.9`.

## `server.json` Fix

The repository `server.json` was already versioned at `3.2.9`, but its `description` exceeded the official registry schema limit of 100 characters.

Validation error observed:

```text
server.json.description must NOT have more than 100 characters
```

Fix applied:

- Added `title`: `HemmaBo`
- Shortened `description` to the locked ADR 0004 phrase:
  `HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.`

Validation result after fix:

```json
{
  "ok": true,
  "errors": null
}
```

## PulseMCP State

PulseMCP appears to consume or mirror official MCP Registry metadata for many listings.

Relevant PulseMCP docs state that its directory is powered by manual submissions, automated crawling, official MCP Registry integration, and enrichment from public data.

Operational conclusion:

For PulseMCP, do not create a duplicate HemmaBo listing first.
Publish/sync the corrected `server.json` to the official MCP Registry as `3.2.9`; then verify PulseMCP picks it up or submit the canonical registry/GitHub record.

## MCP.so State

MCP.so has stale HemmaBo listings.

Observed stale URLs:

- `https://mcp.so/server/hemmabo/HemmaBo`
- `https://chat.mcp.so/server/hemmabo/HemmaBo?tab=content`
- `https://mcp.so/zh/server/hemmabo/HemmaBo`

Observed stale indicators:

- Missing VRP positioning
- Missing `HemmaBo + VRP, 13 tools`
- Missing `verify_vacation_rental_node`
- Missing `get_verified_stay_offer`
- Contains old names such as `check_availability` and `get_canonical_quote`
- One stale listing references `https://hemmabo-smart-stays.vercel.app/api/mcp`

Operational conclusion:

MCP.so needs an update or support request against the existing HemmaBo listing(s), not a new duplicate listing unless MCP.so support explicitly requires replacement.

Suggested MCP.so support/update text:

```text
Please update the existing HemmaBo MCP listing(s) to the canonical current metadata.

Canonical server:
HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.

Canonical repo:
https://github.com/HemmaBo-se/hemmabo-mcp-server

Canonical remote MCP endpoint:
https://hemmabo-mcp-server.vercel.app/mcp

Canonical package:
hemmabo-mcp-server@3.2.9

Current tool surface:
13 tools, including verify_vacation_rental_node and get_verified_stay_offer.

Please remove or refresh stale references to:
- hemmabo-smart-stays
- https://hemmabo-smart-stays.vercel.app/api/mcp
- old tool names such as check_availability and get_canonical_quote
- old 11-tool positioning
```

## OpenAI Codex Plugin Catalog Watch

Treat OpenAI Codex plugin catalog/self-serve availability as a watch item, not as a code change.

When self-serve submission opens, use the same locked positioning and existing live remote endpoint:

- `HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.`
- `https://hemmabo-mcp-server.vercel.app/mcp`

Do not fork the messaging for a Codex-specific listing unless ADR 0004 is amended.

