/**
 * ChatGPT (OpenAI Apps) MCP surface — dedicated endpoint /mcp/chatgpt.
 *
 * Serves the SAME server as /mcp but restricted to the four read-only
 * discovery + cryptographic-verification tools (CHATGPT_TOOL_NAMES in
 * api/mcp.ts). No in-chat booking, checkout, or host onboarding — required
 * for OpenAI App Review (physical-goods-only / no digital services).
 *
 * The OpenAI app's MCP connector URL points HERE, not at /mcp. The default
 * /mcp surface and every other distribution surface (npm, MCP registry,
 * Smithery, Glama, Perplexity, Claude) stay byte-for-byte unchanged.
 */
import type { VercelRequest, VercelResponse } from "./_types.js";
import { serve } from "./mcp.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  return serve(req, res, "chatgpt");
}
