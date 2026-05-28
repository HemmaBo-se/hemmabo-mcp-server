# ChatGPT Apps submission — HemmaBo

This folder contains everything the CEO needs to fill the OpenAI Apps submission form. All values are derived from production endpoints in this repo (`hemmabo-mcp-server`). Nothing in `hemmabo-smart-stays` is required for submission.

## What to upload to the form

The OpenAI submission form (App Info → MCP Server → Testing → Screenshots → Global → Submit) accepts a `chatgpt-app-submission.json` file that pre-fills most fields. **Drag [chatgpt-app-submission.json](./chatgpt-app-submission.json) into the upload area at the top of the form.**

## Form-field mapping (manual fallback if the upload field is unavailable)

| Form field | Value | Source |
|---|---|---|
| **Logo (Light)** | Upload `./icon.png` (PNG, 27 891 bytes, square) | repo root |
| **Logo (Dark)** | Optional. Same file works on dark backgrounds. | — |
| **App Name** | `HemmaBo` | submission JSON `app.name` |
| **Subtitle (≤30 chars)** | `Direct booking. 0% commission.` (30 chars) | submission JSON `app.subtitle` — lifts moat positioning (0% commission) over generic product description |
| **Description** | See `app.description` in submission JSON | mirrored from `/.well-known/mcp.json` |
| **Categories** | Travel, Lodging | from manifest |
| **Privacy policy URL** | https://www.hemmabo.com/privacy | verified 200 |
| **Terms of Service URL** | https://www.hemmabo.com/terms | verified 200 |
| **Developer name** | HemmaBo AB | manifest |
| **Developer email** | support@hemmabo.com | manifest |
| **MCP Server URL** | `https://hemmabo-mcp-server.vercel.app/mcp` | live, transport: streamable-http |
| **Auth** | OAuth 2.0, `client_credentials`, token endpoint `https://hemmabo-mcp-server.vercel.app/oauth/token` | api/oauth.ts |
| **Test prompts** | 5 prompts in submission JSON `test_prompts` (matches sample_prompts in manifest) | api/mcp-manifest.ts |

⚠ **Subtitle note**: the manifest description is the long version. The form's 30-char subtitle is a shortened variant — keep both in sync if the long form changes.

## Public endpoints (verified live)

| Endpoint | Status | Purpose |
|---|---|---|
| https://hemmabo-mcp-server.vercel.app/health | 200 | Server liveness |
| https://hemmabo-mcp-server.vercel.app/mcp | streamable-http | MCP JSON-RPC |
| https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json | 200 | Discovery manifest |
| https://hemmabo-mcp-server.vercel.app/icon.png | 200, image/png, 27.9 KB | App logo |
| https://hemmabo-mcp-server.vercel.app/oauth/token | 200 | OAuth client_credentials |
| https://hemmabo-mcp-server.vercel.app/oauth/register | **500 ⚠** | Dynamic client registration (broken — disclosed, does not block submission) |

## Demo credentials

Not strictly required — `tools/list`, `resources/read`, `prompts/list` are all open and reviewers can inspect the full app surface without auth.

If reviewers want to exercise `tools/call` end-to-end (search → quote → checkout): request a temporary OAuth client via support@hemmabo.com. The live test property `villaakerlyckan.se` is real; checkout uses Stripe test mode on the review tier.

## Test prompt set (matches manifest `sample_prompts`)

1. *"Find a pet-friendly villa in Sweden for 6 guests in July"* -> `hemmabo_search_properties` -> verified stay offer widget
2. *"Show me direct-booking vacation rentals in Skane for August 2026"* -> `hemmabo_search_properties` -> verified stay offer widget shows villaakerlyckan.se
3. *"What's the price for Villa Akerlyckan for 4 guests, 5 nights starting 2026-08-10?"* -> `hemmabo_search_properties` + `hemmabo_booking_quote`
4. *"Compare these properties on the same dates and book the cheapest one"* -> `hemmabo_compare_properties` -> `hemmabo_booking_negotiate` -> `hemmabo_booking_checkout`
5. *"I need to cancel booking abc-123 - what's the refund?"* -> `hemmabo_booking_status` -> `hemmabo_booking_cancel`

## Open issue disclosed in submission

`/oauth/register` returns HTTP 500 (Supabase insert failure). Apps SDK does not depend on RFC 7591 DCR — connectors are pre-provisioned via OpenAI's flow, so this does not block submission. Tracked separately.

## Repo discipline

- All submission artifacts live in this folder (`submission/`).
- `hemmabo-smart-stays` is **not** touched. Screenshots for OpenAI review must come from the live ChatGPT App response after the widget renders, not from a static mock.
