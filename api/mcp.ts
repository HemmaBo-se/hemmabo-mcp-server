import type { VercelRequest, VercelResponse } from "./_types.js";
import baseHandler, { ANON_TOOLS } from "./mcp-base.js";
import { executeVrpTool, isVrpToolName, VRP_TOOL_NAMES } from "../lib/vrp.js";

// Keep the existing MCP transport implementation intact, but extend its
// anonymous allowlist for neutral VRP discovery tools. The exported functions
// from mcp-base close over this Set object, so mutating it here updates the
// auth gate without duplicating the whole transport.
const anonTools = ANON_TOOLS as unknown as Set<string>;
for (const toolName of VRP_TOOL_NAMES) anonTools.add(toolName);

export * from "./mcp-base.js";

function getSingleVrpToolCall(body: unknown): { id?: number | string; name: string; args: Record<string, unknown> } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const msg = body as { method?: unknown; id?: unknown; params?: unknown };
  if (msg.method !== "tools/call") return null;
  const params = msg.params && typeof msg.params === "object" ? msg.params as { name?: unknown; arguments?: unknown } : null;
  const name = typeof params?.name === "string" ? params.name : "";
  if (!isVrpToolName(name)) return null;
  const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : undefined;
  return { id, name, args };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const vrpCall = req.method === "POST" ? getSingleVrpToolCall(req.body) : null;
  if (vrpCall) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    try {
      const result = await executeVrpTool(vrpCall.name, vrpCall.args);
      return res.json({ jsonrpc: "2.0", id: vrpCall.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return res.status(500).json({ jsonrpc: "2.0", id: vrpCall.id, error: { code: -32603, message } });
    }
  }

  return baseHandler(req, res);
}
