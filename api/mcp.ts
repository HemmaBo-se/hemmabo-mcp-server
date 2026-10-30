/**
 * HemmaBo Host Booking Engine — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All pricing/availability logic lives in lib/ — single source of truth.
 * This file only handles JSON-RPC transport + tool dispatch.
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call, prompts/list, prompts/get)
 *   GET  /mcp  — transport info; 405 when the client asks for an SSE stream
 *   HEAD /mcp  — transport liveness for uptime monitors
 *
 * Transport contract (ADR 0021, MCP Streamable HTTP): the Origin header is
 * validated on every request, the MCP-Protocol-Version header on every
 * non-preflight request, and every JSON-RPC envelope before dispatch. The
 * rules live in lib/mcp-transport.ts.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { executeTool, isHostOnboardingToolName, normalizeDateAliases, normalizeToolName } from "../lib/tools.js";
import { validateAuth } from "../src/auth.js";
import { anonIdentifier, bearerIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import { sanitizeParams, redactMessage } from "../lib/log-redact.js";
import { registerToolSchemas, validateToolArgs } from "../lib/validate-args.js";
import { OFFER_CHECK_AVAILABILITY_SENTENCE, TOOL_SPECS } from "../lib/tool-definitions.js";
import { baseUrl } from "../lib/base-url.js";
import { isVrpToolName } from "../lib/vrp.js";
import {
  CHATGPT_SERVER_DESCRIPTION,
  CHATGPT_SERVER_INSTRUCTIONS,
  SERVER_DESCRIPTION,
  SERVER_ICONS,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SERVER_WEBSITE_URL,
} from "../lib/server-metadata.js";
import {
  CHATGPT_WIDGET_MODEL_LINE,
  HEMMABO_ALL_WIDGET_URIS,
  HEMMABO_CANONICAL_MCP_ENDPOINT,
  HEMMABO_NATIVE_WIDGET_TOOL_META,
  HEMMABO_NATIVE_WIDGET_URI,
  HEMMABO_WIDGET_MIME_TYPE,
  buildNativeWidgetResource,
  buildWidgetResource,
  buildWidgetResourceMeta,
  mcpEndpointFromBaseUrl,
} from "../lib/apps-widget.js";
import { VERIFIED_STAY_OFFER_HTML, VERIFIED_STAY_OFFER_NATIVE_HTML } from "../lib/apps-widget-html.js";
import { chatgptToolDefinition, shapeChatgptToolResult } from "../lib/chatgpt-surface.js";
import {
  MCP_ASSUMED_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  acceptsEventStream,
  checkOrigin,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  parseJsonRpcBody,
} from "../lib/mcp-transport.js";

export { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS } from "../lib/server-metadata.js";

// ── Structured logging ───────────────────────────────────────────
// Redaction is the single shared module lib/log-redact.ts (normalized keys +
// value patterns + deep) — NEVER reintroduce a local name-only redactor here.
// The old local copy keyed on "guest_name" (snake_case) and so missed the
// camelCase `guestName` param, leaking guest names in clear text on every
// booking call; it also logged error messages raw. See log-redact.ts header.

// Tool execution is shared via lib/tools.ts (single source of truth for all
// tools, used by api/mcp.ts).

// ── Config schema (all fields optional — Smithery "Optional config" requirement) ──
export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    propertyDomain: {
      type: "string",
      description: "Vacation rental domain (e.g. 'villaakerlyckan.se'). Optional — connect to a specific host node.",
    },
    region: {
      type: "string",
      description: "Default region to search in (e.g. 'Skane', 'Toscana'). Can be overridden per request.",
    },
    currency: {
      type: "string",
      description: "Preferred display currency (ISO 4217, e.g. 'EUR', 'SEK'). Defaults to the property's currency.",
    },
    language: {
      type: "string",
      description: "Preferred response language (ISO 639-1, e.g. 'en', 'sv', 'de'). Defaults to English.",
    },
  },
  additionalProperties: false,
};

// ── Tools ────────────────────────────────────────────────────────
//
// Derived from lib/tool-definitions.ts — single source of truth for the
// canonical tools (#63). Do NOT redeclare tools here; add or modify them in
// lib/tool-definitions.ts.

export const TOOLS = TOOL_SPECS.map((t) => {
  const wire: {
    name: string;
    title: string;
    description: string;
    inputSchema: typeof t.inputSchema;
    outputSchema: typeof t.outputSchema;
    annotations: typeof t.annotations;
    _meta?: Record<string, unknown>;
  } = {
    name: t.name,
    // MCP 2025-06-18 Tool.title — the human-readable display name at the
    // top level. Same string as annotations.title (the pre-2025-06-18
    // location) so every client and the Anthropic directory portal find it
    // in either place. One source: lib/tool-definitions*.ts annotations.
    title: t.annotations.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  };
  if (t._meta) wire._meta = t._meta;
  return wire;
});

// ── ChatGPT (OpenAI Apps) surface ────────────────────────────────
//
// OpenAI App Review requires the app surface to contain NO in-chat commerce
// and NO digital-service/subscription onboarding (physical-goods-only rule).
// The dedicated /mcp/chatgpt endpoint (api/mcp-chatgpt.ts) therefore exposes
// ONLY the read-only discovery + cryptographic-verification tools listed below.
// Any booking/checkout/host-onboarding tool is invisible in tools/list and
// rejected in tools/call on this surface; all booking/payment happens on the
// host's own website (via vrp_get_verified_stay_offer's returned URL).
//
// SCOPED + ADDITIVE: the default "full" surface (/mcp) — and therefore npm /
// MCP registry / Smithery / Glama / every other client — stays byte-for-byte
// unchanged. Do NOT reuse this set to gate any other surface.
export type McpSurface = "full" | "chatgpt";

export const CHATGPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "hemmabo_search_properties",
  "vrp_verify_node",
  "vrp_get_verified_stay_offer",
]);


// ── Prompts ──────────────────────────────────────────────────────

export const PROMPTS = [
  {
    name: "host_start",
    description: "Help a vacation-rental host evaluate HemmaBo and start their own booking website. Use the read-only host onboarding tools; do not provision accounts, buy domains, or configure Stripe inside chat.",
    arguments: [
      {
        name: "propertyName",
        description: "Optional property or business name, e.g. Villa Akerlyckan.",
        required: false,
      },
      {
        name: "country",
        description: "Optional country where the property is located.",
        required: false,
      },
      {
        name: "domain",
        description: "Optional existing or intended host-owned domain.",
        required: false,
      },
    ],
  },
  {
    name: "trip_plan",
    description: "Help plan a vacation rental trip through host-domain discovery and verified offers. Search first, show a verified host-domain stay offer when possible, and route booking only to the signed direct host-domain URL.",
    arguments: [
      {
        name: "destination",
        description: "Where the guest wants to travel (region, city, or country). Example: 'Skane', 'Sweden', 'Toscana'.",
        required: true,
      },
      {
        name: "checkIn",
        description: "Desired check-in date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "checkOut",
        description: "Desired check-out date in YYYY-MM-DD format.",
        required: true,
      },
      {
        name: "guests",
        description: "Number of guests (integer, minimum 1).",
        required: true,
      },
    ],
  },
];

// ── Resources (ChatGPT Apps SDK UI widgets) ──────────────────────
//
// Apps SDK requires `ui://` resources that ChatGPT renders inline.
// vrp_get_verified_stay_offer is the render tool that points to this template.

export const RESOURCES = [buildWidgetResource(HEMMABO_CANONICAL_MCP_ENDPOINT)];

export function readResource(
  uri: string,
  mcpEndpointUrl: string = HEMMABO_CANONICAL_MCP_ENDPOINT,
  widgetDescription?: string,
  claudeStableOrigin: boolean = false
): { contents: { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }[] } | null {
  if (HEMMABO_ALL_WIDGET_URIS.includes(uri)) {
    const meta = buildWidgetResourceMeta(mcpEndpointUrl, widgetDescription, { claudeStableOrigin });
    return {
      contents: [
        {
          // Echo the *requested* URI: a frozen app snapshot asks for the
          // template it was approved with; answering under a different URI
          // can fail strict clients even when the bytes are right.
          uri,
          mimeType: HEMMABO_WIDGET_MIME_TYPE,
          text: uri === HEMMABO_NATIVE_WIDGET_URI
            ? VERIFIED_STAY_OFFER_NATIVE_HTML
            : VERIFIED_STAY_OFFER_HTML,
          _meta: meta as unknown as Record<string, unknown>,
        },
      ],
    };
  }
  return null;
}

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === "host_start") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I am a vacation-rental host${args.propertyName ? ` for ${args.propertyName}` : ""}${args.country ? ` in ${args.country}` : ""}${args.domain ? ` with domain ${args.domain}` : ""}. Please evaluate whether HemmaBo is a fit: vacation rental software, a signed stay offer on the host's own domain, Stripe payments to the host, no HemmaBo booking commission. Call hemmabo_check_host_readiness first; if it fits, call hemmabo_get_host_onboarding_link. Do not claim you created an account, bought a domain, or configured Stripe.`,
          },
        },
      ],
    };
  }

  if (name === "trip_plan") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please: (1) search for available host-owned properties, (2) if a host domain is known, call vrp_get_verified_stay_offer to render the host-domain verified stay offer widget and show only live availability, final host-source price, and the signed direct booking path, and (3) if I ask to book or pay, send me only to the signed direct host-domain booking URL; do not collect guest contact details or take payment in chat.`,
          },
        },
      ],
    };
  }
  return null;
}

// ── Supabase clients ─────────────────────────────────────────────

// Service-role client — bypasses RLS. Required for bookings reads + all writes.
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// Anon client — subject to RLS. Use for published property/snapshot reads.
function getSupabaseReader() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, key);
}

// Tool execution lives in lib/tools.ts — single source of truth. This
// transport constructs its own Supabase clients and passes them in. Errors
// bubble up so the transport can apply its own error-handling rules.


// ── JSON-RPC handler ─────────────────────────────────────────────

export async function handleJsonRpc(
  msg: { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> },
  ctx: { agent: string; mcpEndpointUrl: string; surface?: McpSurface } = {
    agent: "unknown",
    mcpEndpointUrl: HEMMABO_CANONICAL_MCP_ENDPOINT,
  }
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;
  const surface: McpSurface = ctx.surface ?? "full";

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          // Echo the client's version when we speak it, else offer the latest
          // (lib/mcp-transport.ts, ADR 0021).
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            // /mcp/chatgpt keeps the serverInfo OpenAI reviewed, byte for byte.
            ...(surface === "chatgpt" ? {} : { title: SERVER_TITLE }),
            version: SERVER_VERSION,
            description: surface === "chatgpt" ? CHATGPT_SERVER_DESCRIPTION : SERVER_DESCRIPTION,
            ...(surface === "chatgpt" ? {} : { icons: SERVER_ICONS, websiteUrl: SERVER_WEBSITE_URL }),
          },
          configSchema: CONFIG_SCHEMA,
          instructions: surface === "chatgpt" ? CHATGPT_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return {
        jsonrpc: "2.0", id,
        result: {
          tools: surface === "chatgpt"
            ? TOOLS.filter((t) => CHATGPT_TOOL_NAMES.has(t.name)).map((t) =>
                // ChatGPT renders the design-guidelines-native template
                // variant; every other surface keeps the premium v9 template.
                // The description drops its pointer to
                // hemmabo_check_availability, which this surface does not serve.
                t.name === "vrp_get_verified_stay_offer"
                  ? {
                      ...t,
                      description: t.description.replace(OFFER_CHECK_AVAILABILITY_SENTENCE, ""),
                      _meta: { ...t._meta, ...HEMMABO_NATIVE_WIDGET_TOOL_META },
                    }
                  : t
              ).map(chatgptToolDefinition)
            : TOOLS,
        },
      };

    case "tools/call": {
      const rawToolName = (params as { name: string })?.name;
      const toolName = typeof rawToolName === "string" ? normalizeToolName(rawToolName) : rawToolName;
      // Map legacy snake_case date params to canonical camelCase before
      // validation, so the live endpoint accepts both forms during the
      // checkIn/checkOut migration. validateToolArgs (#85) still rejects any
      // other unknown key so agents self-correct.
      const toolArgs = normalizeDateAliases((params as { arguments?: Record<string, unknown> })?.arguments ?? {});
      // ChatGPT surface: only the three CHATGPT_TOOL_NAMES discovery/verification tools are callable.
      // Everything else (booking, checkout, host onboarding) is off-surface and
      // routed to the host's own website — no in-chat commerce.
      if (surface === "chatgpt" && (typeof toolName !== "string" || !CHATGPT_TOOL_NAMES.has(toolName))) {
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Tool not available in ChatGPT.",
                detail: "HemmaBo in ChatGPT only discovers and verifies host-owned vacation rentals. Any booking or payment is completed on the host's own website. Call vrp_get_verified_stay_offer to obtain that website URL.",
              }),
            }],
            isError: true,
          },
        };
      }
      const start = Date.now();
      let ok = true;
      let errMsg: string | undefined;
      try {
        // Validate args against the tool's JSON-Schema before any business
        // logic runs. Returns field-level errors so AI agents can self-correct
        // rather than guess from a generic message. lib/tools.ts still
        // enforces required-arg presence as defense-in-depth.
        const validation = validateToolArgs(toolName, toolArgs);
        if (!validation.ok) {
          ok = false;
          errMsg = `Invalid arguments for ${toolName}`;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({
                  error: errMsg,
                  details: validation.errors ?? [],
                }),
              }],
              isError: true,
            },
          };
        }

        const rawResult = isVrpToolName(toolName) || isHostOnboardingToolName(toolName)
          ? await executeTool(toolName, toolArgs, {
              supabase: null as never,
              reader: null as never,
            })
          : await executeTool(toolName, toolArgs, {
              supabase: getSupabase(),
              reader: getSupabaseReader(),
            });
        // ADR 0020: on /mcp/chatgpt the model reads a short summary; the
        // widget reads the full result from _meta.
        const result = surface === "chatgpt" ? shapeChatgptToolResult(toolName, rawResult) : rawResult;
        if (
          surface === "chatgpt" &&
          toolName === "vrp_get_verified_stay_offer" &&
          result && typeof result === "object" && (result as { _meta?: unknown })._meta
        ) {
          // Point the render envelope at the native template on the ChatGPT
          // surface; every other _meta key (signed offer JWT, invocation
          // strings) passes through untouched.
          const r = result as { _meta: Record<string, unknown> };
          const ui = (r._meta.ui && typeof r._meta.ui === "object" ? r._meta.ui : {}) as Record<string, unknown>;
          return {
            jsonrpc: "2.0", id,
            result: {
              ...r,
              _meta: {
                ...r._meta,
                ui: { ...ui, resourceUri: HEMMABO_NATIVE_WIDGET_URI },
                "ui/resourceUri": HEMMABO_NATIVE_WIDGET_URI,
                "openai/outputTemplate": HEMMABO_NATIVE_WIDGET_URI,
              },
            },
          };
        }
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        ok = false;
        errMsg = err instanceof Error ? err.message : "Internal error";
        return { jsonrpc: "2.0", id, error: { code: -32603, message: errMsg } };
      } finally {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          tool: toolName,
          params: sanitizeParams(toolArgs),
          duration_ms: Date.now() - start,
          result: ok ? "ok" : "error",
          error_msg: redactMessage(errMsg),
          agent: ctx.agent,
        }));
      }
    }

    case "prompts/list":
      return {
        jsonrpc: "2.0", id,
        result: {
          prompts: surface === "chatgpt"
            ? PROMPTS.filter((p) => p.name !== "host_start")
            : PROMPTS,
        },
      };

    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            surface === "chatgpt"
              ? buildNativeWidgetResource(ctx.mcpEndpointUrl)
              : buildWidgetResource(ctx.mcpEndpointUrl),
          ],
        },
      };

    case "resources/read": {
      const uri = (params as { uri?: string })?.uri ?? "";
      const result = readResource(
        uri,
        ctx.mcpEndpointUrl,
        surface === "chatgpt" ? CHATGPT_WIDGET_MODEL_LINE : undefined,
        surface === "chatgpt"
      );
      if (!result) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
      }
      return { jsonrpc: "2.0", id, result };
    }

    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };

    case "prompts/get": {
      const promptName = (params as { name: string })?.name;
      const promptArgs = (params as { arguments?: Record<string, string> })?.arguments ?? {};
      const result = getPromptMessages(promptName, promptArgs);
      if (!result) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
      }
      return { jsonrpc: "2.0", id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── Anonymous read-only tool allowlist ───────────────────────────
//
// Compile inputSchema validators once at module load. Validation runs in the
// tools/call dispatcher below; lib/tools.ts retains the required-arg gate as
// defense-in-depth.
registerToolSchemas(TOOLS);

//
// Tools that may be invoked without a Bearer token. These are pure read-only
// discovery and pricing helpers; they perform no writes, no Stripe calls, and
// return no PII. Canonical snake_case names are exposed via tools/list; the
// aliases in lib/tools.ts TOOL_NAME_ALIASES (dotted names, and the names before
// the 6.0.0 rename) stay accepted inbound.
//
// Since ADR 0019 every tool in tools/list is in this set: the platform
// connector writes no bookings and moves no money. Any name NOT in this set
// (unknown, or one of the removed booking tools) still requires
// authentication and then fails as an unknown tool — fail closed.
export const ANON_TOOLS: ReadonlySet<string> = new Set([
  // Canonical snake_case names (#59 — claude.ai web rejects dots)
  "hemmabo_search_properties",
  "hemmabo_check_availability",
  "hemmabo_check_host_readiness",
  "hemmabo_get_host_onboarding_link",
  "vrp_verify_node",
  "vrp_get_verified_stay_offer",
  // Legacy dotted aliases (inbound compatibility — TOOL_NAME_ALIASES)
  "search.properties",
  "search.availability",
  // Names before the 6.0.0 rename (inbound compatibility — TOOL_NAME_ALIASES)
  "hemmabo_search_availability",
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
]);

/**
 * Returns true if the given JSON-RPC message requires Bearer auth.
 *
 * Auth-required iff method is "tools/call" AND the requested tool name is
 * NOT in ANON_TOOLS. Unknown/missing tool names default to requiring auth
 * (fail-closed) so a typo can never bypass the gate.
 */
