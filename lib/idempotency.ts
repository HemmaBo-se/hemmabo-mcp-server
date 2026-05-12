/**
 * Idempotency-Key cache for mutating ACP endpoints (#66).
 *
 * Why: ACP agents can retry on network failures. Without an idempotency
 * cache the same `Idempotency-Key` could double-book, double-charge, or
 * double-refund. The ACP/Stripe spec (mirroring stripe.com/docs/idempotency)
 * defines the contract:
 *   - Same key + same request body → return the cached prior response.
 *   - Same key + different body    → 409 Conflict.
 *   - New key                       → execute, cache the response.
 *
 * Backend: Upstash Redis REST (same backend the rate-limiter uses). We
 * piggy-back on the existing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * (or the Vercel KV-integration names UPSTASH_REDIS_KV_REST_API_*).
 *
 * Fail-open policy: if Upstash isn't configured (local dev, preview without
 * secrets), the cache silently degrades to a non-cache — every request
 * executes. This matches the rate-limiter's fail-open policy: a misconfigured
 * sidecar must NOT block production traffic. The risk window is small
 * because Vercel preview deploys are not customer-facing.
 *
 * TTL: 24h. Stripe uses 24h. Matches typical retry windows.
 *
 * Body hash: SHA-256 over a stable JSON serialisation (sorted keys) so
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash. We keep the hash, not
 * the body, in Redis — bodies can contain PII (guest name/email/phone in
 * ACP create) and Redis should never log them.
 *
 * Response storage: status + JSON body, both small. We cap the cached body
 * at 64KB to keep Redis memory bounded; if a response is larger, the cache
 * entry is dropped on write (the request still executes, just not cached).
 */

import { createHash } from "node:crypto";

const TTL_SECONDS = 60 * 60 * 24; // 24h
const MAX_BODY_BYTES = 64 * 1024; // 64KB cap on cached response body
const KEY_PREFIX = "acp:idem:";

export type IdempotencyOutcome =
  | { kind: "miss" }
  | { kind: "hit"; status: number; body: unknown }
  | { kind: "conflict"; existingFingerprint: string };

export interface IdempotencyDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function resolveBackend(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Stable JSON canonicalisation: sort object keys recursively. We don't
 * normalise number formats or string escapes — JSON.stringify is enough
 * given that both legs come from the same JSON.parse upstream.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function fingerprint(body: unknown): string {
  const canon = canonicalJson(body);
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Reject Idempotency-Key values that aren't safe to use as a Redis key.
 * The ACP/Stripe convention is a UUID-ish opaque string; we permit
 * `[A-Za-z0-9._:-]` up to 200 chars. Returns null on invalid.
 */
export function normaliseIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9._:\-]+$/.test(trimmed)) return null;
  return trimmed;
}

interface CachedEntry {
  fp: string; // body fingerprint
  status: number;
  body: unknown;
}

/**
 * Look up an idempotency key. Returns:
 *   - { kind: "miss" }      → caller should execute and call `record`.
 *   - { kind: "hit", … }    → caller should return cached response verbatim.
 *   - { kind: "conflict" }  → caller should return 409 (same key, different body).
 *
 * Fail-open: any Upstash error (network, auth, JSON shape) → "miss".
 */
export async function lookup(
  key: string,
  bodyFingerprint: string,
  deps: IdempotencyDeps = {}
): Promise<IdempotencyOutcome> {
  const env = deps.env ?? process.env;
  const backend = resolveBackend(env);
  if (!backend) return { kind: "miss" };

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const redisKey = `${KEY_PREFIX}${key}`;

  try {
    const resp = await fetchFn(`${backend.url}/get/${encodeURIComponent(redisKey)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${backend.token}` },
    });
    if (!resp.ok) return { kind: "miss" };
    const json = (await resp.json()) as { result?: string | null };
    if (!json.result) return { kind: "miss" };

    let parsed: CachedEntry;
    try {
      parsed = JSON.parse(json.result) as CachedEntry;
    } catch {
      return { kind: "miss" };
    }
    if (typeof parsed?.fp !== "string" || typeof parsed?.status !== "number") {
      return { kind: "miss" };
    }
    if (parsed.fp !== bodyFingerprint) {
      return { kind: "conflict", existingFingerprint: parsed.fp };
    }
    return { kind: "hit", status: parsed.status, body: parsed.body };
  } catch {
    return { kind: "miss" };
  }
}

/**
 * Store the response for a successful execution. Best-effort: Upstash errors
 * are swallowed (the original response is what matters; cache is an
 * optimisation for retries).
 */
export async function record(
  key: string,
  bodyFingerprint: string,
  status: number,
  body: unknown,
  deps: IdempotencyDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env;
  const backend = resolveBackend(env);
  if (!backend) return;

  const entry: CachedEntry = { fp: bodyFingerprint, status, body };
  const serialised = JSON.stringify(entry);
  // Reject oversized entries rather than blowing Redis memory.
  if (Buffer.byteLength(serialised, "utf8") > MAX_BODY_BYTES) return;

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const redisKey = `${KEY_PREFIX}${key}`;

  try {
    // SET key value EX <ttl> NX → only set if not already present, so a
    // racing duplicate can never overwrite a prior committed response.
    await fetchFn(`${backend.url}/pipeline`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${backend.token}`,
      },
      body: JSON.stringify([["SET", redisKey, serialised, "EX", String(TTL_SECONDS), "NX"]]),
    });
  } catch {
    /* swallow — fail-open per module contract */
  }
}
