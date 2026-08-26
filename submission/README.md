# ChatGPT Apps submission — HemmaBo (v2.0.1 lean resubmit)

This folder contains everything the CEO needs to fill the OpenAI Apps submission form. All values are derived from production endpoints in this repo (`hemmabo-mcp-server`). The only external precondition is the branded proxy line in `hemmabo-smart-stays` (PR #2568) so that `https://www.hemmabo.com/mcp/chatgpt` is live.

**This submission exposes exactly 3 read-only tools** (`hemmabo_search_properties`, `verify_vacation_rental_node`, `get_verified_stay_offer`) on the dedicated `/mcp/chatgpt` surface. No in-chat booking, checkout, payment, or host onboarding — anything transactional happens on the host's own website, outside ChatGPT. Do NOT point the form at `/mcp` (the full 13-tool federation surface): that is the surface the v2.0.0 rejection was about.

## Submission order (do these in sequence)

1. **Precondition:** `POST https://www.hemmabo.com/mcp/chatgpt` `tools/list` returns exactly 3 tools (requires smart-stays PR #2568 deployed).
2. **Portal save test:** in the draft's MCP details, enter the MCP Server URL below and save. If the form rejects it, STOP — screenshot the exact error verbatim, do not fall back to `/mcp`.
3. **Scan Tools:** expect exactly 3 tools and the `ui://hemmabo/verified-stay-offer-native-v1.html` UI output template (the template is what makes screenshots allowed).
4. Upload [chatgpt-app-submission.json](./chatgpt-app-submission.json) (drag into the upload area) or fill fields manually per the table below.
5. Screenshots + demo recording per the rules below.
6. Submit.

## Form-field mapping

| Form field | Value | Source |
|---|---|---|
| **Logo (Light)** | Upload `./icon.png` (PNG, 27 891 bytes, square) | repo root |
| **Logo (Dark)** | Optional. Same file works on dark backgrounds. | — |
| **App Name** | `HemmaBo` | submission JSON `app_info.display_name` |
| **Subtitle (<=30 chars)** | `Verified stay offers` (20 chars) | submission JSON `app_info.subtitle` |
| **Description** | See `app_info.description` in submission JSON | 3-tool verification-layer positioning |
| **Categories** | Travel | submission JSON `app_info.category` |
| **Privacy policy URL** | https://www.hemmabo.com/privacy | verified 200, server-rendered for bots |
| **Terms of Service URL** | https://www.hemmabo.com/terms | verified 200, server-rendered for bots |
| **Developer name** | HemmaBo | manifest — enskild näringsverksamhet, NOT an AB (see /terms §12) |
| **Developer email** | info@hemmabo.se | manifest, matches /terms §12 |
| **MCP Server URL** | `https://www.hemmabo.com/mcp/chatgpt` | dedicated ChatGPT surface — 3 read-only tools, commerce tools denied. Same host as the published v1 app (host must not change between versions); only the path is new. |
| **Auth** | **No Auth** | the surface is read-only and open; no sign-in means no demo-credentials obligation. Do NOT select OAuth for this surface. |
| **Test cases** | Exactly **5 positive + 3 negative** in submission JSON | OpenAI requires exactly 5/3; all 5 positive cases run through the 3 exposed tools only |

## Demo recording + screenshots (zero-tolerance rules)

- Record ONLY the 3 exposed tools: search → verify → verified stay offer → widget → handoff to the host's own website (villaakerlyckan.se).
- Never show booking/checkout/quote/onboarding tools, Stripe, or any payment step — they are not on this surface and demonstrating them re-files the v2 rejection.
- The booking link lands on the host's own property/offer page — never a checkout deeplink.
- Screenshots must come from the live widget rendering in ChatGPT Developer Mode — never from a static mock (the old `screenshot-property-cards.png` is retired for this reason).
- Do not deep-scroll the host site's photo gallery in the recording.

## Reviewer transparency note (include if the form has a notes field)

The same host also serves HemmaBo's full federation MCP server at `https://www.hemmabo.com/mcp` (the canonical registry surface for authenticated, non-ChatGPT deployments). The ChatGPT app points only at `/mcp/chatgpt`, which exposes 3 read-only discovery/verification tools, denies every other tool at `tools/call`, and describes exactly this 3-tool surface in its `initialize` response. Booking and payment always happen on the host's own website.

## Public endpoints (verified live)

| Endpoint | Status | Purpose |
|---|---|---|
| https://www.hemmabo.com/mcp/chatgpt | streamable-http, 3 tools | ChatGPT app MCP surface (the URL to submit) |
| https://www.hemmabo.com/privacy · /terms | 200 | Legal pages, server-rendered |
| https://hemmabo-mcp-server.vercel.app/health | 200 | Server liveness |
| https://hemmabo-mcp-server.vercel.app/icon.png | 200, image/png, 27.9 KB | App logo |

## Repo discipline

- All submission artifacts live in this folder (`submission/`).
- `src/submission-parity.contract.test.ts` machine-gates JSON ↔ live-surface parity (tool set, annotations, justifications, test-case coverage, no commerce language). Keep it green.
- Screenshots for OpenAI review must come from the live ChatGPT App response after the widget renders, not from a static mock.
