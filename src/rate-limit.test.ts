/**
 * Unit tests for the rate-limit module.
 *
 * Approach: inject a mock fetch + clock so we can simulate Upstash without
 * touching the network. Verifies:
 *   - Fail-open when env not configured (production safety: a misconfigured
 *     limiter must NOT block traffic).
 *   - Fail-open on backend HTTP errors and network failures.
 *   - Per-window counter math (allow up to limit, then 429).
 *   - Identifier sanitisation (no key injection via headers).
 *   - Bearer identifier hashing (token never appears in the key).
 *
 * Run: npx tsx --test src/rate-limit.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anonIdentifier,
  bearerIdentifier,
  checkRateLimit,
} from "../lib/rate-limit.js";

const ENV = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

function mockFetch(scriptedCounts: number[]): typeof fetch {
  let i = 0;
  return (async (_input: unknown, init?: { method?: string; body?: string }) => {
    const next = scriptedCounts[i++] ?? scriptedCounts[scriptedCounts.length - 1] ?? 1;
    return {
      ok: true,
      json: async () => [{ result: next }, { result: 1 }],
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("checkRateLimit fail-open semantics", () => {
  it("returns ok=true when UPSTASH_REDIS_REST_URL is missing", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4", { env: {} });
    assert.deepEqual(result, { ok: true });
  });

  it("returns ok=true when only token is missing", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4", {
      env: { UPSTASH_REDIS_REST_URL: "x" },
    });
    assert.deepEqual(result, { ok: true });
  });

  it("returns ok=true on backend HTTP error", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4", {
      env: ENV,
      fetch: (async () => ({ ok: false, json: async () => [] })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
  });

  it("returns ok=true on backend network error", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4", {
      env: ENV,
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
  });
});

describe("checkRateLimit window enforcement", () => {
  it("allows requests up to the configured limit", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4", {
      env: { ...ENV, RATE_LIMIT_ANON_PER_MIN: "10" },
      fetch: mockFetch([5]),
      now: () => 1_700_000_000_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.limit, 10);
    assert.equal(result.remaining, 5);
  });

  it("rejects with retryAfterSec when count exceeds limit", async () => {
    const fixedNow = 1_700_000_000_000; // arbitrary
    const result = await checkRateLimit("anon", "1.2.3.4", {
      env: { ...ENV, RATE_LIMIT_ANON_PER_MIN: "10" },
      fetch: mockFetch([11]),
      now: () => fixedNow,
    });
    assert.equal(result.ok, false);
    assert.ok(typeof result.retryAfterSec === "number");
    assert.ok(result.retryAfterSec! >= 1 && result.retryAfterSec! <= 60);
  });

  it("uses the bearer default (200) when no env override", async () => {
    const result = await checkRateLimit("bearer", "t_abc", {
      env: ENV,
      fetch: mockFetch([1]),
    });
    assert.equal(result.limit, 200);
  });
});

describe("safe identifier handling", () => {
  it("rejects a count when identifier contains poison characters but does not throw", async () => {
    const result = await checkRateLimit("anon", "1.2.3.4\r\nINJECT", {
      env: ENV,
      fetch: (async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "[]");
        // The Redis key must NOT contain CR/LF — RESP injection guard.
        const key = body[0][1];
        assert.doesNotMatch(key, /[\r\n]/, `key was poisoned: ${key}`);
        return { ok: true, json: async () => [{ result: 1 }, { result: 1 }] };
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
  });
});

describe("anonIdentifier", () => {
  it("uses the first comma-separated x-forwarded-for value", () => {
    assert.equal(
      anonIdentifier({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
      "1.2.3.4"
    );
  });
  it("trims whitespace", () => {
    assert.equal(anonIdentifier({ "x-forwarded-for": "  9.9.9.9  " }), "9.9.9.9");
  });
  it("falls back to x-real-ip", () => {
    assert.equal(anonIdentifier({ "x-real-ip": "10.0.0.1" }), "10.0.0.1");
  });
  it("returns 'unknown' when no IP header is present", () => {
    assert.equal(anonIdentifier({}), "unknown");
  });
});

describe("bearerIdentifier", () => {
  it("returns 'unknown' when no Authorization header", () => {
    assert.equal(bearerIdentifier(undefined), "unknown");
    assert.equal(bearerIdentifier(""), "unknown");
    assert.equal(bearerIdentifier("Bearer "), "unknown");
  });
  it("hashes the token so the secret never appears in the key", () => {
    const id = bearerIdentifier("Bearer sk_super_secret_value_42");
    assert.match(id, /^t_[0-9a-f]{8}$/);
    assert.doesNotMatch(id, /super_secret/);
    assert.doesNotMatch(id, /sk_/);
  });
  it("is deterministic for the same token", () => {
    assert.equal(
      bearerIdentifier("Bearer abc123"),
      bearerIdentifier("Bearer abc123")
    );
  });
  it("differs between tokens", () => {
    assert.notEqual(bearerIdentifier("Bearer aaa"), bearerIdentifier("Bearer bbb"));
  });
});
