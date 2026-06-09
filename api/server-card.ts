import type { VercelRequest, VercelResponse } from "./_types.js";
import { ANON_TOOLS, PROMPTS, RESOURCES, SERVER_DESCRIPTION, SERVER_INSTRUCTIONS, TOOLS } from "./mcp.js";
import { baseUrl } from "../lib/base-url.js";
import { readPackageJson } from "../lib/read-package-json.js";

const pkg = readPackageJson();

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Annotate each tool with its runtime auth requirement so registries
  // (Glama, Smithery, ChatGPT directory) can render an accurate
  // "no key required" badge without first issuing a tools/call probe.
  // Single source of truth: ANON_TOOLS in api/mcp.ts.
  const toolsWithAuth = TOOLS.map((t) => ({
    ...t,
    auth: ANON_TOOLS.has(t.name) ? "none" : "bearer",
  }));
  const base = baseUrl(req);

  res.json({
    serverInfo: {
      name: "hemmabo-mcp-server",
      title: "HemmaBo Host Booking Engine",
      version: pkg.version,
      description: SERVER_DESCRIPTION,
      homepage: "https://www.hemmabo.com",
      icon: `${base}/icon.png`,
      iconUrl: `${base}/icon.png`,
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
    resources: RESOURCES,
    prompts: PROMPTS,
  });
}
