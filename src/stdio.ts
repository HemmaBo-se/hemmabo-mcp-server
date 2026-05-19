#!/usr/bin/env node
/**
 * MCP Server — stdio transport (for Glama, Smithery, and local MCP clients)
 *
 * Same tools as index.ts but over stdin/stdout instead of HTTP.
 * Used by mcp-proxy in Glama's Docker build.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { executeTool } from "../lib/tools.js";
import { TOOL_SPECS, toZodShape } from "../lib/tool-definitions.js";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../lib/server-metadata.js";

// ── Environment ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Service-role client — bypasses RLS. Use only for writes and privileged reads.
let supabase: SupabaseClient | null = null;
// Anon client — subject to RLS. Use for all public read-only queries.
let reader: SupabaseClient | null = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠ Running without database — tools will return errors until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  reader = createClient(SUPABASE_URL, SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_KEY);
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
// stdio is single-session per process — no AsyncLocalStorage needed.

const REDACT_KEYS = ["stripe_token", "spt_token", "card_number", "email", "phone", "guest_name"];

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) =>
      REDACT_KEYS.some((r) => k.toLowerCase().includes(r)) ? [k, "[redacted]"] : [k, v]
    )
  );
}

const STDIO_AGENT = (process.env.STDIO_SESSION_ID ?? "stdio").slice(0, 80);

const _originalServerTool = server.tool.bind(server);
(server as unknown as { tool: unknown }).tool = (
  name: string,
  description: string,
  schema: unknown,
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
      // stdio uses stdout for the MCP protocol — log to stderr so we don't corrupt the transport.
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        tool: name,
        params: sanitizeParams(args ?? {}),
        duration_ms: Date.now() - start,
        result: ok ? "ok" : "error",
        error_msg: errMsg,
        agent: STDIO_AGENT,
        ip_hint: "stdio",
      }));
    }
  };
  return (_originalServerTool as unknown as (
    n: string, d: string, s: unknown, h: typeof wrapped
  ) => unknown)(name, description, schema, wrapped);
};

// ── Tool registration ──────────────────────────────────────────────
//
// All tools come from lib/tool-definitions.ts — single source of truth
// (#63). server.tool() is called from a loop so adding or removing a tool
// requires editing only TOOL_SPECS.

const toolHandlers: Record<string, "wrap" | "plain"> = {
  // These three wrap executeTool in try/catch with transport-specific error
  // messages, matching the historical stdio behaviour.
  "hemmabo_booking_checkout":   "wrap",
  "hemmabo_booking_cancel":     "wrap",
  "hemmabo_booking_reschedule": "wrap",
};

const ERROR_LABEL: Record<string, string> = {
  "hemmabo_booking_checkout":   "Checkout failed",
  "hemmabo_booking_cancel":     "Cancellation failed",
  "hemmabo_booking_reschedule": "Reschedule failed",
};

for (const spec of TOOL_SPECS) {
  const shape = toZodShape(spec.inputSchema);
  const handler = async (args: Record<string, unknown>) => {
    if (!supabase || !reader) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." }),
        }],
        isError: true,
      };
    }
    if (toolHandlers[spec.name] === "wrap") {
      try {
        return await executeTool(spec.name, args, { supabase, reader });
      } catch (error) {
        const msg = error instanceof Error ? error.message : ERROR_LABEL[spec.name] ?? "Tool error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    }
    return executeTool(spec.name, args, { supabase, reader });
  };
  server.tool(spec.name, spec.description, shape, handler as never);
}

// ── Start stdio transport ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
