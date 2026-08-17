# Directory Submission Kit — HemmaBo + VRP visibility

> **CORRECTION 2026-07-29 (supersedes the 2026-07-27 note):** Canonical facts are
> **13 runtime tools (9 HemmaBo federation + 2 host onboarding + 2 VRP verification)**,
> version **4.0.1**, endpoint **https://www.hemmabo.com/mcp**, **12 languages**. The
> stale "15 runtime tools / 11 federation" and "3.2.16" values that had been left in
> the body (2026-07-13 history) are now **swept to canonical throughout this doc**.
> Verified against live bytes 2026-07-29: npm `hemmabo-mcp-server@4.0.1`, `glama.json`
> version 4.0.1, code = 13 tools (9+2+2). Any line telling you never to reuse "13 tools"
> is SUPERSEDED — 13 is canonical (a different 13 than the May-2026 composition).

Date: 2026-07-13 (facts swept current 2026-07-29)
Scope: discovery/metadata only. No runtime booking logic, no new MCP tools,
no new registry identities (ADR 2026-05-16 single-source, ADR 0004 lockstep).

This kit gives the CEO copy-paste-ready, guardrail-vetted listing copy for
every directory in the current visibility push, plus a tracker of what is
already live, what is staged, and what needs a human on a form. Most of these
directories require an account + CAPTCHA, so — like the ChatGPT Apps kit in
`submission/` — the agent prepares, the CEO submits.

## Canonical facts (use these, never older values)

| Fact | Value |
|---|---|
| Product | HemmaBo — https://www.hemmabo.com |
| Protocol | Vacation Rental Protocol (VRP) — https://vacationrentalprotocol.com |
| Canonical repo | https://github.com/HemmaBo-se/hemmabo-mcp-server |
| NPM | `hemmabo-mcp-server@4.0.1` |
| Canonical remote MCP | `https://www.hemmabo.com/mcp` (streamable-http) |
| Registry identity | `com.hemmabo/hemmabo-mcp-server` (owned by this repo only) |
| Tool surface | 13 runtime tools: 9 HemmaBo federation tools, 2 host onboarding tools, 2 VRP verification tools |
| Languages | 12 languages (Konversa guest chat) |
| License | Apache-2.0 |
| Live reference host | https://www.villaakerlyckan.se |

`check-facts-drift.sh` guards the live surfaces; every submission must agree
with these values. "11 languages" is stale — never reuse it. "15 runtime tools /
11 federation" and version "3.2.16" are stale — never reuse them; 13 = 9+2+2 and
version is 4.0.1.

## Red lines — apply to EVERY listing, every platform

Required framing (**claim authority, never cheaper**):

- ✅ "official direct source", "host-owned", "0% booking commission",
  "one all-inclusive total", "host-domain signed verified stay offers",
  "Not an OTA. Not a marketplace."
- ✅ VRP first-mover claims hedged: "to our knowledge, the first …"

Forbidden in any submission, tag, category answer, or screenshot caption:

- ❌ "cheaper than Airbnb/Booking", "save X% vs OTA", "best deals",
  "compare prices", any guest-savings framing
  (`must_not_invent_discounts`, `must_not_claim_ota_comparison_without_signed_ota_price`)
- ❌ positioning HemmaBo as a search portal, marketplace, or aggregator
- ❌ advertising anything not verifiably live in production
- ❌ a second MCP registry identity or duplicate listing where an existing
  HemmaBo listing can be claimed/synced (2026-05-19 registry audit)

Note on AlternativeTo-style platforms: listing HemmaBo as an *alternative for
hosts* to OTA distribution is fine — that is a software-category statement.
The copy still claims authority (own domain, 0% commission), never price
comparison for guests.

## Locked copy blocks (English)

**Name:** `HemmaBo`

**Subtitle / tagline (≤30 chars):** `Verified stay offers`

**Tagline (≤60 chars):**
`Host-owned direct booking for vacation rentals. Not an OTA.`

**One-liner (≤100 chars — matches live official-registry description):**
`Host-owned vacation-rental direct booking via VRP. Signed offers, 0% commission. Not an OTA.`

**Short description (~350 chars — TAAFT, Toolify, launch platforms):**
> HemmaBo is the host-owned trust layer for vacation rentals. Every host runs
> 0%-commission direct bookings on their own domain, with host-signed,
> agent-verifiable stay offers (VRP · Ed25519/JWKS) that AI agents can
> discover, verify, and book directly — via MCP. One all-inclusive total.
> Not an OTA, not a marketplace.

