# ADR 0021: The Streamable HTTP transport keeps the MCP spec's contract

- Status: Accepted (CEO order «bygg 7.0.1», 2026-10-13)
- Date: 2026-10-13
- Decides for: `www.hemmabo.com/mcp` and `/mcp/chatgpt` (`serve()` in
  `api/mcp.ts`), the manifest's `protocol_version`, and the rules in
  `lib/mcp-transport.ts`.
- Not touched: the tools, their text, the auth model (ADR 0019), the rate
  limit, every other surface.

## Context

The endpoint is a stateless serverless function that hand-writes JSON-RPC
over HTTP. Measured on 2026-10-13 20:01 UTC against production (7.0.0), four
points of the MCP Streamable HTTP transport specification (2025-06-18,
`basic/transports`) were not kept, on both surfaces:

| Spec | Says | 7.0.0 did |
|---|---|---|
| Version negotiation | "If the server supports the requested protocol version, it MUST respond with the same version. Otherwise, the server MUST respond with another protocol version it supports." | `initialize` answered `2025-03-26` to every client, including one asking for `2025-06-18` or `2024-11-05`. |
| `MCP-Protocol-Version` header | "If the server receives a request with an invalid or unsupported MCP-Protocol-Version, it MUST respond with 400 Bad Request." Absent: "the server SHOULD assume protocol version 2025-03-26". | `1999-01-01` was served with 200. |
| Server-initiated stream | "The server MUST either return Content-Type: text/event-stream in response to this HTTP GET, or else return HTTP 405 Method Not Allowed". | GET with `Accept: text/event-stream` returned 200 `application/json`. |
| Origin | "Servers MUST validate the Origin header on all incoming connections to prevent DNS rebinding attacks." | Any Origin was served with 200 and `Access-Control-Allow-Origin: *`. |
| Envelope | The body is a JSON-RPC request, notification or response, or an array of them; otherwise "the server MUST return an HTTP error status code (e.g., 400 Bad Request)" with an optional JSON-RPC error that has no id. Notifications and responses: "202 Accepted with no body". | `{"foo":1}` was answered 200 with `-32601 Method not found: undefined`; a client response got the same. |

An agent's MCP client that negotiates `2025-06-18` (structured tool output,
`Tool.title`, which this server already emits) was told it had `2025-03-26`;
a conformance scan marks each row above as a defect of the endpoint, which
is the catalog's front door.

## Decision

1. **Versions.** The server speaks `2025-06-18`, `2025-03-26` and
   `2024-11-05` (`MCP_PROTOCOL_VERSIONS`, newest first). `initialize` echoes
   the client's version when it is one of these, else answers `2025-06-18`.
   The manifest's `protocol_version` is the newest one.
2. **Header.** A present `MCP-Protocol-Version` outside the list is 400 with a
   JSON-RPC `-32600` error and `id: null`. Absent is the spec's assumed
   `2025-03-26`; the server is stateless, so no behaviour depends on it.
3. **GET.** `Accept: text/event-stream` is 405 with
   `Allow: POST, HEAD, OPTIONS, DELETE`; the server opens no
   server-initiated stream. A plain GET keeps the transport-info body uptime
   monitors and `docs/connect` rely on, now also naming the protocol versions.
4. **Origin.** Checked first, on every method. No header passes (non-browser
   clients). A header passes when its host is the request's own host, a
   loopback address, this platform or the assistants' web apps
   (`hemmabo.com`, `claude.ai`, `claude.com`, `chatgpt.com`,
   `chat.openai.com`, with subdomains; ADR 0003 §2.7's list) or an exact
   entry of `MCP_ALLOWED_ORIGINS`. `null` and malformed values are refused.
   Refused is 403 with a JSON-RPC `-32600` error, before any CORS header. An
   allowed origin is reflected in `Access-Control-Allow-Origin` with
   `Vary: Origin`; no origin keeps `*`.
5. **Envelope.** Before auth, rate limit or dispatch, the body must be a
   JSON-RPC 2.0 request, notification or response, or a non-empty array of
   them: 400 `-32600` otherwise, 400 `-32700` when a string body is not JSON.
   Requests are answered (a batch with a batch); notifications and client
   responses are accepted and not answered (202). A request's unknown method
   stays `-32601` with the request's id.

## Consequences

- A browser page outside the allow list can no longer call `/mcp`. The
  operator adds one with `MCP_ALLOWED_ORIGINS` (Vercel env), no deploy of
  code. The ChatGPT widget talks to its host, never to `/mcp`, and is not
  affected.
- `scripts/release-chain-measure.mjs` initializes with `2025-06-18` and
  now reads it back; its check is on `serverInfo.version` and is unchanged.
- `src/mcp-transport.contract.test.ts` holds every row above on both
  surfaces. Measurement before and after lives in the 7.0.1 PR.
