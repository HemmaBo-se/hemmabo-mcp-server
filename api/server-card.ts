import type { VercelRequest, VercelResponse } from "./_types.js";
import { ANON_TOOLS, PROMPTS, SERVER_INSTRUCTIONS, TOOLS } from "./mcp.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  // Annotate each tool with its runtime auth requirement so registries
  // (Glama, Smithery, ChatGPT directory) can render an accurate
  // "no key required" badge without first issuing a tools/call probe.
  // Single source of truth: ANON_TOOLS in api/mcp.ts.
  const toolsWithAuth = TOOLS.map((t) => ({
    ...t,
    auth: ANON_TOOLS.has(t.name) ? "none" : "bearer",
  }));

  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.2.9",
    },
    instructions: SERVER_INSTRUCTIONS,
    configSchema: {
      type: "object",
      properties: {
        propertyDomain: {
          type: "string",
          description: "Your vacation rental domain (e.g. villaakerlyckan.se)",
        },
        region: {
          type: "string",
          description: "Default region to search in (e.g. 'Skåne', 'Toscana', 'Bavaria'). Can be overridden per request.",
        },
        language: {
          type: "string",
          description: "Preferred response language (ISO 639-1 code, e.g. 'en', 'sv', 'de', 'it', 'fr', 'es'). Defaults to English.",
        },
        currency: {
          type: "string",
          description: "Preferred display currency (ISO 4217, e.g. 'EUR', 'SEK', 'USD'). Defaults to the property's native currency.",
        },
      },
      required: [],
    },
    tools: toolsWithAuth,
    resources: [],
    prompts: PROMPTS,
  });
}