export function isAuthRequiredMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { method?: unknown; params?: unknown };
  if (m.method !== "tools/call") return false;
  const name =
    m.params && typeof m.params === "object"
      ? (m.params as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string") return true; // fail closed
  return !ANON_TOOLS.has(name);
}

// ── HTTP handler ─────────────────────────────────────────────────

export async function serve(req: VercelRequest, res: VercelResponse, surface: McpSurface = "full") {
  // Origin first (MCP Streamable HTTP: "Servers MUST validate the Origin
  // header on all incoming connections"). Non-browser clients (Claude Desktop,
  // Smithery, Glama, registries) send no Origin and pass. A browser may open
  // the endpoint from this platform, the assistants' web apps, a loopback
  // address or an operator-listed origin (lib/mcp-transport.ts); anything else
  // is refused before any header, body or tool is touched.
  const origin = checkOrigin(req.headers["origin"], req.headers["x-forwarded-host"] ?? req.headers["host"]);
  if (!origin.ok) {
    return res.status(403).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Origin not allowed (${origin.reason})` },
    });
  }
  // Browser-based CSRF against the Bearer gate is further mitigated by the
  // Authorization header: a browser cannot send it cross-origin without a
  // preflight, and the preflight grants no credentials.
  res.setHeader("Access-Control-Allow-Origin", origin.origin ?? "*");
  if (origin.origin) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "HEAD") return res.status(200).end();

  // MCP-Protocol-Version: absent means the spec's assumed 2025-03-26 (no
  // behaviour depends on it here, the server is stateless); present and
  // unknown is a 400 ("the server MUST respond with 400 Bad Request").
  const declaredVersion = Array.isArray(req.headers["mcp-protocol-version"])
    ? req.headers["mcp-protocol-version"][0]
    : req.headers["mcp-protocol-version"];
  if (declaredVersion !== undefined && !isSupportedProtocolVersion(declaredVersion)) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `Unsupported MCP-Protocol-Version "${String(declaredVersion).slice(0, 64)}". Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.`,
      },
    });
  }

  if (req.method === "GET") {
    // A GET that asks for text/event-stream wants a server-initiated SSE
    // stream. This server opens none: "the server MUST either return
    // Content-Type: text/event-stream ... or else return HTTP 405".
    if (acceptsEventStream(req.headers["accept"])) {
      res.setHeader("Allow", "POST, HEAD, OPTIONS, DELETE");
      return res.status(405).json({
        error: "Method not allowed",
        detail: "This server opens no server-initiated SSE stream. Send JSON-RPC over POST.",
      });
    }
    // Plain GET keeps the transport-info body uptime monitors and docs rely on.
    return res.json({
      status: "ok",
      transport: "streamable-http",
      version: SERVER_VERSION,
      protocolVersions: [...MCP_PROTOCOL_VERSIONS],
      assumedProtocolVersion: MCP_ASSUMED_PROTOCOL_VERSION,
    });
  }
  if (req.method === "DELETE") return res.status(202).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // The envelope before anything else reads it: a JSON-RPC 2.0 request,
  // notification or response, or a non-empty array of them. Anything else is
  // 400 with a JSON-RPC error and no id (-32600 Invalid Request, -32700
  // Parse error). Client responses are accepted and not dispatched.
  const envelope = parseJsonRpcBody(req.body);
  if (!envelope.ok) {
    return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: envelope.code, message: envelope.message } });
  }

  // Auth model: public read; every listed tool is read-only (ADR 0019).
  // - initialize / tools/list / prompts/* / ping: anonymous (registry discovery).
  // - tools/call for ANON_TOOLS: anonymous. These are pure read-only discovery
  //   and pricing helpers. Same data is published on the host's public website,
  //   and Supabase RLS restricts properties/snapshot reads to published rows.
  //   Bookings reads from these tools (availability gap detection) only return
  //   boolean availability + blocked-date ranges, never PII.
  // - tools/call for any name not in ANON_TOOLS (unknown or removed tools):
  //   requires a Bearer token (MCP_API_KEY or OAuth access token) — fail closed.
  const requestMessages = envelope.requests;
  // ChatGPT surface: the only callable tools are the three anonymous read-only
  // ones; every other tool is rejected in handleJsonRpc before any execution,
  // so the Bearer gate is unnecessary here (the allowlist replaces it).
  const requiresAuth = surface === "chatgpt" ? false : requestMessages.some(isAuthRequiredMessage);
  if (requiresAuth) {
    const authorization = Array.isArray(req.headers["authorization"])
      ? req.headers["authorization"][0]
      : req.headers["authorization"];
    const authErr = await validateAuth(authorization);
    if (authErr) {
      // RFC 9728 §5.1 — point the client at the protected-resource metadata
      // so it can discover the authorization server without prior
      // configuration. Claude.ai depends on this header to start the
      // authorization_code flow. MCP 2025-11-25: the challenge SHOULD name the
      // scope (`mcp`, the metadata's scopes_supported). RFC 6750 §3.1: a
      // request that carried no Bearer token gets no error code; only a token
      // that was sent and rejected gets error="invalid_token".
      const resourceMetadataUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
      const sentBearerToken = typeof authorization === "string" && /^Bearer\s+\S/.test(authorization);
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="hemmabo-mcp", resource_metadata="${resourceMetadataUrl}", scope="mcp"` +
          (sentBearerToken ? `, error="invalid_token"` : "")
      );
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: `${authErr}. Pass your API key as: Authorization: Bearer <key>` },
      });
    }
  }

  // Per-IP / per-token rate limit. Anonymous callers share a 60 req/min budget
  // per source IP; authenticated callers get 200 req/min per token. Limits are
  // configurable via RATE_LIMIT_ANON_PER_MIN / RATE_LIMIT_BEARER_PER_MIN.
  // Fail-open when Upstash isn't configured (preview deploys, local dev) — see
  // lib/rate-limit.ts.
  //
  // Only applied to tools/call. initialize / tools/list / prompts / ping are
  // cheap discovery calls and must remain unthrottled so registries can crawl
  // without bumping into the limit.
  const hasToolsCall = requestMessages.some(
    (m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call"
  );
  if (hasToolsCall) {
    const kind = requiresAuth ? "bearer" : "anon";
    const identifier = requiresAuth
      ? bearerIdentifier(req.headers["authorization"] as string | undefined)
      : anonIdentifier(req.headers as Record<string, string | string[] | undefined>);
    const rl = await checkRateLimit(kind, identifier);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 60));
      if (rl.limit !== undefined) res.setHeader("X-RateLimit-Limit", String(rl.limit));
      res.setHeader("X-RateLimit-Remaining", "0");
      return res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Rate limit exceeded — retry in ${rl.retryAfterSec ?? 60}s`,
        },
      });
    }
    if (rl.limit !== undefined && rl.remaining !== undefined) {
      res.setHeader("X-RateLimit-Limit", String(rl.limit));
      res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
    }
  }

  const ctx = {
    agent: ((req.headers["user-agent"] as string | undefined) ?? "unknown").slice(0, 80),
    mcpEndpointUrl: mcpEndpointFromBaseUrl(baseUrl(req)),
    surface,
  };

  try {
    // Requests are answered; notifications and client responses are not
    // ("the server MUST return HTTP status code 202 Accepted with no body").
    // A batch is answered with a batch.
    const results: Record<string, unknown>[] = [];
    for (const msg of envelope.requests) {
      const result = await handleJsonRpc(msg, ctx);
      if (result !== null && msg.id !== undefined) results.push(result);
    }
    if (results.length === 0) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    return res.json(envelope.batch ? results : results[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("MCP handler error:", message);
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
  }
}

// Default export = the full federation surface (/mcp). Behaviour is unchanged;
// the dedicated ChatGPT surface is served by api/mcp-chatgpt.ts via serve(...,"chatgpt").
export default function handler(req: VercelRequest, res: VercelResponse) {
  return serve(req, res, "full");
}
