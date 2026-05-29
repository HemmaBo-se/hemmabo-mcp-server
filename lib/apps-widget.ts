export const HEMMABO_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v4.html";
export const HEMMABO_PREVIOUS_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v3.html";
export const HEMMABO_V2_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v2.html";
export const HEMMABO_V1_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v1.html";
export const HEMMABO_LEGACY_WIDGET_URI = "ui://hemmabo/property-card";
export const HEMMABO_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

const VILLA_AKERLYCKAN_SUPABASE_DOMAIN = "https://vfalgymbhyfqsyxkvpqg.supabase.co";

export const HEMMABO_WIDGET_RESOURCE_META = {
  "openai/widgetDescription":
    "Renders a verified HemmaBo stay offer from MCP tool results with host-domain trust, live availability, final price, and the signed direct host-domain booking URL.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetDomain": "https://hemmabo-mcp-server.vercel.app",
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
    domain: "https://hemmabo-mcp-server.vercel.app",
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
