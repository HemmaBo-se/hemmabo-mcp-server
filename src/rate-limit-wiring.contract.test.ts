/**
 * Contract: rate-limit must be wired on credential and ACP endpoints (#65).
 *
 * This is a drift-guard test. It does NOT exercise Upstash (the limiter is
 * fail-open without it; the runtime path is covered by src/rate-limit.test.ts).
 * Instead it asserts that the handler source files contain the required
 * `checkRateLimit(...)` call and a 429 response branch, so refactors can't
 * silently remove the limiter.
 *
 * Why a source-text test:
 *   - The endpoints have heavy external deps (Supabase, Stripe, OAuth state)
 *     so an HTTP-level test would need substantial mocking.
 *   - The drift risk is "someone deletes the limiter call" — exactly what a
 *     text-presence test catches.
 *
 * Strategy mirrors the empty-catch guard in src/stripe-webhook.contract.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

async function readSource(rel: string): Promise<string> {
  return readFile(resolve(ROOT, rel), "utf8");
}

test("api/oauth-register.ts wires checkRateLimit on 'strict' kind", async () => {
  const src = await readSource("api/oauth-register.ts");
  assert.match(
    src,
    /import\s*\{[^}]*\bcheckRateLimit\b[^}]*\}\s*from\s*["']\.\.\/lib\/rate-limit\.js["']/,
    "must import checkRateLimit from lib/rate-limit.js"
  );
  assert.match(
    src,
    /checkRateLimit\(\s*["']strict["']/,
    "must call checkRateLimit with kind='strict'"
  );
  assert.match(src, /429/, "must include a 429 response branch");
  assert.match(src, /Retry-After/, "must set Retry-After header on 429");
});

test("api/oauth.ts wires checkRateLimit on 'strict' kind", async () => {
  const src = await readSource("api/oauth.ts");
  assert.match(
    src,
    /import\s*\{[^}]*\bcheckRateLimit\b[^}]*\}\s*from\s*["']\.\.\/lib\/rate-limit\.js["']/,
    "must import checkRateLimit"
  );
  assert.match(
    src,
    /checkRateLimit\(\s*["']strict["']/,
    "token endpoint must use strict tier"
  );
  assert.match(src, /429/);
  assert.match(src, /Retry-After/);
});

test("api/acp.ts wires checkRateLimit before mutation auth gate", async () => {
  const src = await readSource("api/acp.ts");
  assert.match(
    src,
    /import\s*\{[^}]*\bcheckRateLimit\b[^}]*\}\s*from\s*["']\.\.\/lib\/rate-limit\.js["']/,
    "must import checkRateLimit"
  );
  assert.match(
    src,
    /checkRateLimit\(\s*rlKind/,
    "must call checkRateLimit with a kind variable (anon/bearer)"
  );
  assert.match(src, /429/);
  assert.match(src, /Retry-After/);

  // Ordering invariant: rate-limit must run BEFORE the validateApiKey call
  // inside the router (otherwise unauthenticated 401 responses themselves
  // become an unthrottled brute-force surface).
  const rlIdx = src.indexOf("checkRateLimit(");
  const authIdx = src.search(/if\s*\(\s*isMutation\b/);
  assert.ok(rlIdx > -1, "checkRateLimit call must exist");
  assert.ok(authIdx > -1, "isMutation auth gate must exist");
  assert.ok(
    rlIdx < authIdx,
    `checkRateLimit must appear before the isMutation auth gate (rl=${rlIdx}, auth=${authIdx})`
  );
});

test("lib/rate-limit.ts exposes 'strict' kind with sane default", async () => {
  const src = await readSource("lib/rate-limit.ts");
  assert.match(
    src,
    /export\s+type\s+RateKind\s*=\s*"anon"\s*\|\s*"bearer"\s*\|\s*"strict"/,
    "RateKind union must include 'strict'"
  );
  assert.match(
    src,
    /DEFAULT_STRICT_LIMIT\s*=\s*5\b/,
    "default strict limit must be 5/min (credential endpoints)"
  );
  assert.match(
    src,
    /RATE_LIMIT_STRICT_PER_MIN/,
    "must read RATE_LIMIT_STRICT_PER_MIN env override"
  );
});
