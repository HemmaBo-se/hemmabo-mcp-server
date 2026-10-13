/**
 * MCP Streamable HTTP transport contract (ADR 0021).
 *
 * The pure rules of the transport, kept out of api/mcp.ts so they are tested
 * without a request: which protocol versions the server speaks and how a
 * client's version is answered, which Origins may open the endpoint from a
 * browser, and what a JSON-RPC envelope must look like before it is
 * dispatched. api/mcp.ts applies them in this order: Origin, method, the
 * MCP-Protocol-Version header, the envelope.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

// ── Protocol versions ────────────────────────────────────────────

/**
 * Newest first. The first entry is what the server offers a client whose
 * requested version it does not speak ("the server SHOULD respond with the
 * latest version it supports").
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

/**
 * What the spec tells a server to assume when a request carries no
 * MCP-Protocol-Version header: "the server SHOULD assume protocol version
 * 2025-03-26" (backwards compatibility). This server is stateless, so the
 * assumption changes no behaviour; it is recorded so the GET transport-info
 * body and the ADR say the same thing.
 */
export const MCP_ASSUMED_PROTOCOL_VERSION: McpProtocolVersion = "2025-03-26";

export function isSupportedProtocolVersion(value: unknown): value is McpProtocolVersion {
  return typeof value === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/**
 * initialize: "If the server supports the requested protocol version, it MUST
 * respond with the same version. Otherwise, the server MUST respond with
 * another protocol version it supports."
 */
export function negotiateProtocolVersion(requested: unknown): McpProtocolVersion {
  return isSupportedProtocolVersion(requested) ? requested : MCP_LATEST_PROTOCOL_VERSION;
}

// ── Origin ───────────────────────────────────────────────────────

/**
 * Hosts a browser-based client may open the endpoint from, with their
 * subdomains: this platform, and the assistants that embed a connector in a
 * web app (ADR 0003 §2.7). Non-browser clients (Claude Desktop, registries,
 * crawlers) send no Origin and are not affected. An operator extends the list
 * with MCP_ALLOWED_ORIGINS (comma-separated full origins, scheme included).
 */
export const MCP_ALLOWED_ORIGIN_HOSTS = [
  "hemmabo.com",
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type OriginVerdict = { ok: true; origin?: string } | { ok: false; reason: string };

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

/**
 * "Servers MUST validate the Origin header on all incoming connections to
 * prevent DNS rebinding attacks." No header: not a browser, allowed. A header
 * is allowed when it is a well-formed http(s) origin whose host is the
 * request's own host, a loopback address, one of MCP_ALLOWED_ORIGIN_HOSTS or
 * their subdomains, or an exact entry of MCP_ALLOWED_ORIGINS. "null" (a
 * sandboxed iframe, a redirect from an opaque origin) is rejected.
 */
export function checkOrigin(
  originHeader: string | string[] | undefined,
  requestHost: string | string[] | undefined,
  extraAllowed: string | undefined = process.env.MCP_ALLOWED_ORIGINS,
): OriginVerdict {
  const origin = firstHeader(originHeader);
  if (origin === undefined || origin === "") return { ok: true };
  if (origin === "null") return { ok: false, reason: "opaque origin" };

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: "malformed origin" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) {
    return { ok: false, reason: "malformed origin" };
  }

  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) return { ok: true, origin };

  const ownHost = firstHeader(requestHost)?.toLowerCase().replace(/:\d+$/, "");
  if (ownHost && hostname === ownHost) return { ok: true, origin };

  if (MCP_ALLOWED_ORIGIN_HOSTS.some((allowed) => hostMatches(hostname, allowed))) {
    return { ok: true, origin };
  }

  const extra = (extraAllowed ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(url.origin)) return { ok: true, origin };

  return { ok: false, reason: "origin not allowed" };
}

// ── JSON-RPC envelope ────────────────────────────────────────────

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  id?: JsonRpcId;
  params?: Record<string, unknown>;
};

export type EnvelopeVerdict =
  | {
      ok: true;
      /** Requests and notifications, in order. Client responses are counted, not dispatched. */
      requests: JsonRpcRequest[];
      /** The body was a JSON array; the reply is one too. */
      batch: boolean;
      responses: number;
    }
  | { ok: false; code: -32600 | -32700; message: string };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * What the transport accepts on POST: a JSON-RPC 2.0 request, notification or
 * response, or a non-empty array of them. A message that is none of these is
 * an Invalid Request (-32600); a body that is not JSON is a Parse error
 * (-32700). Both are answered with HTTP 400 and no id, as the spec asks
 * ("the server MUST return an HTTP error status code ... MAY comprise a
 * JSON-RPC error response that has no id").
 */
export function parseJsonRpcBody(body: unknown): EnvelopeVerdict {
  let value = body;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, code: PARSE_ERROR, message: "Parse error: the body is not valid JSON" };
    }
  }
  if (value === undefined || value === null || value === "" || (typeof value === "string" && value.trim() === "")) {
    return { ok: false, code: INVALID_REQUEST, message: "Invalid Request: the body is empty" };
  }

  const batch = Array.isArray(value);
  const messages: unknown[] = batch ? (value as unknown[]) : [value];
  if (batch && messages.length === 0) {
    return { ok: false, code: INVALID_REQUEST, message: "Invalid Request: the batch is empty" };
  }

  const requests: JsonRpcRequest[] = [];
  let responses = 0;
  for (const [index, msg] of messages.entries()) {
    const where = batch ? ` (message ${index})` : "";
    if (!isPlainObject(msg)) {
      return { ok: false, code: INVALID_REQUEST, message: `Invalid Request: a message must be a JSON object${where}` };
    }
    if (msg.jsonrpc !== "2.0") {
      return { ok: false, code: INVALID_REQUEST, message: `Invalid Request: jsonrpc must be "2.0"${where}` };
    }
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && !isId(msg.id)) {
        return { ok: false, code: INVALID_REQUEST, message: `Invalid Request: id must be a string or a number${where}` };
      }
      if (msg.params !== undefined && !isPlainObject(msg.params)) {
        return { ok: false, code: INVALID_REQUEST, message: `Invalid Request: params must be a JSON object${where}` };
      }
      requests.push(msg as JsonRpcRequest);
      continue;
    }
    if (("result" in msg || "error" in msg) && (isId(msg.id) || msg.id === null)) {
      responses += 1;
      continue;
    }
    return { ok: false, code: INVALID_REQUEST, message: `Invalid Request: a message needs a method, or an id with a result or error${where}` };
  }
  return { ok: true, requests, batch, responses };
}

/** GET with this Accept opens a server-initiated SSE stream, which this stateless server does not offer. */
export function acceptsEventStream(accept: string | string[] | undefined): boolean {
  const value = firstHeader(accept);
  return typeof value === "string" && /\btext\/event-stream\b/i.test(value);
}
