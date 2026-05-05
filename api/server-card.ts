import type { VercelRequest, VercelResponse } from "./_types.js";
import { PROMPTS, SERVER_INSTRUCTIONS, TOOLS } from "./mcp.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.2.7",
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
    tools: TOOLS,
    resources: [],
    prompts: PROMPTS,
  });
}
