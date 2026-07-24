# Connect HemmaBo to Gemini Enterprise

Add HemmaBo's MCP server to **Google Gemini Enterprise** as a custom MCP data
store, so agents in your Gemini Enterprise workspace can discover and verify
host-owned vacation-rental nodes directly — search availability, fetch a
cryptographically signed (VRP) stay offer, and verify a node — with no plugin
and no scraping.

This is for a customer (a travel agency, property manager, or any organization)
that **already has Gemini Enterprise**. HemmaBo does not need any Google
subscription; you connect to HemmaBo's already-live public server.

---

## What you connect to

| | |
|---|---|
| **MCP server URL** | `https://www.hemmabo.com/mcp` |
| **Transport** | Streamable HTTP (the only transport Gemini Enterprise accepts; SSE is not used) |
| **TLS** | HTTPS, valid certificate |
| **Recommended auth** | **None** — HemmaBo's discovery and verification tools are public, read-only |

> Use the `www.` URL exactly. The apex `hemmabo.com/mcp` issues a 308 redirect to
> `www.`, and some connectors do not follow redirects on the MCP endpoint.

## Which tools you get with "No Authentication"

A no-auth connection exposes HemmaBo's read-only tools — no writes, no payments,
no personal data:

- `hemmabo_search_properties` — find host-owned properties by place and dates
- `hemmabo_search_availability` — check availability
- `hemmabo_search_similar` / `hemmabo_compare_properties` — decision support
- `hemmabo_booking_quote` — a non-binding price quote
- `get_verified_stay_offer` — fetch the host-domain, Ed25519-signed VRP stay offer
- `verify_vacation_rental_node` — verify a node's signature against its domain
- `hemmabo_host_readiness_check` / `hemmabo_host_onboarding_link` — host onboarding

The booking lifecycle tools (create, checkout, reschedule, cancel, status) return
personal data and therefore stay behind authentication; they are **not** part of a
no-auth connection. Connect them only if you need agent-driven booking (see
[Optional: OAuth 2.0](#optional-oauth-20-for-booking-tools)).

---

## Prerequisites (on your Google Cloud side)

Done once by a Google Cloud admin of your Gemini Enterprise project:

1. Grant yourself the **Discovery Engine Editor** role (`roles/discoveryengine.editor`).
2. Ensure the **org policy** that blocks custom MCP creation is overridden for the project.
3. Add `www.hemmabo.com` to the **egress FQDN allowlist** so the connector can reach the server.

## Setup steps

1. In the Google Cloud console, open **Gemini Enterprise → Data stores → Create data store**.
2. Search for and select **Custom MCP Server (Preview)**.
3. **Authentication method:** choose **No Authentication**.
4. **MCP Server URL:** enter `https://www.hemmabo.com/mcp`.
5. **Server description:** e.g. *"HemmaBo — discover and verify host-owned
   vacation-rental nodes and their signed VRP stay offers. Not an OTA; a trust
   and discovery layer."*
6. **Connector config:** pick a data location (Multi-region), name the connector,
   and click **Create**.
7. When the data store reaches **Active**, **reload custom actions** and enable the
   HemmaBo tools you want (the tool list above).

That's it. An agent in your workspace can now, for example, search for a stay,
call `get_verified_stay_offer` for the chosen host domain, and route the guest to
the signed direct-booking URL on the host's own domain.

---

## Verify it works

- `GET https://www.hemmabo.com/mcp` returns `{"status":"ok","transport":"streamable-http",...}`.
- A `tools/list` JSON-RPC call returns the tool set above.

## Optional: OAuth 2.0 (for booking tools)

If you need the authenticated tools (booking create/checkout/etc.), choose
**OAuth 2.0** in step 3 instead of No Authentication and provide HemmaBo's
authorization and token URLs, client ID, and client secret. HemmaBo supports the
OAuth 2.0 authorization-code flow with Dynamic Client Registration; contact
HemmaBo to provision credentials. For discovery and verification alone, No
Authentication is sufficient and simpler.

## Troubleshooting

- **"SSE not supported" / transport error:** none expected — HemmaBo speaks
  Streamable HTTP. Confirm you entered the `/mcp` URL, not a legacy SSE path.
- **Connector cannot reach the server:** confirm `www.hemmabo.com` is on the
  egress FQDN allowlist.
- **Redirect / empty response:** use the `www.` URL, not the apex.
- **No tools appear:** ensure the data store is **Active**, then reload and enable
  custom actions (Gemini Enterprise limits to 100 simultaneously; HemmaBo exposes 15).

---

*HemmaBo is the reference implementation of the open Vacation Rental Protocol
(VRP), <https://vacationrentalprotocol.com>. It is a trust and discovery layer —
not an OTA, marketplace, or booking intermediary. Host nodes own the booking
lifecycle; Stripe owns payment facts.*
