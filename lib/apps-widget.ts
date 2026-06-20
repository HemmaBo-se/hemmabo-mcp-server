import { createHash } from "node:crypto";

/** Registered Claude/ChatGPT connector MCP endpoint — hash input for Claude ui.domain. */
export const HEMMABO_MCP_SERVER_URL = "https://hemmabo-mcp-server.vercel.app/mcp";

/** ChatGPT Apps SDK widget origin (https URL). */
export const HEMMABO_CHATGPT_WIDGET_DOMAIN = "https://hemmabo-mcp-server.vercel.app";

/**
 * Claude MCP Apps require a sha256-derived subdomain, not a plain https origin.
 * @see https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility
 */
export function claudeMcpAppDomain(mcpServerUrl: string): string {
  return `${createHash("sha256").update(mcpServerUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

export const HEMMABO_CLAUDE_WIDGET_DOMAIN = claudeMcpAppDomain(HEMMABO_MCP_SERVER_URL);

export const HEMMABO_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v5.html";
export const HEMMABO_PREVIOUS_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v4.html";
export const HEMMABO_V3_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v3.html";
export const HEMMABO_V2_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v2.html";
export const HEMMABO_V1_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v1.html";
export const HEMMABO_LEGACY_WIDGET_URI = "ui://hemmabo/property-card";
export const HEMMABO_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

const VILLA_AKERLYCKAN_SUPABASE_DOMAIN = "https://vfalgymbhyfqsyxkvpqg.supabase.co";

export const HEMMABO_WIDGET_RESOURCE_META = {
  "openai/widgetDescription":
    "Renders a verified HemmaBo stay offer from MCP tool results with host-domain trust, live availability, final price, and the signed direct host-domain booking URL.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetDomain": HEMMABO_CHATGPT_WIDGET_DOMAIN,
  "openai/widgetCSP": {
    connect_domains: [
      "https://hemmabo-mcp-server.vercel.app",
      "https://www.hemmabo.com",
      "https://*.supabase.co",
    ],
    resource_domains: [
      VILLA_AKERLYCKAN_SUPABASE_DOMAIN,
      "https://www.hemmabo.com",
      "https://*.hemmabo.com",
      "https://*.supabase.co",
      "https://*.vercel.app",
      "https://www.villaakerlyckan.se",
      "https://villaakerlyckan.se",
    ],
    redirect_domains: [
      "https://www.villaakerlyckan.se",
      "https://villaakerlyckan.se",
      "https://checkout.stripe.com",
      "https://*.stripe.com",
    ],
  },
  ui: {
    prefersBorder: true,
    domain: HEMMABO_CLAUDE_WIDGET_DOMAIN,
    csp: {
      connectDomains: [
        "https://hemmabo-mcp-server.vercel.app",
        "https://www.hemmabo.com",
        "https://*.supabase.co",
      ],
      resourceDomains: [
        VILLA_AKERLYCKAN_SUPABASE_DOMAIN,
        "https://www.hemmabo.com",
        "https://*.hemmabo.com",
        "https://*.supabase.co",
        "https://*.vercel.app",
        "https://www.villaakerlyckan.se",
        "https://villaakerlyckan.se",
      ],
    },
  },
} as const;

export const HEMMABO_WIDGET_TOOL_META = {
  ui: {
    resourceUri: HEMMABO_WIDGET_URI,
  },
  "openai/outputTemplate": HEMMABO_WIDGET_URI,
  "openai/toolInvocation/invoking": "Verifying the host-domain stay offer...",
  "openai/toolInvocation/invoked": "Verified stay offer ready.",
} as const;
