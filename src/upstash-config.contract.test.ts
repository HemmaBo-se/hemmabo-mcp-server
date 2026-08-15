/**
 * Contract test — policy A: Upstash stays fail-open, but a missing backend in
 * PRODUCTION is detected and logged loudly (preview/local stay silent).
 *
 * Run: npx tsx --test src/upstash-config.contract.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  upstashBackend,
  warnIfUpstashMissingInProduction,
  __resetUpstashWarningsForTest,
} from "../lib/upstash-config.js";

const REST = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "tok",
} as NodeJS.ProcessEnv;

const KV = {
  UPSTASH_REDIS_KV_REST_API_URL: "https://example.upstash.io",
  UPSTASH_REDIS_KV_REST_API_TOKEN: "tok",
} as NodeJS.ProcessEnv;

beforeEach(() => __resetUpstashWarningsForTest());

describe("upstashBackend — single source of resolution", () => {
  it("resolves the classic REST env names", () => {
    assert.deepEqual(upstashBackend(REST), { url: "https://example.upstash.io", token: "tok" });
  });
  it("resolves Vercel's KV-integration env names", () => {
    assert.deepEqual(upstashBackend(KV), { url: "https://example.upstash.io", token: "tok" });
  });
  it("returns null when unconfigured", () => {
    assert.equal(upstashBackend({} as NodeJS.ProcessEnv), null);
  });
  it("returns null when only one half is present", () => {
    assert.equal(upstashBackend({ UPSTASH_REDIS_REST_URL: "x" } as NodeJS.ProcessEnv), null);
  });
});

describe("warnIfUpstashMissingInProduction — policy A (fail-open kept, loud in prod)", () => {
  function capture() {
    const msgs: string[] = [];
    return { logger: (m: string) => msgs.push(m), msgs };
  }

  it("MISSING + VERCEL_ENV=production → warns once, structured", () => {
    const { logger, msgs } = capture();
    const env = { VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
    const warned = warnIfUpstashMissingInProduction(env, "rate-limit", logger);
    assert.equal(warned, true);
    assert.equal(msgs.length, 1);
    const parsed = JSON.parse(msgs[0]);
    assert.equal(parsed.event, "upstash_missing_in_production");
    assert.equal(parsed.component, "rate-limit");
    assert.equal(parsed.severity, "error");
    assert.match(parsed.action, /UPSTASH_REDIS_REST_URL/);
  });

  it("MISSING + production → only ONE warning per component per process", () => {
    const { logger, msgs } = capture();
    const env = { VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
    assert.equal(warnIfUpstashMissingInProduction(env, "acp-idempotency", logger), true);
    assert.equal(warnIfUpstashMissingInProduction(env, "acp-idempotency", logger), false);
    assert.equal(msgs.length, 1);
  });

  it("CONFIGURED + production → no warning (fail-open path never taken)", () => {
    const { logger, msgs } = capture();
    const env = { ...REST, VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
    assert.equal(warnIfUpstashMissingInProduction(env, "rate-limit", logger), false);
    assert.equal(msgs.length, 0);
  });

  it("MISSING + VERCEL_ENV=preview → SILENT (fail-open there is expected)", () => {
    const { logger, msgs } = capture();
    const env = { VERCEL_ENV: "preview" } as NodeJS.ProcessEnv;
    assert.equal(warnIfUpstashMissingInProduction(env, "rate-limit", logger), false);
    assert.equal(msgs.length, 0);
  });

  it("MISSING + no VERCEL_ENV (local/tests) → SILENT", () => {
    const { logger, msgs } = capture();
    assert.equal(warnIfUpstashMissingInProduction({} as NodeJS.ProcessEnv, "rate-limit", logger), false);
    assert.equal(msgs.length, 0);
  });

  it("never throws — it only observes", () => {
    assert.doesNotThrow(() =>
      warnIfUpstashMissingInProduction({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv, "rate-limit", () => {
        throw new Error("logger blew up");
      }),
    );
  });
});