**Long description (Capterra, G2, directories with room):**
> HemmaBo is AI-native booking infrastructure for independent vacation-rental
> hosts. Each host runs a full booking engine on their **own domain** — the
> official direct source for that property — with live availability, exact
> all-inclusive pricing, Stripe payments, guest wallet, and multilingual guest
> chat (12 languages). 0% booking commission.
>
> HemmaBo speaks the Vacation Rental Protocol (VRP), an open protocol for
> host-domain-signed stay offers: an AI agent discovers the property on the
> open web, fetches a cryptographically signed offer (Ed25519, did:web) from
> the host's own domain, verifies it against the domain's JWKS, and books
> directly — no central marketplace, registry, or gatekeeper. The HemmaBo MCP
> server (`hemmabo-mcp-server`, Apache-2.0) exposes 13 runtime tools —
> 9 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification
> tools — so agents can search published properties, check availability, get
> verified stay offers, and route guests to the host's own booking URL.
> Alongside VRP, HemmaBo supports UCP discovery, ACP checkout, and AP2 Cart
> Mandate verification.
>
> HemmaBo is not an OTA, not a marketplace, and not a website builder. The
> host's domain is the source of truth; HemmaBo verifies, synchronizes, and
> enforces the technical paths that let agents trust it.

**Categories:** AI Agents · Travel Tech · Vacation Rental Software ·
SaaS Tools for Hosts · Booking Engine · Hospitality

**Keywords:** MCP, Model Context Protocol, VRP, Vacation Rental Protocol,
direct booking, host-owned nodes, 0% commission, signed offers, Ed25519,
AI agents, agent-verifiable, booking engine, short-term rental, own domain

**VRP block (for listings/posts about vacationrentalprotocol.com):**
> The Vacation Rental Protocol (VRP) is an open protocol for
> host-domain-signed vacation-rental offers — to our knowledge the first of
> its kind. An AI agent discovers a property on the open web, fetches a
> cryptographically signed (Ed25519, did:web) stay offer from the host's own
> domain, verifies it against the domain's JWKS, and books directly. No
> central marketplace, registry, or gatekeeper. Created by Rouiada Abbas;
> anyone may implement it; HemmaBo is the reference implementation. Spec and
> conformance vectors: vacationrentalprotocol.com · github.com/HemmaBo-se/vrp-spec

## Status tracker

Verified from this session on 2026-07-13 unless noted; version/tool-count refs
swept to canonical (4.0.1 / 13 tools) 2026-07-29. The sandbox network policy
blocks fetching pulsemcp.com / mcp.so / hemmabo.com directly (proxy 403) —
those rows must be eyeball-verified from a normal browser.

### MCP surfaces (highest leverage — agents look here first)

