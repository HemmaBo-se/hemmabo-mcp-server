/**
 * Per-IP / per-token rate limiter for the public MCP HTTP endpoint.
 *
 * Backend: Upstash Redis REST API. We use raw fetch (no SDK dep) because:
 *   - It runs cleanly on Vercel serverless without bundler tweaks.
 *   - Upstash's REST surface is small and stable.
 *
 * Algorithm: fixed window. INCR a counter keyed by `prefix:bucket:windowStart`
 * and set EXPIRE on first increment. Cheap, accurate within ±1 window, and
 * Upstash bills per command — INCR is a single command.
 *
 * Fail-open policy: if UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is
 * unset (local dev, tests, preview deploys without secrets), the limiter
 * returns { ok: true } without contacting any backend. This is intentional:
 * a misconfigured limiter must NOT block production traffic, only relax it.
 *
 * Configuration (all env, all optional):
 *   UPSTASH_REDIS_REST_URL    e.g. https://us1-foo-12345.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN  bearer token
 *   RATE_LIMIT_ANON_PER_MIN   default 60
 *   RATE_LIMIT_BEARER_PER_MIN default 200
 *
 * Vercel's "Upstash for Redis" Marketplace integration with a custom prefix
 * injects env vars in the form UPSTASH_REDIS_KV_REST_API_URL /
 * UPSTASH_REDIS_KV_REST_API_TOKEN. Those names are also accepted as a
 * fallback so the limiter works without manual env-var aliasing.
 */

export type RateKind = "anon" | "bearer";

export interface RateLimitResult {
  ok: boolean;
  /** When ok=false, suggested seconds until the caller can retry. */
  retryAfterSec?: number;
  /** Configured limit for this kind. Undefined when limiter is disabled. */
  limit?: number;
  /** Remaining quota in the current window. Undefined when disabled. */
  remaining?: number;
}

export interface RateLimitDeps {
  /** Defaults to globalThis.fetch — injectable for tests. */
  fetch?: typeof fetch;
  /** Defaults to Date.now — injectable for tests. */
  now?: () => number;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const WINDOW_MS = 60_000;
const DEFAULT_ANON_LIMIT = 60;
const DEFAULT_BEARER_LIMIT = 200;

function readLimit(env: NodeJS.ProcessEnv, kind: RateKind): number {
  const raw = kind === "anon" ? env.RATE_LIMIT_ANON_PER_MIN : env.RATE_LIMIT_BEARER_PER_MIN;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return kind === "anon" ? DEFAULT_ANON_LIMIT : DEFAULT_BEARER_LIMIT;
}

function safeIdentifier(id: string): string {
  // Restrict to a small alphabet so the Redis key cannot be poisoned by a
  // header value containing colons, newlines, or RESP control chars.
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

/**
 * Check (and increment) the rate limit for `kind`+`identifier`.
 * Returns { ok: true } if the request is allowed, { ok: false, retryAfterSec }
 * if it should be rejected with HTTP 429.
 */
export async function checkRateLimit(
  kind: RateKind,
  identifier: string,
  deps: RateLimitDeps = {}
): Promise<RateLimitResult> {
  const env = deps.env ?? process.env;
  // Accept both the classic Upstash REST env names and Vercel's "Upstash for
  // Redis" KV-integration names (which inject `_KV_REST_API_` in the middle
  // when a custom prefix is set). Either pair fully configures the limiter.
  const url = env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  // Fail-open when the limiter isn't configured. See module header.
  if (!url || !token) return { ok: true };

  const limit = readLimit(env, kind);
  const now = (deps.now ?? Date.now)();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const id = safeIdentifier(identifier) || "unknown";
  const key = `mcp:rl:${kind}:${id}:${windowStart}`;

  // Pipeline INCR + EXPIRE in a single round-trip. EXPIRE is idempotent —
  // setting it on every increment is fine (TTL just gets re-affirmed).
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let count: number;
  try {
    const resp = await fetchFn(`${url}/pipeline`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify([
        ["INCR", key],
        ["PEXPIRE", key, String(WINDOW_MS + 5_000)],
      ]),
    });
    if (!resp.ok) return { ok: true }; // fail-open on backend error
    const body = (await resp.json()) as Array<{ result?: number; error?: string }>;
    const incr = body[0];
    if (!incr || typeof incr.result !== "number") return { ok: true };
    count = incr.result;
  } catch {
    return { ok: true }; // fail-open on transient network error
  }

  const remaining = Math.max(0, limit - count);
  if (count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfterSec, limit, remaining };
  }
  return { ok: true, limit, remaining };
}

/**
 * Stable, low-PII identifier for an anonymous caller. Falls back to "unknown"
 * when no IP-bearing header is present (e.g. local stdin tests).
 *
 * Vercel sets x-forwarded-for; the first comma-separated value is the client.
 */
export function anonIdentifier(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers["x-forwarded-for"];
  const v = Array.isArray(xff) ? xff[0] : xff;
  if (typeof v === "string" && v.length > 0) {
    return v.split(",")[0]!.trim();
  }
  const realIp = headers["x-real-ip"];
  const r = Array.isArray(realIp) ? realIp[0] : realIp;
  if (typeof r === "string" && r.length > 0) return r;
  return "unknown";
}

/**
 * Identifier derived from a Bearer token. We hash the token (FNV-1a 32-bit) so
 * the rate-limit key never contains the secret — Upstash logs and our own
 * structured logs would otherwise leak it.
 *
 * FNV-1a is non-cryptographic but is sufficient as a key-bucketing function:
 * an attacker cannot use a hash collision to bypass the limiter (collisions
 * land in the same bucket, increasing the count).
 */
export function bearerIdentifier(authorization: string | undefined): string {
  if (!authorization) return "unknown";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return "unknown";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `t_${hash.toString(16).padStart(8, "0")}`;
}
