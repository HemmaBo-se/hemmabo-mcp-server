import type { VercelRequest, VercelResponse } from "./_types.js";
import { PROMPTS, SERVER_INSTRUCTIONS, TOOLS } from "./mcp.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      version: "3.2.6",
    },
    instructions: SERVER_INSTRUCTIONS,
    configSchema: {
      type: "object",
      properties: {
        propertyDomain: {
          type: "string",
          description: "Your vacation rental domain (e.g. villaakerlyckan.se)",
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
    tools: TOOLS,
    resources: [],
    prompts: PROMPTS,
  });
}
