/**
 * Contract: Idempotency-Key handling on ACP mutating endpoints (#66).
 *
 * Two layers of coverage:
 *
 * 1. Unit tests for lib/idempotency.ts pure helpers (fingerprint,
 *    normaliseIdempotencyKey, canonical JSON ordering).
 *
 * 2. Drift-guard source-text assertions that api/acp.ts wires the cache
 *    around mutating routes BEFORE the dispatcher runs, returns 409 on
 *    conflict, replays on hit, and only caches 2xx responses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  fingerprint,
  normaliseIdempotencyKey,
  lookup,
  record,
} from "../lib/idempotency.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// ── unit: fingerprint stability ─────────────────────────────────

test("fingerprint is stable across key ordering", () => {
  const a = fingerprint({ items: [{ id: "x", quantity: 2 }], check_in: "2026-07-01" });
  const b = fingerprint({ check_in: "2026-07-01", items: [{ quantity: 2, id: "x" }] });
  assert.equal(a, b, "canonical JSON must sort keys recursively");
});

test("fingerprint differs when body differs", () => {
  const a = fingerprint({ items: [{ id: "x", quantity: 2 }] });
  const b = fingerprint({ items: [{ id: "x", quantity: 3 }] });
  assert.notEqual(a, b);
});

test("fingerprint differs when array order differs", () => {
  // Arrays are NOT sorted — order is semantically meaningful (e.g. line-item
  // order in a multi-property checkout).
  const a = fingerprint({ items: [{ id: "a" }, { id: "b" }] });
  const b = fingerprint({ items: [{ id: "b" }, { id: "a" }] });
  assert.notEqual(a, b);
});

// ── unit: header validation ─────────────────────────────────────

test("normaliseIdempotencyKey accepts UUID-like keys", () => {
  assert.equal(
    normaliseIdempotencyKey("01HXY3Z9-K8P-4T2W-BQ7N-MF6V2A1JC0RX"),
    "01HXY3Z9-K8P-4T2W-BQ7N-MF6V2A1JC0RX"
  );
});

test("normaliseIdempotencyKey trims whitespace", () => {
  assert.equal(normaliseIdempotencyKey("  abc-123  "), "abc-123");
});

test("normaliseIdempotencyKey rejects empty", () => {
  assert.equal(normaliseIdempotencyKey(""), null);
  assert.equal(normaliseIdempotencyKey("   "), null);
});

test("normaliseIdempotencyKey rejects oversized", () => {
  assert.equal(normaliseIdempotencyKey("a".repeat(201)), null);
});

test("normaliseIdempotencyKey rejects unsafe chars", () => {
  // Spaces, newlines, slashes, quotes — anything outside [A-Za-z0-9._:-].
  assert.equal(normaliseIdempotencyKey("abc def"), null);
  assert.equal(normaliseIdempotencyKey("abc\nx"), null);
  assert.equal(normaliseIdempotencyKey("abc/x"), null);
  assert.equal(normaliseIdempotencyKey('abc"x'), null);
});

test("normaliseIdempotencyKey rejects non-string", () => {
  assert.equal(normaliseIdempotencyKey(42 as unknown), null);
  assert.equal(normaliseIdempotencyKey(null), null);
  assert.equal(normaliseIdempotencyKey(undefined), null);
});

// ── unit: lookup + record with mocked Upstash ───────────────────

function mockUpstash() {
  const store = new Map<string, string>();
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("/get/")) {
      const key = decodeURIComponent(url.split("/get/")[1]!);
      const value = store.get(key) ?? null;
      return new Response(JSON.stringify({ result: value }), { status: 200 });
    }
    if (url.endsWith("/pipeline")) {
      const body = JSON.parse((init?.body as string) ?? "[]") as unknown[][];
      for (const cmd of body) {
        if (cmd[0] === "SET") {
          const [, key, value] = cmd as [string, string, string];
          if (!store.has(key)) store.set(key, value);
        }
      }
      return new Response(JSON.stringify([{ result: "OK" }]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const env = {
    UPSTASH_REDIS_REST_URL: "https://mock.upstash.test",
    UPSTASH_REDIS_REST_TOKEN: "mock-token",
  } as unknown as NodeJS.ProcessEnv;
  return { fetchMock, env, store };
}

test("lookup returns 'miss' when key absent", async () => {
  const { fetchMock, env } = mockUpstash();
  const fp = fingerprint({ a: 1 });
  const out = await lookup("idem-key-1", fp, { fetch: fetchMock, env });
  assert.equal(out.kind, "miss");
});

test("record then lookup returns 'hit' with cached body", async () => {
  const { fetchMock, env } = mockUpstash();
  const fp = fingerprint({ a: 1 });
  await record("idem-key-2", fp, 201, { id: "ck_1", ok: true }, { fetch: fetchMock, env });
  const out = await lookup("idem-key-2", fp, { fetch: fetchMock, env });
  assert.equal(out.kind, "hit");
  if (out.kind === "hit") {
    assert.equal(out.status, 201);
    assert.deepEqual(out.body, { id: "ck_1", ok: true });
  }
});

test("lookup returns 'conflict' when body fingerprint differs", async () => {
  const { fetchMock, env } = mockUpstash();
  const fp1 = fingerprint({ a: 1 });
  const fp2 = fingerprint({ a: 2 });
  await record("idem-key-3", fp1, 201, { ok: true }, { fetch: fetchMock, env });
  const out = await lookup("idem-key-3", fp2, { fetch: fetchMock, env });
  assert.equal(out.kind, "conflict");
});

test("fail-open: missing Upstash env returns 'miss' without network call", async () => {
  let called = false;
  const fetchMock: typeof fetch = async () => {
    called = true;
    return new Response("nope", { status: 500 });
  };
  const out = await lookup("k", "fp", { fetch: fetchMock, env: {} as NodeJS.ProcessEnv });
  assert.equal(out.kind, "miss");
  assert.equal(called, false, "must not contact backend when not configured");
});

test("fail-open: Upstash network error returns 'miss'", async () => {
  const fetchMock: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const env = {
    UPSTASH_REDIS_REST_URL: "https://mock.upstash.test",
    UPSTASH_REDIS_REST_TOKEN: "t",
  } as unknown as NodeJS.ProcessEnv;
  const out = await lookup("k", "fp", { fetch: fetchMock, env });
  assert.equal(out.kind, "miss");
});

// ── drift guard: api/acp.ts wiring ──────────────────────────────

async function readAcp(): Promise<string> {
  return readFile(resolve(ROOT, "api/acp.ts"), "utf8");
}

test("api/acp.ts imports idempotency helpers", async () => {
  const src = await readAcp();
  assert.match(
    src,
    /from\s+["']\.\.\/lib\/idempotency\.js["']/,
    "must import from lib/idempotency.js"
  );
  assert.match(src, /\bidemLookup\b/);
  assert.match(src, /\bidemRecord\b/);
  assert.match(src, /\bidemFingerprint\b/);
  assert.match(src, /\bnormaliseIdempotencyKey\b/);
});

test("api/acp.ts reads Idempotency-Key header on mutations", async () => {
  const src = await readAcp();
  assert.match(
    src,
    /req\.headers\[\s*["']idempotency-key["']\s*\]/i,
    "must read Idempotency-Key header"
  );
});

test("api/acp.ts returns 409 on idempotency conflict", async () => {
  const src = await readAcp();
  assert.match(
    src,
    /idempotency_conflict/,
    "must surface conflict as a distinct error code"
  );
  assert.match(src, /status\(\s*409\s*\)/);
});

test("api/acp.ts returns 400 on malformed Idempotency-Key", async () => {
  const src = await readAcp();
  assert.match(src, /invalid_idempotency_key/);
});

test("api/acp.ts only caches 2xx responses", async () => {
  const src = await readAcp();
  // The caching gate must check the captured status falls in 2xx.
  assert.match(
    src,
    /capturedStatus\s*>=\s*200\s*&&\s*capturedStatus\s*<\s*300/,
    "must only record() responses with 2xx status"
  );
});

test("api/acp.ts sets Idempotent-Replay header on cache hit", async () => {
  const src = await readAcp();
  assert.match(
    src,
    /Idempotent-Replay/,
    "must signal a replay so callers can distinguish a cached response"
  );
});
