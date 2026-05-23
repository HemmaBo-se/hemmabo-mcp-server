# ADR 0004 Phase 2 - Repo-Owned Lockstep Update

Date: 2026-05-18
Scope: Repo-owned metadata/discovery/packaging surfaces only.
Runtime logic changes: none.
New tools/endpoints: none.

## Canonical phrase applied

HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer.

Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers.

HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.

## Updated surfaces

- `README.md`
- `package.json`
- `glama.json`
- `smithery.yaml`
- `server.json`
- `api/mcp-manifest.ts` (`/.well-known/mcp.json` source)
- `api/mcp.ts` (`SERVER_INSTRUCTIONS`, prompt wording for `/.well-known/mcp/server-card.json`)
- `submission/chatgpt-app-submission.json`
- `llms.txt`
- Internal citation-strategy notes were moved out of the public repo surface.

## Lockstep outcomes

- Glama metadata now lists all 13 tools, including:
  - `verify_vacation_rental_node`
  - `get_verified_stay_offer`
- ChatGPT submission now includes both VRP tools with annotations and justifications.
- ChatGPT submission test prompts now follow ADR 0004 Section 2.3 trigger doctrine:
  - 7 positive prompts
  - 5 negative prompts
- Manifest metadata and server instructions now reflect HemmaBo + VRP positioning.

## Verification run

- `npx tsx --test src/manifest-auth.contract.test.ts src/mcp-manifest-singleton.test.ts src/mcp-anonymous-access.contract.test.ts`
- `npx tsx --test src/tool-definitions.singleton.test.ts src/mcp-tool-annotations.contract.test.ts`

Result: all tests passed.
