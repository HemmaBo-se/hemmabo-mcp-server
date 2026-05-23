# ADR 0004 Phase 1 - Inventory and Stale-Surface Audit

Date: 2026-05-18
Scope: `hemmabo-mcp-server` public discovery, metadata, and packaging surfaces only.
Runtime changes: none.

## Contract target

All public surfaces should align to:

`HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.`

## Inventory status

| Surface | Status | Notes |
|---|---|---|
| `README.md` | stale: missing VRP | 13 tools text exists, but tools table lists 11 HemmaBo tools only and does not include `verify_vacation_rental_node` / `get_verified_stay_offer`. |
| `package.json` | stale: old positioning | Says 13 tools, but does not include canonical HemmaBo+VRP wording or VRP/verified stay offer keywords. |
| `glama.json` | stale: wrong tool count | `tools[]` lists 11 tools (missing both VRP tools). |
| `smithery.yaml` | stale: old positioning | Says 13 tools, but no explicit HemmaBo+VRP doctrine phrase and no explicit signed verified stay offer positioning. |
| `/.well-known/mcp.json` (live) | current | Live manifest includes 13 tools, both VRP tools, and host-domain signed verified stay offer wording. |
| `/.well-known/mcp/server-card.json` (live) | stale: old positioning | Lists 13 tools including VRP tools, but instructions still describe legacy dotted flow and not canonical HemmaBo+VRP lockstep phrasing. |
| `submission/chatgpt-app-submission.json` | stale: wrong tool count | `tools` block includes 11 tools only (missing both VRP tools); test prompts not yet aligned to ADR 0004 Section 2.3 trigger doctrine. |
| Internal citation-strategy notes | stale: overclaim | Mixed 11/13 tool claims and marketing-first framing; moved out of the public repo surface. |
| `llms.txt` (repo copy) | stale: old positioning | Mentions VRP context but not consistently aligned to ADR 0004 three-layer doctrine lockstep wording. |
| Custom GPT description | missing | Not versioned in this repo; needs separate operational update and proof capture. |
| `vacationrentalprotocol.com` | missing | Not present in repo and not verified as published neutral standard site in this audit pass. |
| Villa Åkerlyckan proof page | missing | Not present in this repo; proof-page status must be validated on host node operations side. |
| Glama live listing | stale: wrong tool count | Live page reflects README copy with 11-tool table (stale versus runtime 13-tool surface). |
| Smithery live listing | stale: old positioning | Listing inherits older packaging copy; needs explicit HemmaBo+VRP lockstep language refresh after metadata updates/reindex. |
| MCP.so live listing | stale: missing VRP | Indexed summary emphasizes booking tools and does not show VRP verification path as primary discovery positioning. |
| NPM live package metadata | stale: old positioning | Version `3.2.8` with older description; not yet fully aligned to canonical HemmaBo+VRP doctrine terms. |

## Evidence sources used in this phase

- Local repo files on `main` worktree:
  - `README.md`
  - `package.json`
  - `glama.json`
  - `smithery.yaml`
  - `submission/chatgpt-app-submission.json`
- Live endpoint checks:
  - `https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json`
  - `https://hemmabo-mcp-server.vercel.app/.well-known/mcp/server-card.json`
- Registry snapshot checks:
  - Glama listing for `HemmaBo-se/hemmabo-mcp-server`
  - MCP.so listing for HemmaBo server
  - NPM metadata via `npm view hemmabo-mcp-server`

## Phase 1 conclusion

ADR 0004 Phase 1 inventory is complete: multiple public discovery and packaging surfaces are stale against runtime and doctrine.
No runtime logic, tools, endpoints, pricing, payment, or database behavior was changed.
