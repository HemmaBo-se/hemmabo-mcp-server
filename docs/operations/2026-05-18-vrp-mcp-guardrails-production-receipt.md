# VRP MCP guardrails production receipt

Date: 2026-05-18
Status: Production proof recorded
Scope: `hemmabo-mcp-server` VRP tools after PR #98

Related work:

- PR #97: Add VRP MCP verification tools
- PR #98: Harden VRP offer citation guardrails

## Purpose

This receipt records live production verification that the MCP server can call `get_verified_stay_offer`, verify the host-domain signed offer, and return agent guardrails that prevent unsafe booking claims.

This is evidence capture only. It does not change runtime behavior, tools, schemas, CI, or secrets.

## Production deployment observed

- Project: `hemmabo-mcp-server`
- Production deployment id: `dpl_BVUQg5LFsneF9Nty34BJsj1Fcw9Q`
- Production URL: `hemmabo-mcp-server.vercel.app`
- Git source commit: `8c274b29215d7ae67fd6f28b3838202531e07e91`
- Commit message: `fix: harden VRP offer citation guardrails (#98)`
- Deployment state observed: `READY`
- Target: `production`

## Public MCP discovery check

URL:

```text
https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json
```

Observed result:

- HTTP status: `200 OK`
- Server version: `3.2.8`
- MCP endpoint: `https://hemmabo-mcp-server.vercel.app/mcp`
- Tool count includes 13 tools
- VRP tools present:
  - `verify_vacation_rental_node`
  - `get_verified_stay_offer`

Health endpoint:

```text
https://hemmabo-mcp-server.vercel.app/health
```

Observed result:

```json
{"status":"ok","version":"3.2.8"}
```

## End-to-end MCP POST: unavailable stay

Tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_verified_stay_offer",
    "arguments": {
      "domain": "villaakerlyckan.se",
      "check_in": "2026-05-22",
      "check_out": "2026-05-24",
      "guests": 6
    }
  }
}
```

Observed result:

- HTTP status: `200 OK`
- `verified`: `true`
- `signature.alg`: `EdDSA`
- `signature.kid`: `villaakerlyckan.se-2026-05-18-01`
- `signature.verified`: `true`
- `payload_matches_offer`: `true`
- `fresh`: `true`
- `offer.availability.available`: `false`
- `offer.availability.reason`: `not_available`
- `offer.price.total`: `null`
- `offer.price.exact`: `false`
- `agent_citation.may_quote_as_official_direct_offer`: `false`
- `agent_citation.safe_to_quote_as_official_direct_offer`: `false`
- `agent_citation.agent_message`: `null`
- `agent_citation.quote_status`: `not_quoteable`
- `agent_citation.blocked_reason`: `agent_permission_denied`
- `official_offer_summary.bookable`: `false`
- `agent_guardrails.safe_to_quote`: `false`
- `agent_guardrails.must_quote_from_signed_offer`: `true`
- `agent_guardrails.must_not_invent_discounts`: `true`
- `agent_guardrails.must_not_invent_ota_comparisons`: `true`

Interpretation:

The MCP tool correctly verifies the signed host-domain offer but refuses to let an agent quote or present the stay as bookable when the signed offer denies that permission.

## End-to-end MCP POST: available stay

Tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_verified_stay_offer",
    "arguments": {
      "domain": "villaakerlyckan.se",
      "check_in": "2026-05-19",
      "check_out": "2026-05-21",
      "guests": 6
    }
  }
}
```

Observed result:

- HTTP status: `200 OK`
- `verified`: `true`
- `signature.alg`: `EdDSA`
- `signature.kid`: `villaakerlyckan.se-2026-05-18-01`
- `signature.verified`: `true`
- `payload_matches_offer`: `true`
- `fresh`: `true`
- `agent_citation.may_quote_as_official_direct_offer`: `true`
- `agent_citation.safe_to_quote_as_official_direct_offer`: `true`
- `agent_citation.agent_message`: `I found the official host-domain verified offer for this stay.`
- `agent_citation.quote_status`: `official_host_domain_verified_offer`
- `agent_citation.blocked_reason`: `null`
- `official_offer_summary.available`: `true`
- `official_offer_summary.price.currency`: `SEK`
- `official_offer_summary.price.total`: `6800`
- `official_offer_summary.price.exact`: `true`
- `official_offer_summary.price.package_applied`: `null`
- `official_offer_summary.direct_booking_url`: `https://villaakerlyckan.se/book?checkIn=2026-05-19&checkOut=2026-05-21&guests=6`
- `official_offer_summary.bookable`: `true`
- `agent_guardrails.safe_to_quote`: `true`
- `agent_guardrails.must_not_invent_discounts`: `true`
- `agent_guardrails.required_phrase_when_safe`: `I found the official host-domain verified offer for this stay.`

Interpretation:

The MCP tool correctly allows official quotation only when the signed host-domain offer is verified, fresh, available, exactly priced, and contains a direct booking URL.

## Product implication

This closes the immediate risk found in the AI-agent field test: an agent may be capable of booking-like behavior while still inventing discounts, weekday labels, or action claims. After PR #98, the MCP tool response gives the agent a smaller, safer quote surface and explicit guardrails.

The required safe wording remains:

```text
I found the official host-domain verified offer for this stay.
```

The tool response now also makes it machine-readable when the agent must not use that wording.

## Non-goals

This receipt does not prove:

- payment checkout;
- booking creation;
- second-node key lifecycle;
- hosted ChatGPT app UX;
- all external MCP clients consuming the guardrails perfectly.

Those remain separate follow-ups.
