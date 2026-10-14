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

## Amendment 2026-10-14 (7.0.3): the 2025-11-25 revision is spoken

Measured 2026-10-14 07:27 UTC on production (7.0.2): a client that sends
`MCP-Protocol-Version: 2025-11-25`, the newest initialize-handshake revision
and the TypeScript SDK 1.x `LATEST_PROTOCOL_VERSION`, was answered 400 on GET, POST and DELETE, before the envelope
was read (OPTIONS and HEAD are answered earlier), because the list in decision 1 ended at 2025-06-18. The Vercel request log shows
the signature as pairs of `GET /mcp 400` and `POST /mcp 400` two minutes
apart, a client that sends the header before `initialize`; at the same time
the HemmaBo connector in a Smithery toolbox showed «No tools available».
Smithery's gateway is the attributed sender, not a captured one (its console
logs tool calls only); the after-measurement is the toolbox showing the six
tools once 7.0.3 is live. The conformance suite negotiates first and did not
see it.

Decision 1 now reads: the server speaks `2025-11-25`, `2025-06-18`,
`2025-03-26` and `2024-11-05`; the newest is offered to a client whose version
the server does not speak, and the manifest's `protocol_version` follows it.
Everything the 2025-11-25 revision adds (icons, tasks, URL-mode elicitation,
tools in sampling, OAuth discovery additions, SSE polling, elicitation
defaults) is optional for a server of this shape; the one MUST that touches
this transport, 403 for an invalid Origin, decision 4 already keeps. The one
MUST outside the transport, JSON Schema 2020-12 as the default dialect for a
schema without `$schema` (SEP-1613), the server already meets: its twelve tool
schemas use only `type`, `properties`, `required`, `additionalProperties`,
`items` (object form), `maxItems`, `minimum`, `pattern`, `enum`, `format` and
`description`, whose meaning is the same in draft-07 and 2020-12, so the
draft-07 Ajv validator in `lib/validate-args.ts` gives the same verdicts
(measured in the 7.0.3 review: all twelve compile under strict Ajv 2020-12 and
strict draft-07, fifteen sample argument sets with no difference). A schema
that adds a 2020-12-only keyword (`prefixItems`, `dependentRequired`,
`unevaluatedProperties`) moves the validator to Ajv 2020-12 first. The assumed
version without a header stays `2025-03-26` (the spec's rule).
`scripts/release-chain-measure.mjs` initializes with `2025-11-25` since 7.0.3
and sends the header on every call, so the production row is red on a server
that refuses the revision; its check on `serverInfo.version` is unchanged.
The manifest's `protocol_version` follows the list; the www mirror
`/.well-known/mcp` and `/.well-known/mcp-server` (hemmabo-smart-stays
`api/mcp-json.js`) carries its own value and follows in a separate
smart-stays PR. `src/mcp-transport.contract.test.ts` holds the Smithery
signature: the header `2025-11-25` on GET is 405 and on `initialize` is 200
with the same version echoed.

The specification's current revision is `2026-07-28`, a different era: no
`initialize`, the version and the client's capabilities in every request's
`_meta`, a mandatory `server/discover`, `Mcp-Method` and `Mcp-Name` headers,
no GET endpoint, `UnsupportedProtocolVersionError` (`-32022`) for a version
the server does not speak. This server stays in the handshake era and is not a
"dual-era" server; that is a separate decision. What 7.0.3 guarantees for a
2026-07-28 client is the fallback its own specification prescribes: a
`2026-07-28` header is answered 400 with the JSON-RPC error `-32600` and the
supported list, which is not a recognised modern error, so a dual-era client
reads a legacy server and retries with `initialize`, now landing on
`2025-11-25`. A modern-only client fails against every handshake-era server,
as the specification's compatibility matrix says. The contract test holds
this fallback signature too.
