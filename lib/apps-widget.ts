import { createHash } from "node:crypto";

/**
 * Public MCP endpoint in MCP registry (server.json, smithery.yaml, llms.txt).
 * Claude connector directory validates ui.domain against THIS URL's hash —
 * not the raw Vercel deployment hostname.
 */
export const HEMMABO_CANONICAL_MCP_ENDPOINT = "https://www.hemmabo.com/mcp";

/** @deprecated Use HEMMABO_CANONICAL_MCP_ENDPOINT */
export const HEMMABO_MCP_SERVER_URL = HEMMABO_CANONICAL_MCP_ENDPOINT;

export function mcpEndpointFromBaseUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/mcp`;
}

export function chatgptWidgetOriginFromMcpEndpoint(mcpEndpointUrl: string): string {
  return mcpEndpointUrl.replace(/\/mcp\/?$/, "");
}

/**
 * Claude MCP Apps require a sha256-derived subdomain, not a plain https origin.
 * @see https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility
 */
export function claudeMcpAppDomain(mcpServerUrl: string): string {
  return `${createHash("sha256").update(mcpServerUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

export const HEMMABO_CLAUDE_WIDGET_DOMAIN = claudeMcpAppDomain(HEMMABO_CANONICAL_MCP_ENDPOINT);

/** ChatGPT Apps SDK widget origin (https URL). */
export const HEMMABO_CHATGPT_WIDGET_DOMAIN = chatgptWidgetOriginFromMcpEndpoint(
  HEMMABO_CANONICAL_MCP_ENDPOINT
);

// v11 (2026-10-28): a verified offer's button uses only the server-checked
// booking URL (host's domain or www.), never the raw offer's. v10
// (2026-10-26): the booking button opens the host's page in an MCP Apps
// host (ui/open-link); a connected host caches the HTML per URI, so the bump
// makes Claude refetch it. v9 (W5c villkorssymmetrin): starred "Det lilla
// extra" + cancellation line on the compact card; What's included / Good to
// know / Terms groups in the unfolded view. URI bump = cache bust, same
// pattern as every prior widget revision.
export const HEMMABO_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v11.html";
// ChatGPT-native styling variant (Apps design guidelines: system fonts/colors,
// brand gold only on the CTA). Served ONLY on the /mcp/chatgpt surface; the
// Claude/MCP-Apps surface keeps v9 byte-identical.
export const HEMMABO_NATIVE_WIDGET_URI = "ui://hemmabo/verified-stay-offer-native-v1.html";
export const HEMMABO_PREVIOUS_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v10.html";
export const HEMMABO_V9_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v9.html";
export const HEMMABO_V8_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v8.html";
export const HEMMABO_V7_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v7.html";
export const HEMMABO_V6_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v6.html";
export const HEMMABO_V5_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v5.html";
export const HEMMABO_V4_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v4.html";
export const HEMMABO_V3_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v3.html";
export const HEMMABO_V2_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v2.html";
export const HEMMABO_V1_WIDGET_URI = "ui://hemmabo/verified-stay-offer-v1.html";
export const HEMMABO_LEGACY_WIDGET_URI = "ui://hemmabo/property-card";
export const HEMMABO_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

// Every URI this server has EVER published as a widget template. A ChatGPT
// app approval freezes the tool metadata — including the template URI — at
// submission time, so every historical URI must stay readable forever:
// dropping one turns the published app's card into "Failed to fetch
// template" for real users (observed live 2026-07-25 when v4–v7 were
// missing). resources/list advertises only the current URI; resources/read
// honors them all with the current HTML.
export const HEMMABO_ALL_WIDGET_URIS: readonly string[] = [
  HEMMABO_WIDGET_URI,
  HEMMABO_NATIVE_WIDGET_URI,
  HEMMABO_PREVIOUS_WIDGET_URI,
  HEMMABO_V9_WIDGET_URI,
  HEMMABO_V8_WIDGET_URI,
  HEMMABO_V7_WIDGET_URI,
  HEMMABO_V6_WIDGET_URI,
  HEMMABO_V5_WIDGET_URI,
  HEMMABO_V4_WIDGET_URI,
  HEMMABO_V3_WIDGET_URI,
  HEMMABO_V2_WIDGET_URI,
  HEMMABO_V1_WIDGET_URI,
  HEMMABO_LEGACY_WIDGET_URI,
];

const HEMMABO_IMAGE_STORAGE_ORIGIN = "https://vfalgymbhyfqsyxkvpqg.supabase.co";

// Widget CSP: exact hosts only. OpenAI's review held the render tool on
// 2026-10-11 with "a CSP is either missing or too broad" (wildcards). The card
// makes no fetch of its own, and its photos come from HemmaBo's image storage,
// which holds every HemmaBo node's photos. No node domain is listed, so every
// VRP node is treated the same; booking links open without a redirect allowlist.
const WIDGET_CONNECT_DOMAINS = ["https://www.hemmabo.com", "https://hemmabo.com"];
const WIDGET_RESOURCE_DOMAINS = [HEMMABO_IMAGE_STORAGE_ORIGIN, "https://www.hemmabo.com"];

const WIDGET_DESCRIPTION =
  "Renders a verified HemmaBo stay offer from MCP tool results with host-domain trust, live availability, final price, and the signed direct host-domain booking URL.";

// ADR 0020: on /mcp/chatgpt the stay-offer result gives the model this one
// line, and the widget resource describes itself with the same words, so the
// model hears one voice: the widget presents the offer, the model does not.
export const CHATGPT_WIDGET_MODEL_LINE =
  "HemmaBo's widget shows this verified offer: the host's own photos, dates, guests, signed total and the booking button. Write at most two sentences. Do not repeat these details, and do not add images or a card of your own.";

export function buildWidgetResourceMeta(mcpEndpointUrl: string, widgetDescription: string = WIDGET_DESCRIPTION) {
  const widgetOrigin = chatgptWidgetOriginFromMcpEndpoint(mcpEndpointUrl);
  const claudeDomain = claudeMcpAppDomain(mcpEndpointUrl);

  return {
    "openai/widgetDescription": widgetDescription,
    "openai/widgetPrefersBorder": true,
    "openai/widgetDomain": widgetOrigin,
    "openai/widgetCSP": {
      connect_domains: [...WIDGET_CONNECT_DOMAINS],
      resource_domains: [...WIDGET_RESOURCE_DOMAINS],
      redirect_domains: [] as string[],
    },
    ui: {
      prefersBorder: true,
      domain: claudeDomain,
      csp: {
        connectDomains: [...WIDGET_CONNECT_DOMAINS],
        resourceDomains: [...WIDGET_RESOURCE_DOMAINS],
      },
    },
  } as const;
}

export const HEMMABO_WIDGET_RESOURCE_META = buildWidgetResourceMeta(HEMMABO_CANONICAL_MCP_ENDPOINT);

export function buildWidgetResource(mcpEndpointUrl: string) {
  return {
    uri: HEMMABO_WIDGET_URI,
    name: "HemmaBo verified stay offer widget",
    description:
      "ChatGPT Apps SDK widget that renders a host-domain verified stay offer with live availability, final price, and the signed direct host-domain booking URL.",
    mimeType: HEMMABO_WIDGET_MIME_TYPE,
    _meta: buildWidgetResourceMeta(mcpEndpointUrl),
  };
}

export const HEMMABO_WIDGET_TOOL_META = {
  ui: {
    resourceUri: HEMMABO_WIDGET_URI,
  },
  "ui/resourceUri": HEMMABO_WIDGET_URI,
  "openai/outputTemplate": HEMMABO_WIDGET_URI,
  "openai/toolInvocation/invoking": "Verifying the host-domain stay offer...",
  "openai/toolInvocation/invoked": "Verified stay offer ready.",
} as const;

export function buildNativeWidgetResource(mcpEndpointUrl: string) {
  return {
    uri: HEMMABO_NATIVE_WIDGET_URI,
    name: "HemmaBo verified stay offer widget (ChatGPT native)",
    description:
      "ChatGPT Apps SDK widget that renders a host-domain verified stay offer with live availability, final price, and the signed direct host-domain booking URL, styled to ChatGPT's system look per the Apps design guidelines.",
    mimeType: HEMMABO_WIDGET_MIME_TYPE,
    _meta: buildWidgetResourceMeta(mcpEndpointUrl, CHATGPT_WIDGET_MODEL_LINE),
  };
}

export const HEMMABO_NATIVE_WIDGET_TOOL_META = {
  ...HEMMABO_WIDGET_TOOL_META,
  ui: {
    resourceUri: HEMMABO_NATIVE_WIDGET_URI,
  },
  "ui/resourceUri": HEMMABO_NATIVE_WIDGET_URI,
  "openai/outputTemplate": HEMMABO_NATIVE_WIDGET_URI,
} as const;
