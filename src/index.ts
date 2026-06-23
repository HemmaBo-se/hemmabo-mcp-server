/**
 * MCP Server — Federation Protocol
 *
 * Infrastructure for independent hosts. Each property is its own node
 * (source of truth). This server reads real data — never mocks, never guesses.
 *
 * Transport: Streamable HTTP (required for Smithery Gateway)
 * Data: Supabase (property, pricing, availability, bookings)
 *
 * Pricing flow:
 *   Google/website visitor -> public_total
 *   Vera AI / federation partner (at booking) -> federation_total
 *   Gap night (calendar context) -> gap_total
 *
 * User-facing VRP copy should present direct host-source totals, not discounts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { executeTool, isHostOnboardingToolName } from "../lib/tools.js";
import { TOOL_SPECS, toZodShape } from "../lib/tool-definitions.js";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../lib/server-metadata.js";
import { sanitizeParams, redactMessage } from "../lib/log-redact.js";
import { validateAuth } from "./auth.js";
import { anonIdentifier, bearerIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import rateLimit from "express-rate-limit";
import { PROMPTS as CATALOG_PROMPTS, RESOURCES as CATALOG_RESOURCES, TOOLS as CATALOG_TOOLS } from "../api/mcp.js";

// Tool execution is shared via lib/tools.ts (single source of truth for all
// runtime tools used by api/mcp.ts, src/stdio.ts, and src/index.ts).

// ── Shared validators ──────────────────────────────────────────────

/** Accepts only YYYY-MM-DD. Rejects free-text, SQL fragments, and partial dates. */
const zISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

// ── Environment ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Graceful degradation: allow server to start without DB for validation/testing
// Service-role client — bypasses RLS. Required for bookings reads + all writes.
let supabase: SupabaseClient | null = null;
// Anon client — subject to RLS. Used for published property/snapshot reads.
// Falls back to service-role if SUPABASE_ANON_KEY is not set (matches stdio.ts).
let reader: SupabaseClient | null = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠ Running without database — tools will return errors until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  reader = createClient(SUPABASE_URL, SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_KEY);
  console.log("✓ Database connected");
}

// ── MCP Server ─────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: SERVER_DESCRIPTION,
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ── Structured logging ──────────────────────────────────────────────
// Wrapped once around server.tool() so every registered tool is auto-instrumented.
// Per-request agent/ip_hint is propagated via AsyncLocalStorage (populated by /mcp handler).

// Redaction lives in lib/log-redact.ts — shared with src/stdio.ts (single source).

type LogCtx = { agent: string; ip_hint: string; sessionId: string };
const requestContext = new AsyncLocalStorage<LogCtx>();

// ── Session tracking + intent classification ───────────────────────

interface SessionState {
  tools: string[];
  firstSeen: number;
  lastSeen: number;
  propertyId?: string;
  checkIn?: string;
  checkOut?: string;
}

type Intent =
  | "browsing"       // search → stop
  | "comparing"      // quote × 3+ without checkout
  | "ready_to_book"  // quote → checkout
  | "completed"      // checkout → status
  | "abandoned"      // quote → >30 min inactivity
  | "unknown";

// In-memory store — resets on cold start, intentional
const sessionStore = new Map<string, SessionState>();

function classifyIntent(tools: string[], lastSeen: number): Intent {
  const hasStatus   = tools.includes("hemmabo_booking_status");
  const hasCheckout = tools.includes("hemmabo_booking_checkout");
  const quoteCount  = tools.filter(t => t === "hemmabo_booking_quote" || t === "hemmabo_booking_negotiate").length;
  const hasSearch   = tools.some(t => t.includes("search"));
  const hasQuote    = quoteCount > 0;
  const idleMs      = Date.now() - lastSeen;

  if (hasStatus)                              return "completed";
  if (hasCheckout)                            return "ready_to_book";
  if (hasQuote && idleMs > 30 * 60 * 1000)   return "abandoned";
  if (quoteCount >= 3)                        return "comparing";
  if (hasSearch && !hasQuote)                 return "browsing";
  return "unknown";
}

