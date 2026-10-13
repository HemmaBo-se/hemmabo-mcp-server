/**
 * The /mcp/chatgpt surface: what the model reads (ADR 0020).
 *
 * A tool result is the last and most specific text the model reads, so it
 * outranks the server instructions. On this surface the stay-offer widget
 * presents the offer. The model gets one line and a short summary for the
 * guest's follow-up questions; everything the widget shows travels only in
 * _meta, which ChatGPT hands to the widget and hides from the model.
 *
 * /mcp is not shaped here: clients without a widget need the full result.
 */
import { CHATGPT_WIDGET_MODEL_LINE } from "./apps-widget.js";
import type { ToolResult } from "./tools-base.js";

/** _meta key that carries the full result to the widget on this surface. */
export const WIDGET_PAYLOAD_META_KEY = "hemmabo/widget";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function pick(source: JsonRecord | null, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  if (!source) return out;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

/**
 * The verified offer as the model sees it: facts only. No images, no
 * presentation orders, no copy to relay; blocked_claims stays as the list of
 * claims the model must not make.
 */
function offerForModel(full: JsonRecord): JsonRecord {
  const summary = record(full.official_offer_summary);
  const property = record(summary?.property);
  const price = record(summary?.price);
  const blocked = record(full.agent_guardrails)?.blocked_claims;
  return {
    ...pick(full, ["domain", "checkIn", "checkOut", "guests", "verified", "fresh", "signature"]),
    property: pick(property, ["name", "city", "region", "country"]),
    ...pick(summary, ["available", "availability_reason", "bookable", "direct_booking_url", "valid_until"]),
    price: {
      ...pick(price, ["currency", "exact"]),
      total: price?.agent_total ?? price?.total ?? null,
    },
    facts: {
      ...pick(property, ["amenities", "starred_amenities"]),
      ...pick(summary, ["policy_claims", "stay_details", "refund_schedule", "terms", "minimum_guest_age"]),
      ...pick(record(summary?.source_authority), ["payment_recipient", "booking_model"]),
    },
    ...pick(full, ["agent_next_step"]),
    blocked_claims: Array.isArray(blocked) ? blocked : [],
  };
}

/**
 * Every tool on this surface that renders a widget, with what its model may
 * read. A widget tool missing here fails src/chatgpt-widget-model-text.contract.test.ts.
 */
const WIDGET_TOOL_MODEL_VIEW: Readonly<Record<string, (full: JsonRecord) => JsonRecord>> = {
  vrp_get_verified_stay_offer: offerForModel,
};

export const CHATGPT_WIDGET_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(WIDGET_TOOL_MODEL_VIEW));

/**
 * Keys of the search result the model on this surface does not read (ADR 0020,
 * amendment 2026-10-13): a presentation order, not a fact. `agentGuidance`
 * stays: it carries the no-ranking rule and the next tool call.
 */
const SEARCH_MODEL_OMIT: readonly string[] = ["signalsGuidance"];

/** The search result as the model sees it on this surface: the same JSON without the omitted keys. */
function shapeSearchResult(result: ToolResult): ToolResult {
  const [first, ...rest] = result.content;
  if (!first || first.type !== "text") return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return result;
  }
  const body = record(parsed);
  if (!body) return result;
  const shaped: JsonRecord = { ...body };
  for (const key of SEARCH_MODEL_OMIT) delete shaped[key];
  return { ...result, content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }, ...rest] };
}

export function shapeChatgptToolResult(toolName: string, result: ToolResult): ToolResult {
  if (result.isError) return result;
  if (toolName === "hemmabo_search_properties") return shapeSearchResult(result);

  const structured = record(result.structuredContent);
  if (!structured) return result;

  const modelView = WIDGET_TOOL_MODEL_VIEW[toolName];
  if (modelView) {
    return {
      ...result,
      content: [{ type: "text", text: CHATGPT_WIDGET_MODEL_LINE }],
      structuredContent: modelView(structured),
      _meta: { ...(result._meta ?? {}), [WIDGET_PAYLOAD_META_KEY]: structured },
    };
  }

  return result;
}

const OFFER_MODEL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Host domain that issued the signed offer." },
    checkIn: { type: "string", description: "Requested arrival date." },
    checkOut: { type: "string", description: "Requested departure date." },
    guests: { type: "integer", description: "Requested guest count." },
    verified: { type: "boolean", description: "True only when the host-domain offer signature and payload checks pass." },
    fresh: { type: "boolean", description: "True while the signed offer is within its validity window." },
    signature: { type: "object", description: "Ed25519/JWS verification details.", additionalProperties: true },
    property: { type: "object", description: "Name and place of the stay.", additionalProperties: true },
    available: { type: "boolean", description: "True when the host's node reports the dates and guest count as available." },
    availability_reason: { type: "string", description: "Why the stay is not available, when it is not." },
    bookable: { type: "boolean", description: "True when the signed offer is available, exact and carries a direct booking URL." },
    direct_booking_url: { type: "string", description: "The signed booking URL on the host's own domain." },
    valid_until: { type: "string", description: "When the signed offer expires." },
    price: { type: "object", description: "The signed total, in whole units of the property's currency.", additionalProperties: true },
    facts: { type: "object", description: "Facts from the signed offer and the host's node, for the guest's follow-up questions.", additionalProperties: true },
    agent_next_step: { type: "string", description: "The host's own open dates when the requested dates are not bookable." },
    blocked_claims: { type: "array", items: { type: "string" }, description: "Claims the agent must not make." },
    error: { type: "string" },
  },
  required: ["domain", "verified"],
  additionalProperties: true,
} as const;

/** The tool definition as tools/list shows it on this surface. */
export function chatgptToolDefinition<T extends { name: string; outputSchema?: unknown }>(tool: T): T {
  if (tool.name === "vrp_get_verified_stay_offer") return { ...tool, outputSchema: OFFER_MODEL_OUTPUT_SCHEMA };
  return tool;
}
