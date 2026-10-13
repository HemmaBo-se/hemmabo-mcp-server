# ADR 0020: On /mcp/chatgpt the widget presents; the model reads one line and the facts

- Status: Accepted (CEO decision, 2026-10-12)
- Date: 2026-10-12
- Decides for: the ChatGPT surface — `www.hemmabo.com/mcp/chatgpt`
  (`serve(..., "chatgpt")` in `api/mcp.ts`), every tool on that surface whose
  definition carries `openai/outputTemplate`, and the widget resource it serves.
- Not touched: `/mcp` and every other surface. Clients without a widget read
  the full result, including `agent_guardrails`.

## Context

On 2026-10-12 a guest asked the published ChatGPT app for a VRP stay in Skåne.
ChatGPT drew a card of its own above the HemmaBo widget: the right name, dates
and signed total, and three photos of another house. The HemmaBo widget came
last, with the host's own photo and the same total.

Our own result asked for that card. `vrp_get_verified_stay_offer` returned the
same 20 KB twice (`content` and `structuredContent`) with orders to the model:
`guest_welcome` ("relay … VERBATIM"), `verified_source_line` ("After quoting
the price, relay this line … VERBATIM"), `tone_rule` ("Introduce the stay
warmly"), `price_claim_rule` ("Quote price.agent_total …"). The server
instructions said the opposite ("do not restate price, dates, or sleeps already
shown in the widget"). A tool result is the last and most specific text the
model reads, so it won. The photos did not come from us: the result carried
only the host's five photos, which ChatGPT did not use.

The OpenAI Apps SDK reference separates the two readers: `content` and
`structuredContent` reach the model and the component; `_meta` reaches only
the component; `openai/widgetDescription` exists to reduce redundant narration.

## Decision

On `/mcp/chatgpt`, for every tool that renders a widget:

1. `content` is one line, and the widget resource's `openai/widgetDescription`
   is the same line (`CHATGPT_WIDGET_MODEL_LINE`, `lib/apps-widget.ts`):
   «HemmaBo's widget shows this verified offer: the host's own photos, dates,
   guests, signed total and the booking button. Write at most two sentences.
   Do not repeat these details, and do not add images or a card of your own.»
2. `structuredContent` is a short summary for the guest's follow-up questions:
   verified, name and place, dates, guests, signed total, booking URL, facts
   (amenities, policy claims, stay details, refund schedule, terms, minimum
   age) and `blocked_claims`. It carries no image URL and no order to present,
   quote, introduce or relay anything. `blocked_claims` stay: each one is a
   prohibition ("Do not …").
3. The full result — photos, guest welcome, every rule — reaches the widget
   only in `_meta["hemmabo/widget"]`. The widget reads it there first.
4. A widget tool has a model view in `lib/chatgpt-surface.ts`
   (`WIDGET_TOOL_MODEL_VIEW`), or the contract test fails.

Search gives the model no price at all: since 7.0.0 `hemmabo_search_properties`
is price-free on every surface (ADR 0019, amendment 2026-10-12).

Amendment 2026-10-13 (CEO decision): on `/mcp/chatgpt` the search result also
carries no `signalsGuidance`. That key told the model how to speak ("relay
those as a clear, friendly no", "warm and plain", "never call it a perfect
match"): a presentation order, not a fact, and the last thing the model read
after the server instructions. The `signals` themselves stay on every
property, and `agentGuidance` stays: it carries the no-ranking rule and the
next tool call. `/mcp` is not shaped (`shapeChatgptToolResult`,
`lib/chatgpt-surface.ts`, `SEARCH_MODEL_OMIT`).

`guest_welcome` is CEO-locked copy and is unchanged. It stays on the node and
in the widget payload; the model on this surface is no longer ordered to say
it. Its "this page" is the host's page, which the guest reaches through the
widget's button.

The widget templates carry no demo data and no node of their own: the
`?demo=1` and `?data=` paths, the demo offer and the fallback photo of one
node are gone from every widget URI.

## Consequences

- Measured on the production result of 2026-10-12 (6.0.1) for Villa
  Åkerlyckan, 14–16 Feb 2027, 2 guests, shaped by this change: what the model
  reads (`content` plus `structuredContent`) goes from 37 934 to 3 404
  characters; "VERBATIM", "relay", "introduce" and "quote" from 46 matches to
  2, both inside `blocked_claims` prohibitions; image URLs from 22 to 0. The
  widget renders pixel-identical from `_meta`.
- `src/chatgpt-widget-model-text.contract.test.ts` fails when a widget tool on
  this surface hands the model "VERBATIM", "relay", "introduce", "quote" (in a
  key or a value, outside `blocked_claims`) or an image URL — including a
  change in `lib/vrp.ts` that reaches the summary.
- The tool result text changed: OpenAI Rescan after deploy.
- No text can force ChatGPT's own rendering. If ChatGPT still draws its own
  card, the next step is a shorter model view, not more instructions.
