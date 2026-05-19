# Smithery `info-00wt` republish receipt

Date: 2026-05-19
Status: Production Smithery listing restored
Scope: Smithery listing and registry packaging for `hemmabo-mcp-server` after ADR 0004

## Hard rule for future agents

Do not create a new Smithery server for HemmaBo.

The existing production Smithery server is:

```text
info-00wt/hemmabo-mcp-server
```

Correct Smithery listing URL:

```text
https://smithery.ai/servers/info-00wt/hemmabo-mcp-server
```

Correct upstream MCP server URL:

```text
https://hemmabo-mcp-server.vercel.app/mcp
```

An accidental duplicate namespace/server was observed during this work:

```text
info-00t8/hemmabo-mcp-server
```

Do not continue work on that duplicate. Any future cleanup should happen only after confirming ownership and that `info-00wt/hemmabo-mcp-server` remains healthy.

## Smithery state observed after republish

The existing `info-00wt/hemmabo-mcp-server` listing was opened with owner access and republished against:

```text
https://hemmabo-mcp-server.vercel.app/mcp
```

Observed Smithery UI state after republish:

- Display name: `HemmaBo`
- Namespace/server id: `info-00wt/hemmabo-mcp-server`
- Quality score: `100/100`
- Tools: `13`
- Prompts: `1`
- Recent release target: `hemmabo-mcp-server.vercel.app`
- Release status: `SUCCESS`
- Release log: `Using .well-known/mcp/server-card.json: (13 tools, 1 prompt)`
- Homepage: `hemmabo.com`

Smithery's release log also showed:

```text
Warning: No config schema provided.
```

This warning was non-blocking and the quality score remained `100/100`.

## Connection settings decision

Connection settings were skipped.

Reason: HemmaBo is global. Smithery connection defaults must not hardcode a language, currency, or a single property domain.

Do not set these defaults in Smithery:

```text
language=sv
currency=SEK
propertyDomain=villaakerlyckan.se
```

If Smithery connection settings are added in a later task, all of these fields must remain optional and have blank defaults:

| Field | Type | Location | Required | Default |
|---|---|---|---|---|
| `propertyDomain` | `string` | `query` | no | blank |
| `region` | `string` | `query` | no | blank |
| `language` | `string` | `query` | no | blank |
| `currency` | `string` | `query` | no | blank |

Villa Akerlyckan is the reference proof node, not a Smithery-wide connection default.

## Locked public description

Keep this wording locked across public registry surfaces:

```text
HemmaBo verifies and books host-owned vacation rental domains. Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers. HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.
```

Do not rewrite this in Smithery unless ADR 0004 is explicitly amended.

## Ownership and protocol boundary

The two VRP verification tools belong in the HemmaBo MCP server listing because HemmaBo is the provider/federation implementation exposing them through MCP.

They do not make VRP HemmaBo-owned.

Boundary:

- HemmaBo = provider / federation / app / MCP server.
- VRP = open protocol / neutral standard.
- Villa Akerlyckan and future host domains = proof nodes with their own discovery, JWKS, and signed stay offers.

Do not describe VRP as HemmaBo-owned.

## Tool inventory verification

Live source checked:

```text
https://hemmabo-mcp-server.vercel.app/.well-known/mcp/server-card.json
```

Observed live server-card result:

- Tool count: `13`
- Missing expected tools: `0`
- Extra tools: `0`
- Dotted public tool names: `0`
- Prompts: `1`

Expected and observed tools:

| Tool | Belongs here | Auth | Notes |
|---|---:|---|---|
| `hemmabo_search_properties` | yes | none | Public read-only discovery. |
| `hemmabo_search_availability` | yes | none | Public read-only availability check. |
| `hemmabo_search_similar` | yes | none | Public read-only alternatives. |
| `hemmabo_compare_properties` | yes | none | Public read-only comparison. |
| `hemmabo_booking_quote` | yes | none | Public read-only quote. |
| `hemmabo_booking_create` | yes | bearer | Legacy unpaid booking flow; still part of the canonical 13. |
| `hemmabo_booking_negotiate` | yes | bearer | Binding quote snapshot before checkout. |
| `hemmabo_booking_checkout` | yes | bearer | Stripe checkout booking flow. |
| `hemmabo_booking_cancel` | yes | bearer | Destructive cancellation/refund flow. |
| `hemmabo_booking_status` | yes | bearer | Booking status can expose PII; auth required. |
| `hemmabo_booking_reschedule` | yes | bearer | Destructive reschedule flow. |
| `verify_vacation_rental_node` | yes | none | VRP read-only host-domain discovery/JWKS verification. |
| `get_verified_stay_offer` | yes | none | VRP read-only signed verified stay offer verification. |

Conclusion: no observed tool is out of scope or incorrectly listed on the HemmaBo Smithery server.

## Naming verification

All public tool names observed in the live server-card are Anthropic-strict safe:

```text
^[a-zA-Z0-9_-]{1,64}$
```

No live public tool name contains `.`.

The expected names are snake_case:

```text
hemmabo_search_properties
hemmabo_search_availability
hemmabo_search_similar
hemmabo_compare_properties
hemmabo_booking_quote
hemmabo_booking_create
hemmabo_booking_negotiate
hemmabo_booking_checkout
hemmabo_booking_cancel
hemmabo_booking_status
hemmabo_booking_reschedule
verify_vacation_rental_node
get_verified_stay_offer
```

## Known stale surface

The Smithery UI and release scan showed the restored state, but Smithery's markdown/text route may lag behind registry UI state:

```text
https://smithery.ai/server/info-00wt/hemmabo-mcp-server
```

During verification, that route still returned old `Tools (11)` copy and dotted legacy names. Treat the Smithery UI, release log, and live `server-card.json` as the authoritative verification sources for this receipt.

## Operational checklist for future Smithery updates

1. Open the existing server: `https://smithery.ai/servers/info-00wt/hemmabo-mcp-server`.
2. Do not open `/servers/new`.
3. Do not create or publish under a new namespace.
4. Keep display name `HemmaBo`.
5. Keep the locked HemmaBo + VRP description.
6. Keep homepage `https://hemmabo.com`.
7. Keep GitHub repository `https://github.com/HemmaBo-se/hemmabo-mcp-server`.
8. Publish against `https://hemmabo-mcp-server.vercel.app/mcp`.
9. Skip connection settings unless there is a specific reviewed reason to add optional blank defaults.
10. After publish, verify `100/100`, `13 tools`, `1 prompt`, and release `SUCCESS`.

