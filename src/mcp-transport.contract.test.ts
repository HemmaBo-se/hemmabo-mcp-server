/**
 * Contract test for the MCP Streamable HTTP transport (ADR 0021).
 *
 * The spec (2025-06-18, basic/transports) on the four points 7.0.1 fixes:
 *   - initialize: echo the client's protocolVersion when supported, else answer
 *     with a version the server supports (the latest).
 *   - MCP-Protocol-Version header: absent → assume 2025-03-26; invalid or
 *     unsupported → 400.
 *   - GET with Accept: text/event-stream: an SSE stream or 405.
 *   - Origin: validated on every request.
 *   - A body that is not a JSON-RPC request, notification or response: 400
 *     with a JSON-RPC error and no id; notifications and responses → 202.
 *
 * Both surfaces are driven through the same mock request/response harness the
 * other transport tests use (mcp-head, mcp-www-authenticate): api/mcp.ts
 * default export for /mcp, serve(..., "chatgpt") for /mcp/chatgpt.
 *
 * Run: npx tsx --test src/mcp-transport.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_ASSUMED_PROTOCOL_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  checkOrigin,
  negotiateProtocolVersion,
  parseJsonRpcBody,
} from "../lib/mcp-transport.js";

type Captured = { status: number; headers: Record<string, string>; body: unknown; ended: boolean };

async function request(
  surface: "full" | "chatgpt",
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<Captured> {
  const mod = await import("../api/mcp.js");
  const captured: Captured = { status: 200, headers: {}, body: undefined, ended: false };
  const res = {
    setHeader: (k: string, v: string) => { captured.headers[k.toLowerCase()] = v; },
    status: (code: number) => { captured.status = code; return res; },
    json: (body: unknown) => { captured.body = body; return res; },
    end: () => { captured.ended = true; return res; },
  };
  const req = {
    method: init.method,
    headers: {
      host: "www.hemmabo.com",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "www.hemmabo.com",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.headers ?? {}),
    },
    body: init.body,
  };
  if (surface === "full") await mod.default(req as never, res as never);
  else await mod.serve(req as never, res as never, "chatgpt");
  return captured;
}

function initialize(protocolVersion: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "contract", version: "1" } },
  };
}

type RpcError = { jsonrpc: string; id: unknown; error: { code: number; message: string } };
type InitResult = { result: { protocolVersion: string } };

const SURFACES = ["full", "chatgpt"] as const;

describe("protocol version negotiation (initialize)", () => {
  it("lists the supported versions newest first, 2025-06-18 on top", () => {
    assert.deepEqual([...MCP_PROTOCOL_VERSIONS], ["2025-06-18", "2025-03-26", "2024-11-05"]);
    assert.equal(MCP_LATEST_PROTOCOL_VERSION, "2025-06-18");
    assert.equal(MCP_ASSUMED_PROTOCOL_VERSION, "2025-03-26");
  });

  it("echoes every supported version and offers the latest to an unknown one", () => {
    for (const v of MCP_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(v), v);
    assert.equal(negotiateProtocolVersion("1999-01-01"), MCP_LATEST_PROTOCOL_VERSION);
    assert.equal(negotiateProtocolVersion(undefined), MCP_LATEST_PROTOCOL_VERSION);
    assert.equal(negotiateProtocolVersion(42), MCP_LATEST_PROTOCOL_VERSION);
  });

  for (const surface of SURFACES) {
    it(`${surface}: initialize echoes 2025-06-18, 2025-03-26 and 2024-11-05`, async () => {
      for (const v of MCP_PROTOCOL_VERSIONS) {
        const r = await request(surface, { method: "POST", body: initialize(v) });
        assert.equal(r.status, 200);
        assert.equal((r.body as InitResult).result.protocolVersion, v);
      }
    });

    it(`${surface}: initialize answers an unsupported version with the latest`, async () => {
      const r = await request(surface, { method: "POST", body: initialize("2099-12-31") });
      assert.equal(r.status, 200);
      assert.equal((r.body as InitResult).result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
    });
  }
});

describe("MCP-Protocol-Version header", () => {
  for (const surface of SURFACES) {
    it(`${surface}: a supported header passes, an unsupported one is 400 with a JSON-RPC error and no id`, async () => {
      const ok = await request(surface, {
        method: "POST",
        headers: { "mcp-protocol-version": "2025-06-18" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      });
      assert.equal(ok.status, 200);

      const bad = await request(surface, {
        method: "POST",
        headers: { "mcp-protocol-version": "1999-01-01" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      });
      assert.equal(bad.status, 400);
      const err = bad.body as RpcError;
      assert.equal(err.jsonrpc, "2.0");
      assert.equal(err.id, null);
      assert.equal(err.error.code, -32600);
      assert.match(err.error.message, /Unsupported MCP-Protocol-Version/);
      assert.match(err.error.message, /2025-06-18, 2025-03-26, 2024-11-05/);
    });

    it(`${surface}: no header is the spec's assumed version — the request is served`, async () => {
      const r = await request(surface, { method: "POST", body: { jsonrpc: "2.0", id: 7, method: "ping" } });
      assert.equal(r.status, 200);
      assert.equal((r.body as { id: number }).id, 7);
    });
  }

  it("the header is on the CORS allow list so a browser client may send it", async () => {
    const r = await request("full", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.match(r.headers["access-control-allow-headers"], /\bMcp-Protocol-Version\b/);
  });
});

describe("GET: transport info, or 405 for a server-initiated SSE stream", () => {
  for (const surface of SURFACES) {
    it(`${surface}: GET with Accept: text/event-stream is 405 with an Allow header`, async () => {
      const r = await request(surface, { method: "GET", headers: { accept: "text/event-stream" } });
      assert.equal(r.status, 405);
      assert.equal(r.headers["allow"], "POST, HEAD, OPTIONS, DELETE");
      assert.equal((r.body as { error: string }).error, "Method not allowed");
    });

    it(`${surface}: plain GET keeps the transport-info body and names the protocol versions`, async () => {
      const r = await request(surface, { method: "GET", headers: { accept: "*/*" } });
      assert.equal(r.status, 200);
      const body = r.body as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(body.transport, "streamable-http");
      assert.equal(typeof body.version, "string");
      assert.deepEqual(body.protocolVersions, [...MCP_PROTOCOL_VERSIONS]);
      assert.equal(body.assumedProtocolVersion, MCP_ASSUMED_PROTOCOL_VERSION);
    });
  }

  it("HEAD stays 200 and DELETE stays 202", async () => {
    assert.equal((await request("full", { method: "HEAD" })).status, 200);
    assert.equal((await request("full", { method: "DELETE" })).status, 202);
  });
});

