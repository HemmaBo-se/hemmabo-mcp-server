# ADR 0019: The platform connector is catalog and verifier

- Status: Accepted (CEO decision, 2026-10-01)
- Date: 2026-10-01
- Decides for: the platform connector — `www.hemmabo.com/mcp` (full surface,
  `api/mcp.ts`) and `/.well-known/mcp.json` (`api/mcp-manifest.ts`); tool
  declarations in `lib/tool-definitions-base.ts` and `lib/tool-definitions.ts`;
  dispatch in `lib/tools-base.ts`; runtime description and instructions in
  `lib/server-metadata.ts`.
- Not touched: `/mcp/chatgpt` (`CHATGPT_TOOL_NAMES`,
  `CHATGPT_SERVER_DESCRIPTION`, `CHATGPT_SERVER_INSTRUCTIONS`), `api/acp.ts`,
  the OAuth endpoints and their metadata.

## Context

Until this decision the platform connector served 13 runtime tools: 9 HemmaBo
tools, 2 host onboarding tools and 2 VRP verification tools. Seven of the nine
HemmaBo tools did work that belongs to the host node, not to the platform:

| Tool | What it did on the platform connector |
|---|---|
| `hemmabo_booking_create` | Wrote a pending booking row. |
| `hemmabo_booking_negotiate` | Wrote a 15-minute quote snapshot (`property_quote_snapshots`). |
| `hemmabo_booking_checkout` | Wrote a pending booking row and created a Stripe Checkout Session on the host's connected account. |
| `hemmabo_booking_cancel` | Set a booking to `cancelled` and deleted its `property_blocked_dates` rows. |
| `hemmabo_booking_reschedule` | Moved a booking's dates and rewrote its `total_price`. |
| `hemmabo_booking_status` | Read guest data (masked name and email) for a booking. |
| `hemmabo_booking_quote` | Returned an unsigned platform price computed from the shared tables. |

A platform tool that writes bookings, reads guest data or states an unsigned
price puts HemmaBo between the guest and the host. The signed offer from the
host domain (`get_verified_stay_offer`) is the only price an agent needs, and
the host domain is the only place a guest books, pays and manages a stay.

## Decision

1. **The platform connector stops writing bookings and stops moving money.**
   It is catalog and verifier: it finds a host domain, verifies an
   Ed25519-signed offer against that domain, and hands back
   `direct_booking_url`. The guest books and pays the host there. No ranking,
   no price comparison, no `ota_comparison_total`, no "cheaper".
2. **Removed from the platform connector:** `hemmabo_booking_create`,
   `hemmabo_booking_negotiate`, `hemmabo_booking_checkout`,
   `hemmabo_booking_cancel`, `hemmabo_booking_reschedule` (they write);
   `hemmabo_booking_status` (reads guest data — the manage link comes from the
   node, not a platform tool); `hemmabo_booking_quote` (unsigned platform price
   from shared tables — only `get_verified_stay_offer` carries price). Their
   legacy dotted aliases (`booking.*`) are removed with them.
3. **Remaining, six:** `hemmabo_search_properties`,
   `hemmabo_search_availability`, `verify_vacation_rental_node`,
   `get_verified_stay_offer`, `hemmabo_host_readiness_check`,
   `hemmabo_host_onboarding_link`. All six are read-only and anonymous
   (`ANON_TOOLS`).
4. **The name stays** "HemmaBo Host Booking Engine" (`SERVER_TITLE`).
5. **The count sentence is exactly:** "6 runtime tools: 2 HemmaBo tools, 2 host
   onboarding tools, and 2 VRP verification tools." It replaces the 13/9 count
   inside the existing "HemmaBo + VRP, …" line of `SERVER_DESCRIPTION`,
   `SERVER_INSTRUCTIONS` and their registry mirrors (`package.json`,
   `glama.json`, `smithery.yaml`), `README.md`, `llms.txt` and `project.faf`.
6. **`/mcp/chatgpt` is not touched as a surface:** it stays exactly 3 tools and
   `CHATGPT_TOOL_NAMES` is unchanged.
7. **Search:** each `hemmabo_search_properties` hit carries that node's own
   `booking_url` — `https://` plus the property's domain, trimmed and
   lower-cased, the same derivation as `hemmabo-smart-stays`
   `api/search-properties.ts`; `null` when the property has no domain. Hits are
   ordered by name (then domain, then propertyId), never by price, and carry
   no score.

## Consequences

- `tools/list` on `/mcp` and the `tools` array of `/.well-known/mcp.json` list
  exactly the six tools above. None of create, negotiate, checkout, cancel,
  reschedule, status or quote appears on any platform surface.
- A `tools/call` to a removed name fails closed exactly as an unknown name
  always has: it is outside `ANON_TOOLS`, so it requires a Bearer token
  (`isAuthRequiredMessage` is unchanged), and with a token it answers
  `Unknown tool`. No handler runs.
- The platform runtime (`lib/tools-base.ts`) has no `bookings` insert, update
  or delete, no `property_quote_snapshots` write, no booking lock and no Stripe
  call. `src/stripe.ts`, `lib/pricing.ts`, `lib/booking-locks.ts` and
  `lib/booking-binding.ts` stay, because `api/acp.ts` still imports them.
- **The node keeps its own booking lifecycle tools.** The host node's MCP
  (`hemmabo-smart-stays` `api/_lib/mcp-tools.ts`) still declares
  `check_availability`, `negotiate_offer`, `checkout`, `cancel_booking`,
  `get_booking_status` and `reschedule_booking` on the host's own domain; its
  lifecycle tools hand the guest the manage link on that domain
  (`api/manage-link.ts`). Nothing in this decision changes the node.
- `scripts/check-facts-drift.sh` holds the canonical runtime total at 6 and the
  HemmaBo sub-count at 2, and flags a bare "13 tools" as stale.
- Same-day dependency: `hemmabo-smart-stays` mirrors and pins this tool list
  (its smoke test currently requires at least 11 platform tools); that mirror
  change must merge the same day as this one.

## Supersedes

This ADR supersedes, without rewriting them:

- ADR 0004 — the 13-tool rows: §1 Context, lines 14–28 (the 13-tool list) and
  line 45; §2.2 surface table, lines 131–136; lines 305, 312, 323 and 336; the
  checklist, lines 403–404 and 407. The canonical total is now 6.
- ADR 0001 — §2.4 rename table, lines 89–95: the `booking.*` →
  `hemmabo_booking_*` rows name tools that are no longer platform tools.
- ADR 0002 — line 40: the anonymous bucket no longer contains `booking.quote`.
- ADR 0003 — line 22: `booking.status`, `booking.cancel` and
  `booking.reschedule` are no longer platform tools, so the trade-off recorded
  there no longer applies to the platform connector.
- ADR 0005 — "Public MCP booking schemas", lines 57–64: the platform tools
  publish no booking status output.
- ADR 0014 — line 50: "The 13 tools" reviewed there are now 6.
- ADR 0016 — the whole decision: the availability gate it adds guards
  `hemmabo_booking_negotiate` and `hemmabo_booking_quote`, which are removed.