// Cleanup sessions older than 2 hours — runs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of sessionStore.entries()) {
    if (session.lastSeen < cutoff) sessionStore.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── Tool wrapper ───────────────────────────────────────────────────

const _originalServerTool = server.tool.bind(server);
(server as unknown as { tool: unknown }).tool = (
  name: string,
  description: string,
  schema: unknown,
  annotations: unknown,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
) => {
  const wrapped = async (args: Record<string, unknown>, extra: unknown) => {
    const start = Date.now();
    let ok = true;
    let errMsg: string | undefined;
    try {
      return await handler(args, extra);
    } catch (err) {
      ok = false;
      errMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const ctx = requestContext.getStore() ?? { agent: "unknown", ip_hint: "unknown", sessionId: "anonymous" };

      // Update session state
      const session = sessionStore.get(ctx.sessionId) ?? {
        tools: [], firstSeen: Date.now(), lastSeen: Date.now(),
      };
      session.tools.push(name);
      session.lastSeen = Date.now();
      if (args.property_id) session.propertyId = args.property_id as string;
      if (args.propertyId)  session.propertyId = args.propertyId as string;
      if (args.check_in)    session.checkIn    = args.check_in as string;
      if (args.checkIn)     session.checkIn    = args.checkIn as string;
      if (args.check_out)   session.checkOut   = args.check_out as string;
      if (args.checkOut)    session.checkOut   = args.checkOut as string;
      sessionStore.set(ctx.sessionId, session);

      console.log(JSON.stringify({
        ts:            new Date().toISOString(),
        tool:          name,
        params:        sanitizeParams(args ?? {}),
        duration_ms:   Date.now() - start,
        result:        ok ? "ok" : "error",
        error_msg:     redactMessage(errMsg),
        agent:         ctx.agent,
        ip_hint:       ctx.ip_hint,
        session_id:    ctx.sessionId,
        session_depth: session.tools.length,
        intent:        classifyIntent(session.tools, session.lastSeen),
        property_id:   session.propertyId ?? null,
      }));
    }
  };
  return (_originalServerTool as unknown as (
    n: string, d: string, s: unknown, a: unknown, h: typeof wrapped
  ) => unknown)(name, description, schema, annotations, wrapped);
};

// ── Tool registration ──────────────────────────────────────────────
//
// All runtime tools come from lib/tool-definitions.ts — single source of truth
// (#63). server.tool() is called from a loop so adding or removing a tool
// requires editing only TOOL_SPECS.

const WRAP_ERROR_LABEL: Record<string, string> = {
  "hemmabo_booking_checkout":   "Checkout failed",
  "hemmabo_booking_cancel":     "Cancellation failed",
  "hemmabo_booking_reschedule": "Reschedule failed",
};

for (const spec of TOOL_SPECS) {
  const shape = toZodShape(spec.inputSchema);
  const handler = async (args: Record<string, unknown>) => {
    if (isHostOnboardingToolName(spec.name)) {
      return executeTool(spec.name, args, {
        supabase: null as never,
        reader: null as never,
      });
    }

    if (!supabase || !reader) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }),
        }],
        isError: true,
      };
    }
    const errorLabel = WRAP_ERROR_LABEL[spec.name];
    if (errorLabel) {
      try {
        return await executeTool(spec.name, args, { supabase, reader });
      } catch (error) {
        const msg = error instanceof Error ? error.message : errorLabel;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    }
    return executeTool(spec.name, args, { supabase, reader });
  };
  server.tool(spec.name, spec.description, shape, spec.annotations, handler as never);
}

