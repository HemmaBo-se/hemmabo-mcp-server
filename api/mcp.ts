/**
 * Federation MCP Server — Vercel Serverless (Streamable HTTP, stateless)
 *
 * All pricing/availability logic lives in lib/ — single source of truth.
 * This file only handles JSON-RPC transport + tool dispatch.
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC (initialize, tools/list, tools/call, prompts/list, prompts/get)
 *   GET  /mcp  — transport info
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { executeTool, normalizeToolName } from "../lib/tools.js";
import { validateAuth } from "../src/auth.js";
import { anonIdentifier, bearerIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import { registerToolSchemas, validateToolArgs } from "../lib/validate-args.js";
import { TOOL_SPECS } from "../lib/tool-definitions.js";
import { baseUrl } from "../lib/base-url.js";
import { isVrpToolName } from "../lib/vrp.js";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../lib/server-metadata.js";

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
    name: "trip.plan",
    description: "Help plan a vacation rental trip. Guides the agent through the full booking lifecycle: searching properties, getting a binding quote, completing payment via Stripe checkout, and managing the booking (status checks, rescheduling, cancellation). Provide destination, dates, and guest count to get started.",
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
// Apps SDK requires `ui://` resources that ChatGPT renders inline. Tools bind
// to a widget via `_meta["openai/outputTemplate"]`. This single widget renders
// a property search-result card for `hemmabo_search_properties`. Other tools may
// adopt their own widgets later — kept minimal per Gap 2 spec.

const PROPERTY_CARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>HemmaBo property card</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 12px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; background: var(--card-bg, transparent); }
  .card img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #eee; }
  .body { padding: 12px; display: flex; flex-direction: column; gap: 6px; }
  .title { font-weight: 600; font-size: 15px; line-height: 1.25; }
  .loc { font-size: 12px; opacity: 0.7; }
  .price { font-size: 14px; margin-top: 4px; }
  .price .strike { text-decoration: line-through; opacity: 0.55; margin-right: 6px; }
  .price .fed { font-weight: 600; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 999px; background: #16a34a22; color: #16a34a; margin-left: 6px; }
  .cta { margin-top: 8px; display: inline-block; text-align: center; padding: 8px 12px; border-radius: 8px; background: #111; color: #fff; text-decoration: none; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .cta { background: #fafafa; color: #111; } }
  .empty { padding: 16px; opacity: 0.7; font-size: 13px; }
</style>
</head>
<body>
<div id="root" class="empty">Loading HemmaBo properties…</div>
<script>
  // Apps SDK injects tool output into window.openai.toolOutput.
  // Fallback: read ?data=... URL param for static previews.
  function getData() {
    try {
      var w = window;
      if (w.openai && w.openai.toolOutput) return w.openai.toolOutput;
    } catch (e) {}
    try {
      var u = new URL(window.location.href);
      var raw = u.searchParams.get("data");
      if (raw) return JSON.parse(decodeURIComponent(raw));
    } catch (e) {}
    return null;
  }
  function fmt(amount, currency) {
    if (amount == null) return "";
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "SEK", maximumFractionDigits: 0 }).format(amount); }
    catch (e) { return amount + " " + (currency || ""); }
  }
  function render(data) {
    var root = document.getElementById("root");
    var props = (data && data.properties) || [];
    if (!props.length) { root.className = "empty"; root.textContent = "No properties found for these dates."; return; }
    root.className = "grid";
    root.innerHTML = "";
    props.forEach(function (p) {
      var card = document.createElement("div"); card.className = "card";
      if (p.image) { var img = document.createElement("img"); img.src = p.image; img.alt = p.name || ""; card.appendChild(img); }
      var body = document.createElement("div"); body.className = "body";
      var t = document.createElement("div"); t.className = "title"; t.textContent = p.name || "Property"; body.appendChild(t);
      var loc = document.createElement("div"); loc.className = "loc";
      loc.textContent = [p.city, p.region, p.country].filter(Boolean).join(", ");
      body.appendChild(loc);
      var price = document.createElement("div"); price.className = "price";
      if (p.publicTotal && p.federationTotal && p.publicTotal !== p.federationTotal) {
        var s = document.createElement("span"); s.className = "strike"; s.textContent = fmt(p.publicTotal / 100, p.currency); price.appendChild(s);
      }
      var f = document.createElement("span"); f.className = "fed"; f.textContent = fmt((p.federationTotal || 0) / 100, p.currency); price.appendChild(f);
      if (p.nights) { var n = document.createElement("span"); n.style.opacity = "0.7"; n.style.marginLeft = "6px"; n.textContent = "/ " + p.nights + " nights"; price.appendChild(n); }
      if (p.federationDiscountPercent) { var b = document.createElement("span"); b.className = "badge"; b.textContent = "Direct -" + p.federationDiscountPercent + "%"; price.appendChild(b); }
      body.appendChild(price);
      if (p.domain) {
        var a = document.createElement("a"); a.className = "cta"; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.href = "https://" + p.domain; a.textContent = "Book direct on " + p.domain;
        body.appendChild(a);
      }
      card.appendChild(body);
      root.appendChild(card);
    });
  }
  render(getData());
</script>
</body>
</html>`;

export const RESOURCES = [
  {
    uri: "ui://hemmabo/property-card",
    name: "HemmaBo property card",
    description:
      "ChatGPT Apps SDK widget that renders hemmabo_search_properties results as a grid of property cards with image, location, public vs federation (direct-booking) price, host-controlled discount badge, and a CTA linking to the property's own host-owned domain.",
    mimeType: "text/html",
  },
];

function readResource(uri: string): { contents: { uri: string; mimeType: string; text: string }[] } | null {
  if (uri === "ui://hemmabo/property-card") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/html",
          text: PROPERTY_CARD_HTML,
        },
      ],
    };
  }
  return null;
}

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === "trip.plan") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to plan a trip to ${args.destination || "a vacation destination"} from ${args.checkIn || "TBD"} to ${args.checkOut || "TBD"} for ${args.guests || "2"} guests. Please: (1) search for available properties, (2) show pricing with both public and direct booking rates, (3) create a binding quote with hemmabo_booking_negotiate, (4) proceed to hemmabo_booking_checkout with Stripe payment, and (5) confirm booking status with hemmabo_booking_status. If I need to change dates later, use hemmabo_booking_reschedule. If I need to cancel, use hemmabo_booking_cancel.`,
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
  ctx: { agent: string; ip_hint: string } = { agent: "unknown", ip_hint: "unknown" }
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
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
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

        const result = isVrpToolName(toolName)
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
      return { jsonrpc: "2.0", id, result: { resources: RESOURCES } };

    case "resources/read": {
      const uri = (params as { uri?: string })?.uri ?? "";
      const result = readResource(uri);
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(204).end();
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