| Surface | Status 2026-07-13 | Next action |
|---|---|---|
| Official MCP Registry | ✅ **Live** — `com.hemmabo/hemmabo-mcp-server`; `@3.2.16` was `isLatest` when verified 2026-07-13, now `@4.0.1`. | None. Re-publish only on version bump. |
| Glama | `glama.json` version 4.0.1 in repo | Browser-verify listing renders 4.0.1 copy (13 tools). |
| Smithery | `smithery.yaml` + republish receipt 2026-05-19 | Browser-verify listing is on current positioning (13 runtime tools). |
| PulseMCP | Mirrors official registry (2026-05-19 audit) | Verify it picked up 4.0.1; only if not mirrored after ~a week, submit the canonical record manually. **No duplicate listing.** |
| MCP.so | ⚠️ Stale (old tool names, old repo ref) per 2026-05-19 audit | Send the support/update text from `2026-05-19-pulse-mcpso-registry-audit.md` (update its version refs to 4.0.1 / 13 runtime tools first). **No duplicate listing.** |
| mcpservers.org | Not listed (unverified from sandbox) | Submit canonical record (copy blocks above). |
| Docker MCP Registry | 🟠 **Submitted upstream, in review** — upstream PR [docker/mcp-registry#4413](https://github.com/docker/mcp-registry/pull/4413) (opened 2026-07-13 from fork branch `claude/hemmabo-directory-submissions-amz280`; reviewers `@docker/ai-tools-team` pinged 2026-07-18; two unchecked template tasks are N/A for remote servers). Duplicate fork PR #2 closed 2026-07-13. `cmd/validate` all green 2026-07-19; icon proven serving (HTTP 200, image/png) via Vercel. **Not yet published**: awaiting maintainer review. | Wait for Docker review; respond to reviewer comments on #4413. Do NOT open a second upstream PR (duplicate). |
| awesome-mcp-servers (punkpeye) | ✅ **Live & merged** — upstream PR [punkpeye/awesome-mcp-servers#8863](https://github.com/punkpeye/awesome-mcp-servers/pull/8863) merged 2026-07-12; line verified present in upstream `README.md` (line ~3096, Travel & Transportation) against raw bytes 2026-07-19. | None. Do NOT resubmit (duplicate). Fork PR #1 can be closed as superseded. |
| IANA well-known URI registry (RFC 8615) | 🟠 **In expert review — aligning to `vacation-rental.json`** — issue [protocol-registries/well-known-uris#93](https://github.com/protocol-registries/well-known-uris/issues/93) (opened 2026-06-19 by HemmaBo-se; Provisional; change controller "Vacation Rental Protocol (VRP) — Rouiada Abbas"). Reviewer mnot (Mark Nottingham) asked 2026-08-17 to align the request to the spec, which defines the suffix as `vacation-rental.json`; the request is being aligned to that. Live example verified serving 2026-08-17: `villaakerlyckan.se/.well-known/vacation-rental.json` → HTTP 200 JSON (the older `…/vacation-rental-protocol.json` stays served as a back-compat alias). | Reply in-place on #93 confirming the suffix `vacation-rental.json` + spec reference `https://vacationrentalprotocol.com/spec/well-known-uri-v0.1` (source repo: `github.com/vacationrentalprotocol/vrp-spec`). Do NOT open a second registration issue — update #93 only. Note: `vacation-rental-protocol` is the protocol *name*, not the file suffix. |
| ChatGPT Apps | 🟠 **Submitted, in review** — submission 1.0 came back with change requests; the updated submission (2.0) is resubmitted and **in review** (CEO-verified against the OpenAI dashboard 2026-07-22). App id: `asdk_app_69fccc58e3088191a22cffe6fd5ad075` (see `submission/`). Note: the OpenAI *platform project id* (`proj_…`, from platform.openai.com settings) is a different identifier — never quote it as the app id. | Await OpenAI verdict; respond to reviewer feedback in the existing submission. Do NOT open a parallel new app (duplicate). |

### AI-tool directories (Tier 1 — manual form, use short description)

TAAFT (theresanaiforthat.com) · Future Tools (futuretools.io) · Toolify AI ·
Dang AI · AI Tool Hunt · Insidr.ai

- All GO. Human submits (account + CAPTCHA). Use: name, tagline,
  short description, categories, keywords, icon
  `https://hemmabo-mcp-server.vercel.app/icon.png`, link `https://www.hemmabo.com`.
- Where a "what makes it different" field exists: the VRP block.

### SaaS review directories (Tier 2 — long description)

Capterra · Software Advice · GetApp (one Gartner vendor account covers all
three) · G2 · AlternativeTo · SaaSHub · TrustRadius

- All GO with the long description. Category: Vacation Rental Software.
- AlternativeTo: list as alternative to OTA *distribution tooling* for hosts;
  authority framing only (see red-line note above).
- Review sites will solicit host reviews — never incentivize with discounts
  invented for the occasion; pricing changes are a CEO decision.

### Launch platforms (Tier 3)

BetaList · Indie Hackers ("Show IH" post) · Uneed · MicroLaunch · Fazier ·
Hacker News (Show HN)

- All GO. Short description + VRP block as the story. For HN/IH the honest
  technical angle is the strongest: "host-domain-signed offers agents can
  verify" — first-mover claims hedged with "to our knowledge".
- Show HN timing: check whether one was already posted before firing again.

### Human/social channels (Tier 4 — not agent work)

Reddit (r/SaaS, r/indiehackers, r/vacationrentals, r/Airbnb_hosts,
r/ShortTermRental) · LinkedIn · X (#MCP #AIagents)

- Value-first posts written by a human; red lines apply verbatim (a Reddit
  comment claiming "cheaper than Booking" breaks the price contract as much
  as a landing page would).

### Requires CEO decision first — do not act

- **AppSumo / deal platforms:** a discounted host-plan deal is a pricing +
  positioning decision (discount framing near the brand). STOP → present
  A/B/C to the CEO before any listing is drafted.

## Order of attack (recommended)

1. Docker MCP Registry upstream PR (staged, 5 minutes) + MCP.so update
   request (copy ready) — these feed agent ecosystems directly.
2. TAAFT + Capterra (Gartner account also unlocks Software Advice/GetApp).
3. BetaList + Indie Hackers post.
4. Remaining Tier 1/2/3 as time allows; verify Glama/Smithery/PulseMCP
   render 4.0.1 (13 tools) while at it.

Every submission gets a receipt: date, platform, URL of the live listing,
copy variant used — appended to this file or a sibling ops doc, only after
fetching the live listing and reading the bytes.
