/**
 * Federation MCP Server — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All pricing/availability logic lives in lib/ — single source of truth.
 * This file only handles JSON-RPC transport + tool dispatch.
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call, prompts/list, prompts/get)
 *   GET  /mcp  — transport info
 *   HEAD /mcp  — transport liveness for uptime monitors
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { executeTool, isHostOnboardingToolName, normalizeDateAliases, normalizeToolName } from "../lib/tools.js";
import { validateAuth } from "../src/auth.js";
import { anonIdentifier, bearerIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import { registerToolSchemas, validateToolArgs } from "../lib/validate-args.js";
import { TOOL_SPECS } from "../lib/tool-definitions.js";
import { baseUrl } from "../lib/base-url.js";
import { isVrpToolName } from "../lib/vrp.js";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../lib/server-metadata.js";
import {
  HEMMABO_CANONICAL_MCP_ENDPOINT,
  HEMMABO_LEGACY_WIDGET_URI,
  HEMMABO_PREVIOUS_WIDGET_URI,
  HEMMABO_V3_WIDGET_URI,
  HEMMABO_V1_WIDGET_URI,
  HEMMABO_V2_WIDGET_URI,
  HEMMABO_WIDGET_MIME_TYPE,
  HEMMABO_WIDGET_URI,
  buildWidgetResource,
  buildWidgetResourceMeta,
  mcpEndpointFromBaseUrl,
} from "../lib/apps-widget.js";
import { VERIFIED_STAY_OFFER_HTML } from "../lib/apps-widget-html.js";

export { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS } from "../lib/server-metadata.js";

// ── Structured logging ───────────────────────────────────────────

const REDACT_KEYS = ["stripe_token", "spt_token", "card_number", "email", "phone", "guest_name"];

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) =>
      REDACT_KEYS.some((r) => k.toLowerCase().includes(r)) ? [k, "[redacted]"] : [k, v]
    )
  );
}

// Tool execution is shared via lib/tools.ts (single source of truth for all
// tools, used by api/mcp.ts, src/stdio.ts, and src/index.ts).

// ── Config schema (all fields optional — Smithery "Optional config" requirement) ──
export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    propertyDomain: {
      type: "string",
      description: "Your vacation rental domain (e.g. 'villaakerlyckan.se'). Optional — used when connecting to a specific host node.",
    },
    region: {
      type: "string",
      description: "Default region to search in (e.g. 'Skane', 'Toscana'). Can be overridden per request.",
    },
    currency: {
      type: "string",
      description: "Preferred display currency (ISO 4217, e.g. 'EUR', 'SEK', 'USD'). Defaults to the property's native currency.",
    },
    language: {
      type: "string",
      description: "Preferred response language (ISO 639-1 code, e.g. 'en', 'sv', 'de', 'it', 'fr', 'es'). Defaults to English.",
    },
  },
  additionalProperties: false,
};

// ── Tools ────────────────────────────────────────────────────────
//
// Derived from lib/tool-definitions.ts — single source of truth for the
// canonical tools (#63). src/index.ts and src/stdio.ts read the same
// TOOL_SPECS via toZodShape(). Do NOT redeclare tools here; add or modify
// them in lib/tool-definitions.ts.

export const TOOLS = TOOL_SPECS.map((t) => {
  const wire: {
    name: string;
    description: string;
    inputSchema: typeof t.inputSchema;
    outputSchema: typeof t.outputSchema;
    annotations: typeof t.annotations;
    _meta?: Record<string, unknown>;
  } = {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  };
  if (t._meta) wire._meta = t._meta;
  return wire;
});


// ── Prompts ──────────────────────────────────────────────────────

export const PROMPTS = [
  {
    name: "host.start",
    description: "Help a vacation-rental host evaluate HemmaBo and start an own-domain booking engine. Use the read-only host onboarding tools; do not provision accounts, buy domains, or configure Stripe inside chat.",
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
    name: "trip.plan",
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
// get_verified_stay_offer is the render tool that points to this template.

export const RESOURCES = [buildWidgetResource(HEMMABO_CANONICAL_MCP_ENDPOINT)];

export function readResource(
  uri: string,
  mcpEndpointUrl: string = HEMMABO_CANONICAL_MCP_ENDPOINT
): { contents: { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }[] } | null {
  if (
    uri === HEMMABO_WIDGET_URI ||
    uri === HEMMABO_PREVIOUS_WIDGET_URI ||
    uri === HEMMABO_V3_WIDGET_URI ||
    uri === HEMMABO_V2_WIDGET_URI ||
    uri === HEMMABO_V1_WIDGET_URI ||
    uri === HEMMABO_LEGACY_WIDGET_URI
  ) {
    const meta = buildWidgetResourceMeta(mcpEndpointUrl);
    return {
      contents: [
        {
          uri: HEMMABO_WIDGET_URI,
          mimeType: HEMMABO_WIDGET_MIME_TYPE,
          text: VERIFIED_STAY_OFFER_HTML,
          _meta: meta as unknown as Record<string, unknown>,
        },
      ],
    };
  }
  return null;
}

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === "host.start") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I am a vacation-rental host${args.propertyName ? ` for ${args.propertyName}` : ""}${args.country ? ` in ${args.country}` : ""}${args.domain ? ` with domain ${args.domain}` : ""}. Please evaluate whether HemmaBo is a fit for an own-domain booking engine with guest Wallet, Stripe Connect direct-to-host payments, calendar/iCal sync, 11-language guest chat, extend-stay/gap-night flows, reviews, and AI-agent-readable booking data. Call hemmabo_host_readiness_check first; if it fits, call hemmabo_host_onboarding_link. Do not claim you created an account, bought a domain, or configured Stripe.`,
          },
        },
      ],
    };
  }

  if (name === "trip.plan") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please: (1) search for available host-owned properties, (2) if a host domain is known, call get_verified_stay_offer to render the host-domain verified stay offer widget and show only live availability, final host-source price, and the signed direct booking path, and (3) if I ask to book or pay, send me only to the signed direct host-domain booking URL; do not collect guest contact details or start checkout in chat.`,
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

// Tool execution lives in lib/tools.ts — single source of truth shared with
// src/stdio.ts and src/index.ts. Transports construct their own clients and
// pass them in. Errors bubble up so each transport can apply its own
// error-handling rules unchanged.


// ── JSON-RPC handler ─────────────────────────────────────────────

async function handleJsonRpc(
  msg: { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> },
  ctx: { agent: string; ip_hint: string; mcpEndpointUrl: string } = {
    agent: "unknown",
    ip_hint: "unknown",
    mcpEndpointUrl: HEMMABO_CANONICAL_MCP_ENDPOINT,
  }
): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            description: SERVER_DESCRIPTION,
          },
          configSchema: CONFIG_SCHEMA,
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const rawToolName = (params as { name: string })?.name;
      const toolName = typeof rawToolName === "string" ? normalizeToolName(rawToolName) : rawToolName;
      // Map legacy snake_case date params to canonical camelCase before
      // validation, so the live endpoint accepts both forms during the
      // checkIn/checkOut migration. validateToolArgs (#85) still rejects any
      // other unknown key so agents self-correct.
      const toolArgs = normalizeDateAliases((params as { arguments?: Record<string, unknown> })?.arguments ?? {});
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

        const result = isVrpToolName(toolName) || isHostOnboardingToolName(toolName)
          ? await executeTool(toolName, toolArgs, {
              supabase: null as never,
              reader: null as never,
            })
          : await executeTool(toolName, toolArgs, {
              supabase: getSupabase(),
              reader: getSupabaseReader(),
            });
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
          error_msg: errMsg,
          agent: ctx.agent,
          ip_hint: ctx.ip_hint,
        }));
      }
    }

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { resources: [buildWidgetResource(ctx.mcpEndpointUrl)] },
      };

    case "resources/read": {
      const uri = (params as { uri?: string })?.uri ?? "";
      const result = readResource(uri, ctx.mcpEndpointUrl);
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
// defense-in-depth (the stdio transport has its own Zod validator).
registerToolSchemas(TOOLS);

//
// Tools that may be invoked without a Bearer token. These are pure read-only
// discovery and pricing helpers; they perform no writes, no Stripe calls, and
// return no PII. Canonical snake_case names are exposed via tools/list; legacy
// dotted aliases from lib/tools.ts TOOL_NAME_ALIASES stay accepted inbound.
//
// Any tool NOT in this set requires authentication:
//   booking.create, booking.negotiate, booking.checkout, booking.cancel,
//   booking.reschedule, booking.status (PII).
export const ANON_TOOLS: ReadonlySet<string> = new Set([
  // Canonical snake_case names (#59 — claude.ai web rejects dots)
  "hemmabo_search_properties",
  "hemmabo_search_availability",
  "hemmabo_search_similar",
  "hemmabo_compare_properties",
  "hemmabo_booking_quote",
  "hemmabo_host_readiness_check",
  "hemmabo_host_onboarding_link",
  "verify_vacation_rental_node",
  "get_verified_stay_offer",
  // Legacy dotted aliases (inbound compatibility — TOOL_NAME_ALIASES)
  "search.properties",
  "search.availability",
  "search.similar",
  "search.compare",
  "booking.quote",
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Origin is intentionally unrestricted — MCP clients (Claude Desktop, Smithery,
  // Glama) are not browsers and do not send an Origin header. Browser-based CSRF
  // is mitigated by requiring the Authorization header on all POST requests:
  // browsers cannot send custom headers cross-origin without a preflight, and the
  // preflight response does not grant credentials, so unauthenticated cross-site
  // POSTs are blocked at the browser level.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "HEAD") return res.status(200).end();
  if (req.method === "GET") return res.json({ status: "ok", transport: "streamable-http", version: SERVER_VERSION });
  if (req.method === "DELETE") return res.status(202).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Auth model: public read, signed write.
  // - initialize / tools/list / prompts/* / ping: anonymous (registry discovery).
  // - tools/call for ANON_TOOLS: anonymous. These are pure read-only discovery
  //   and pricing helpers. Same data is published on the host's public website,
  //   and Supabase RLS restricts properties/snapshot reads to published rows.
  //   Bookings reads from these tools (availability gap detection) only return
  //   boolean availability + blocked-date ranges, never PII.
  // - tools/call for any other tool (booking writes, status with PII): requires
  //   Bearer token (MCP_API_KEY or OAuth client_credentials access token).
  //
  // This keeps read-only public discovery separate from protected stateful actions
  // and PII reads, which remain behind authentication.
  const requestMessages = Array.isArray(req.body) ? req.body : [req.body];
  const requiresAuth = requestMessages.some(isAuthRequiredMessage);
  if (requiresAuth) {
    const authErr = await validateAuth(
      Array.isArray(req.headers["authorization"])
        ? req.headers["authorization"][0]
        : req.headers["authorization"],
    );
    if (authErr) {
      // RFC 9728 §5.1 — point the client at the protected-resource metadata
      // so it can discover the authorization server without prior
      // configuration. Claude.ai depends on this header to start the
      // authorization_code flow.
      const resourceMetadataUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="hemmabo-mcp", resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
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
    ip_hint: ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0]?.trim() || "unknown",
    mcpEndpointUrl: mcpEndpointFromBaseUrl(baseUrl(req)),
  };

  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const results = [];
      for (const msg of body) {
        const result = await handleJsonRpc(msg, ctx);
        if (result !== null) results.push(result);
      }
      if (results.length === 0) return res.status(202).end();
      return res.json(results);
    }

    const result = await handleJsonRpc(body, ctx);
    if (result === null) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("MCP handler error:", message);
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message } });
  }
}