// ── Prompt: trip_plan ─────────────────────────────────────────────────────
server.prompt(
  "trip_plan",
  "Help plan a vacation rental trip through host-domain discovery and verified offers. Search first, show a verified host-domain stay offer when possible, and route booking only to the signed direct host-domain URL.",
  {
    destination: z.string().describe("Where the guest wants to travel (region, city, or country). Example: 'Skane', 'Sweden', 'Toscana'."),
    checkIn: zISODate.describe("Desired check-in date in YYYY-MM-DD format."),
    checkOut: zISODate.describe("Desired check-out date in YYYY-MM-DD format."),
    guests: z.string().describe("Number of guests (integer, minimum 1)."),
  },
  async ({ destination, checkIn, checkOut, guests }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I want to plan a trip to ${destination || "a vacation destination"} from ${checkIn || "TBD"} to ${checkOut || "TBD"} for ${guests || "2"} guests. Please: (1) search for available host-owned properties with hemmabo_search_properties, (2) if a host domain is known, call get_verified_stay_offer to render the host-domain verified stay offer widget and show only live availability, final host-source price, and the signed direct booking path, and (3) if I ask to book or pay, send me only to the signed direct host-domain booking URL; do not collect guest contact details or start checkout in chat.`,
          },
        },
      ],
    };
  }
);

// ── HTTP Server (Streamable HTTP Transport) ────────────────────────

const app = express();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: SERVER_VERSION });
});

// Standard Express-recognised rate-limit middleware on /mcp. This is the
// pattern CodeQL's js/missing-rate-limiting query matches; the deeper
// per-token Upstash limit (lib/rate-limit.ts, #65/#77) still runs inside
// the handler for production accuracy. 600/min is a very loose safety net —
// the real budgets (60 anon / 200 bearer) are enforced by checkRateLimit.
const mcpIpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// MCP endpoint
app.all("/mcp", mcpIpLimiter, async (req, res) => {
  // MCP-09: auth gate. Grövre än api/mcp.ts — där kontrolleras endast
  // tools/call via inspektion av den förparsade JSON-RPC-bodyn. Här kan vi
  // inte inspektera method före StreamableHTTPServerTransport tar över
  // utan att buffra bodyn (vilket skulle kräva transport-refactor, ej i
  // MCP-09-scope). Vi kräver därför Authorization på alla POST /mcp när
  // MCP_API_KEY är satt. GET/OPTIONS/DELETE och öppet läge (ingen nyckel
  // satt) lämnas oförändrade.
  if (req.method === "POST") {
    // Rate-limit BEFORE the auth DB-lookup so an unauthenticated brute-force
    // cannot DoS the OAuth registry. Same SoT as api/mcp.ts (#65/#77). We
    // throttle every POST here (not just tools/call) because the JSON-RPC
    // body has not been parsed yet at this transport layer.
    const hasBearer = Boolean(req.headers["authorization"]);
    const kind = hasBearer ? "bearer" : "anon";
    const identifier = hasBearer
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

    const authErr = await validateAuth(
      Array.isArray(req.headers["authorization"])
        ? req.headers["authorization"][0]
        : req.headers["authorization"],
    );
    if (authErr) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: `${authErr}. Pass your API key as: Authorization: Bearer <key>` },
      });
    }
  }

  const ctx: LogCtx = {
    agent: ((req.headers["user-agent"] as string | undefined) ?? "unknown").slice(0, 80),
    ip_hint: ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0]?.trim() || "unknown",
    sessionId:
      (req.headers["mcp-session-id"] as string | undefined) ??
      (req.headers["x-session-id"] as string | undefined) ??
      "anonymous",
  };
  await requestContext.run(ctx, async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});

// Static server card for Smithery discovery
app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: SERVER_DESCRIPTION,
    },
    instructions: SERVER_INSTRUCTIONS,
    configSchema: {
      type: "object",
      properties: {
        propertyDomain: {
          type: "string",
          description: "Your vacation rental domain (e.g. example.com)",
          default: "",
        },
        language: {
          type: "string",
          description: "Default response language",
          default: "sv",
          enum: ["sv", "en", "de", "fr"],
        },
        currency: {
          type: "string",
          description: "Default currency for pricing",
          default: "SEK",
          enum: ["SEK", "EUR", "USD", "NOK", "DKK"],
        },
      },
      required: [],
    },
    tools: CATALOG_TOOLS,
    resources: CATALOG_RESOURCES,
    prompts: CATALOG_PROMPTS,
  });
});

app.listen(PORT, () => {
  console.log(`Federation MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Server card:  http://0.0.0.0:${PORT}/.well-known/mcp/server-card.json`);
});