describe("Origin validation", () => {
  it("no Origin (a non-browser client) passes; the CORS header stays *", () => {
    assert.deepEqual(checkOrigin(undefined, "www.hemmabo.com"), { ok: true });
    assert.deepEqual(checkOrigin("", "www.hemmabo.com"), { ok: true });
  });

  it("allows this platform, the assistants' web apps, loopback, the request's own host and MCP_ALLOWED_ORIGINS", () => {
    for (const origin of [
      "https://www.hemmabo.com",
      "https://hemmabo.com",
      "https://claude.ai",
      "https://claude.com",
      "https://chatgpt.com",
      "https://chat.openai.com",
      "http://localhost:6274",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      assert.deepEqual(checkOrigin(origin, "www.hemmabo.com", ""), { ok: true, origin }, origin);
    }
    assert.deepEqual(checkOrigin("https://preview.example", "preview.example", ""), { ok: true, origin: "https://preview.example" });
    assert.deepEqual(checkOrigin("https://preview.example", "preview.example:443", ""), { ok: true, origin: "https://preview.example" });
    assert.deepEqual(
      checkOrigin("https://inspector.example", "www.hemmabo.com", "https://one.example, https://inspector.example"),
      { ok: true, origin: "https://inspector.example" },
    );
  });

  it("rejects an unknown origin, a look-alike host, an opaque origin and a malformed header", () => {
    assert.equal(checkOrigin("https://evil.example", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("https://hemmabo.com.evil.example", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("https://notclaude.ai", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("null", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("www.hemmabo.com", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("https://www.hemmabo.com/path", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("file:///etc/passwd", "www.hemmabo.com", "").ok, false);
    assert.equal(checkOrigin("https://inspector.example", "www.hemmabo.com", "https://other.example").ok, false);
  });

  for (const surface of SURFACES) {
    it(`${surface}: a disallowed Origin is 403 with a JSON-RPC error before any CORS header`, async () => {
      const r = await request(surface, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      });
      assert.equal(r.status, 403);
      const err = r.body as RpcError;
      assert.equal(err.id, null);
      assert.equal(err.error.code, -32600);
      assert.match(err.error.message, /Origin not allowed/);
      assert.equal(r.headers["access-control-allow-origin"], undefined);
    });

    it(`${surface}: a disallowed Origin is 403 on the preflight too`, async () => {
      const r = await request(surface, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      assert.equal(r.status, 403);
    });

    it(`${surface}: an allowed Origin is served and reflected with Vary: Origin`, async () => {
      const r = await request(surface, {
        method: "POST",
        headers: { origin: "https://claude.ai" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers["access-control-allow-origin"], "https://claude.ai");
      assert.equal(r.headers["vary"], "Origin");
    });
  }
});

describe("JSON-RPC envelope", () => {
  it("accepts a request, a notification, a response and a batch of them", () => {
    const req = parseJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.ok(req.ok && req.requests.length === 1 && req.batch === false && req.responses === 0);

    const note = parseJsonRpcBody({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.ok(note.ok && note.requests.length === 1 && note.responses === 0);

    const resp = parseJsonRpcBody({ jsonrpc: "2.0", id: 1, result: {} });
    assert.ok(resp.ok && resp.requests.length === 0 && resp.responses === 1);

    const batch = parseJsonRpcBody([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "x" } },
    ]);
    assert.ok(batch.ok && batch.batch === true && batch.requests.length === 1 && batch.responses === 1);

    const text = parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    assert.ok(text.ok && text.requests.length === 1);
  });

  it("rejects what is not JSON-RPC 2.0: -32600 Invalid Request, -32700 Parse error", () => {
    const invalid = [
      undefined,
      null,
      "",
      [],
      "   ",
      42,
      { foo: 1 },
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: { a: 1 }, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
      { jsonrpc: "2.0", method: 5 },
      [{ jsonrpc: "2.0", id: 1, method: "ping" }, { foo: 1 }],
      [[{ jsonrpc: "2.0", id: 1, method: "ping" }]],
    ];
    for (const body of invalid) {
      const v = parseJsonRpcBody(body);
      assert.equal(v.ok, false, JSON.stringify(body));
      assert.equal(v.ok ? 0 : v.code, -32600, JSON.stringify(body));
    }
    for (const body of ["{bad", "ping"]) {
      const parse = parseJsonRpcBody(body);
      assert.equal(parse.ok ? 0 : parse.code, -32700, body);
    }
  });

  for (const surface of SURFACES) {
    it(`${surface}: an invalid envelope is 400 with a JSON-RPC error and no id`, async () => {
      for (const body of [{ foo: 1 }, [], undefined, "", { jsonrpc: "1.0", id: 1, method: "ping" }]) {
        const r = await request(surface, { method: "POST", body });
        assert.equal(r.status, 400, JSON.stringify(body));
        const err = r.body as RpcError;
        assert.equal(err.jsonrpc, "2.0");
        assert.equal(err.id, null);
        assert.equal(err.error.code, -32600);
      }
      const r = await request(surface, { method: "POST", body: "{bad" });
      assert.equal(r.status, 400);
      assert.equal((r.body as RpcError).error.code, -32700);
    });

    it(`${surface}: a notification or a client response is 202 with no body`, async () => {
      for (const body of [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
        { jsonrpc: "2.0", id: 1, result: {} },
        [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 3, result: {} }],
      ]) {
        const r = await request(surface, { method: "POST", body });
        assert.equal(r.status, 202, JSON.stringify(body));
        assert.equal(r.ended, true);
        assert.equal(r.body, undefined);
      }
    });

    it(`${surface}: a batch is answered with a batch holding one reply per request`, async () => {
      const r = await request(surface, {
        method: "POST",
        body: [
          { jsonrpc: "2.0", id: "a", method: "ping" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: "b", method: "no/such/method" },
        ],
      });
      assert.equal(r.status, 200);
      const replies = r.body as Array<{ id: string; error?: { code: number } }>;
      assert.ok(Array.isArray(replies));
      assert.deepEqual(replies.map((x) => x.id), ["a", "b"]);
      assert.equal(replies[1].error?.code, -32601);
    });

    it(`${surface}: an unknown method on a request is still -32601, answered with its id`, async () => {
      const r = await request(surface, { method: "POST", body: { jsonrpc: "2.0", id: 9, method: "no/such/method" } });
      assert.equal(r.status, 200);
      const err = r.body as RpcError;
      assert.equal(err.id, 9);
      assert.equal(err.error.code, -32601);
    });
  }
});
