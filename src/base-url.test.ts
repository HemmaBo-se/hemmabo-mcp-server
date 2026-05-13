import test from "node:test";
import assert from "node:assert/strict";
import { baseUrl } from "../lib/base-url.js";
import type { VercelRequest } from "../api/_types.js";

function makeReq(headers: Record<string, string | string[]>): VercelRequest {
  return { headers, method: "GET", url: "/" } as unknown as VercelRequest;
}

test("baseUrl uses PUBLIC_BASE_URL override when set, stripping trailing slash", () => {
  const prev = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://booking.example.com/";
  try {
    assert.equal(
      baseUrl(makeReq({ host: "ignored.example.com" })),
      "https://booking.example.com"
    );
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prev;
  }
});

test("baseUrl prefers x-forwarded-proto + x-forwarded-host", () => {
  delete process.env.PUBLIC_BASE_URL;
  const req = makeReq({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "preview-abc.vercel.app",
    host: "internal.host",
  });
  assert.equal(baseUrl(req), "https://preview-abc.vercel.app");
});

test("baseUrl falls back to host header with https when no forwarded headers", () => {
  delete process.env.PUBLIC_BASE_URL;
  const req = makeReq({ host: "hemmabo-mcp-server.vercel.app" });
  assert.equal(baseUrl(req), "https://hemmabo-mcp-server.vercel.app");
});

test("baseUrl falls back to prod URL when host header missing", () => {
  delete process.env.PUBLIC_BASE_URL;
  const req = makeReq({});
  assert.equal(baseUrl(req), "https://hemmabo-mcp-server.vercel.app");
});

test("baseUrl unwraps array-valued forwarded headers (Node http allows them)", () => {
  delete process.env.PUBLIC_BASE_URL;
  const req = makeReq({
    "x-forwarded-proto": ["https", "http"],
    "x-forwarded-host": ["a.example.com", "b.example.com"],
  });
  assert.equal(baseUrl(req), "https://a.example.com");
});
