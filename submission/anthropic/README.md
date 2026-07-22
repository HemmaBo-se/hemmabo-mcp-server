# Anthropic Connectors Directory — submission prep

**Prepared:** 2026-07-22 · per hemmabo-smart-stays
`docs/DECISIONS/2026-07-22-agent-surface-order-and-spt-reopen.md` (track A3).
**Status:** Prep only — NOT submitted. See the plan gate below.

## Venue search (charter rule: venue first, never our notes)

Searched 2026-07-22 (web index of the directory + third-party directory
mirrors: aitoolsreview.co.uk complete directory July 2026, bloomberry.com
company list, awesome-claude-connectors): **no existing HemmaBo entry found.**
Sandbox egress blocks claude.ai/claude.com pages, so before ANY submission:
eyeball-verify https://claude.ai/connectors (search "HemmaBo", "vacation
rental", "VRP") from a normal browser — same practice as the other venue rows
in `docs/operations/2026-07-13-directory-submission-kit.md`.

## The plan gate (verified 2026-07-22, secondary sources quoting official docs)

- **Remote MCP directory submissions happen in the Claude.ai submission
  portal inside ADMIN SETTINGS — available only to Team or Enterprise
  organizations.** Individual plans (Free/Pro/Max) have no admin settings, so
  a solo account cannot submit a remote-MCP connector to the directory today.
  By default only org Owners submit/manage listings.
  Sources: claude.com/docs/connectors/building/submission (via search
  summaries; direct fetch blocked), support.claude.com article 11596036.
- **Custom connectors are NOT gated on Team:** any paid plan (Pro/Max/Team/
  Enterprise) can add this server manually via Settings → Connectors → Add
  custom connector. The ADR 0003 acceptance test (add custom connector
  against production, screenshot into this folder) is therefore runnable on
  the CEO's existing solo plan — no purchase needed.
- **Desktop extensions (MCPB) use a separate submission form** (not the
  admin portal). Reach is Claude Desktop only, and packaging a desktop
  bundle around a remote-only server contradicts the remote-only decision in
  ADR 0003/README — investigate before pursuing. Not recommended as primary.
- Escalation/questions channel per docs: mcp-review@anthropic.com.

**Decision needed (CEO):** submit via a Team org when budget allows (the org
is needed to submit and manage the listing), or hold A3 and keep priority on
the ChatGPT app review (already in review, no extra cost). Recorded as an
open cost gate — do not buy seats just for this without weighing it.

## Pre-submission checklist (review criteria per docs; gaps are blockers)

- [ ] Venue re-search on submission day (see above).
- [ ] **Privacy policy URL** — missing/incomplete privacy policy is an
      immediate rejection. Verify a public privacy policy exists and covers
      the MCP data flows.
- [ ] Documentation URL (public, current 15-tool list).
- [ ] Support channel (e.g. info@hemmabo.se or a support page).
- [ ] Icon (`https://hemmabo-mcp-server.vercel.app/icon.png` — proven
      serving HTTP 200 image/png 2026-07-19).
- [ ] Test account credentials for the reviewer.
- [ ] **Allowed link URIs** — the server returns host-domain
      `direct_booking_url`s; list the host-domain patterns so users are not
      prompted per-link.
- [x] OAuth 2.1 flow — DCR (`/oauth/register`) confirmed 2026-07-22: a
      Claude.ai-shaped RFC 7591 payload (`redirect_uris`,
      `grant_types: [authorization_code, refresh_token]`,
      `token_endpoint_auth_method: none`) returns **HTTP 201** with a valid
      client_id/client_secret. The earlier "400 on smoke test" note (ChatGPT
      kit) was a stale/incorrect record, not a live defect — corrected in
      `submission/README.md`. Non-JSON `Content-Type` bodies now return a
      clear `invalid_request` error instead of a confusing
      `invalid_client_metadata` (hardened same day). Still needed before
      submission: authorization_code + PKCE exercised end-to-end through
      `/oauth/authorize` and `/oauth/token` (DCR alone does not prove the
      full flow).
- [ ] ADR 0003 acceptance test: "Add custom connector" in Claude.ai against
      `https://www.hemmabo.com/mcp`, screenshot saved in this folder.
- [ ] Tool annotations accurate (read-only vs mutating) — reviewer checks
      against actual behavior; our 11+2+2 split and anon/Bearer split are
      documented in `lib/tool-definitions*.ts` and README.

## Form-field draft (reuse canon copy — do not rewrite)

- **Name:** HemmaBo
- **Category:** Travel
- **MCP URL:** `https://www.hemmabo.com/mcp` (streamable-http)
- **Auth:** OAuth 2.1 authorization_code + PKCE + DCR (RFC 7591), discovery
  per RFC 8414/9728; 9 tools work anonymous, booking mutations require auth.
- **Short description:** use the canonical short description from
  `docs/operations/2026-07-13-directory-submission-kit.md` (same copy as the
  other venues — zero drift).
- **What makes it different:** the VRP block from the same kit (host-domain
  signed offers, verifiable by the agent; no OTA, no ranking, 0% commission
  on stays).
