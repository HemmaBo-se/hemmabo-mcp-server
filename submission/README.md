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
| https://hemmabo-mcp-server.vercel.app/oauth/register | **400 on current smoke test** | Dynamic client registration needs separate review before relying on it for automated OAuth onboarding |

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

## Open issue disclosed in submission

`/oauth/register` returned HTTP 400 during the current smoke test. Do not rely on dynamic client registration for reviewer onboarding until this endpoint is fixed or confirmed with the exact OpenAI registration payload.

## Repo discipline

- All submission artifacts live in this folder (`submission/`).
- `hemmabo-smart-stays` is **not** touched. Screenshots for OpenAI review must come from the live ChatGPT App response after the widget renders, not from a static mock.
