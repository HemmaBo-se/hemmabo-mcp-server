# ChatGPT Apps submission — HemmaBo

This folder contains everything the CEO needs to fill the OpenAI Apps submission form. All values are derived from production endpoints in this repo (`hemmabo-mcp-server`). Nothing in `hemmabo-smart-stays` is required for submission.

## What to upload to the form

The OpenAI submission form (App Info → MCP Server → Testing → Screenshots → Global → Submit) accepts a `chatgpt-app-submission.json` file that pre-fills most fields. **Drag [chatgpt-app-submission.json](./chatgpt-app-submission.json) into the upload area at the top of the form.**

## Form-field mapping (manual fallback if the upload field is unavailable)

| Form field | Value | Source |
|---|---|---|
| **Logo (Light)** | Upload `./icon.png` (PNG, 27 891 bytes, square) | repo root |
| **Logo (Dark)** | Optional. Same file works on dark backgrounds. | — |
| **App Name** | `HemmaBo` | submission JSON `app_info.display_name` |
| **Subtitle (<=30 chars)** | `Verified stay offers` (20 chars) | submission JSON `app_info.subtitle` |
| **Description** | See `app_info.description` in submission JSON | canonical HemmaBo + VRP positioning from repo SoT |
| **Categories** | Travel | submission JSON `app_info.category` |
| **Privacy policy URL** | https://www.hemmabo.com/privacy | verified 200 |
| **Terms of Service URL** | https://www.hemmabo.com/terms | verified 200 |
| **Developer name** | HemmaBo AB | manifest |
| **Developer email** | support@hemmabo.com | manifest |
| **MCP Server URL** | `https://hemmabo-mcp-server.vercel.app/mcp` | live, transport: streamable-http |
| **Auth** | OAuth 2.0, `client_credentials`, token endpoint `https://hemmabo-mcp-server.vercel.app/oauth/token` | api/oauth.ts |
| **Test cases** | 13 positive test cases and 5 negative test cases in submission JSON | generated from the live tool surface |

⚠ **Subtitle note**: the manifest description is the long version. The form's 30-char subtitle is a shortened variant — keep both in sync if the long form changes.

## Public endpoints (verified live)

| Endpoint | Status | Purpose |
|---|---|---|
| https://hemmabo-mcp-server.vercel.app/health | 200 | Server liveness |
| https://hemmabo-mcp-server.vercel.app/mcp | streamable-http | MCP JSON-RPC |
| https://hemmabo-mcp-server.vercel.app/.well-known/mcp.json | 200 | Discovery manifest |
| https://hemmabo-mcp-server.vercel.app/icon.png | 200, image/png, 27.9 KB | App logo |
| https://hemmabo-mcp-server.vercel.app/oauth/token | 200 | OAuth client_credentials |
| https://hemmabo-mcp-server.vercel.app/oauth/register | **201 — confirmed 2026-07-22** with an RFC 7591-shaped payload (`client_name`, `redirect_uris`, `grant_types: [authorization_code, refresh_token]`, `token_endpoint_auth_method: none`) | Dynamic client registration works for the authorization_code flow (Claude.ai-shaped requests) |

## Demo credentials

Not strictly required — `tools/list`, `resources/read`, `prompts/list` are all open and reviewers can inspect the full app surface without auth.

If reviewers want to exercise `tools/call` end-to-end (search → quote → checkout): request a temporary OAuth client via support@hemmabo.com. The live test property `villaakerlyckan.se` is real; checkout uses Stripe test mode on the review tier.

## Test case set

The submission JSON now includes one positive test case for each exposed MCP tool:

1. `hemmabo_search_properties`
2. `hemmabo_search_availability`
3. `hemmabo_booking_quote`
4. `hemmabo_search_similar`
5. `hemmabo_compare_properties`
6. `verify_vacation_rental_node`
7. `get_verified_stay_offer`
8. `hemmabo_booking_create`
9. `hemmabo_booking_negotiate`
10. `hemmabo_booking_checkout`
11. `hemmabo_booking_status`
12. `hemmabo_booking_reschedule`
13. `hemmabo_booking_cancel`

## Open issue disclosed in submission — RESOLVED 2026-07-22

An earlier smoke test recorded `/oauth/register` returning HTTP 400 and this
note advised against relying on it. Re-tested 2026-07-22 with a correctly
RFC 7591-shaped payload (the exact shape Claude.ai sends): the endpoint
returned **HTTP 201** with a valid `client_id`/`client_secret` pair. The
earlier 400 was not reproduced against a spec-conformant request — code
review of `api/oauth-register.ts` confirms every 400 branch is a documented
RFC 7591 validation (missing `client_name`, unsupported `grant_type`, missing
`redirect_uris` for `authorization_code`, etc.), so the most likely explanation
is that the earlier smoke test sent an incomplete or malformed payload, not a
server defect. Dynamic client registration is confirmed safe to rely on for
Claude.ai / Anthropic connector onboarding.

**Still worth doing, not a submission blocker:** the handler assumes the
request body is already-parsed JSON; a non-JSON `Content-Type` on an
incoming request would currently surface as a generic `invalid_client_metadata`
400 rather than a clear "send `Content-Type: application/json`" error. Minor
hardening, tracked separately — does not affect ChatGPT Apps or Claude.ai
submissions, both of which send correct headers.

## Repo discipline

- All submission artifacts live in this folder (`submission/`).
- `hemmabo-smart-stays` is **not** touched. Screenshots for OpenAI review must come from the live ChatGPT App response after the widget renders, not from a static mock.
