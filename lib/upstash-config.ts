/**
 * Shared Upstash Redis REST config resolution + a production boot-check.
 *
 * rate-limit.ts and idempotency.ts both fail OPEN when Upstash is unconfigured:
 * a misconfigured sidecar must never 503 production traffic — it only relaxes
 * the limiter / skips the idempotency cache. That policy is DELIBERATE and it
 * stays (policy A). Its one danger is silence: if the Upstash env is dropped in
 * production, both protections vanish with no signal. This module keeps
 * fail-open but makes the missing-in-production case LOUD, so a config
 * regression shows up in logs/metrics instead of being discovered under abuse.
 */

export interface UpstashBackend {
  url: string;
  token: string;
}

/**
 * Resolve the Upstash REST backend from env. Accepts the classic
 * `UPSTASH_REDIS_REST_*` names and Vercel's "Upstash for Redis" KV-integration
 * names (`UPSTASH_REDIS_KV_REST_API_*`). Returns null when unconfigured.
 *
 * Single source of truth for both the rate limiter and the ACP idempotency
 * cache — so the two can never drift on which env names count as "configured".
 */
export function upstashBackend(env: NodeJS.ProcessEnv): UpstashBackend | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/** True only on a Vercel PRODUCTION deployment (`VERCEL_ENV=production`). */
function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.VERCEL_ENV === "production";
}

export type UpstashComponent = "rate-limit" | "acp-idempotency";

// One warning per component per process (avoids log spam; a fresh cold start
// re-emits, which is what we want — every cold start re-surfaces the misconfig).
const warnedComponents = new Set<string>();

/**
 * Policy A (fail-open KEPT): if Upstash is unconfigured AND this is a Vercel
 * production deployment, emit ONE structured, loud log per component per
 * process so the regression is visible in logs/metrics. Preview/local stay
 * silent — fail-open there is expected. This NEVER throws and NEVER blocks a
 * request; it only observes. `logger` is injectable for tests.
 *
 * Returns true when a warning was emitted (for tests), false otherwise.
 */
export function warnIfUpstashMissingInProduction(
  env: NodeJS.ProcessEnv,
  component: UpstashComponent,
  logger: (msg: string) => void = console.error,
): boolean {
  if (upstashBackend(env)) return false; // configured → nothing to warn about
  if (!isProduction(env)) return false; // preview/local → silent fail-open OK
  if (warnedComponents.has(component)) return false; // already warned this process
  warnedComponents.add(component);
  // Wrapped: this runs at module load, so a throwing logger must NEVER crash the
  // cold start (that would turn an observability aid into a real outage).
  try {
    logger(
      JSON.stringify({
        event: "upstash_missing_in_production",
        component,
        severity: "error",
        impact:
          component === "rate-limit"
            ? "rate limiter disabled (fail-open) — the endpoint is unthrottled"
            : "ACP idempotency cache disabled (fail-open) — our cache no longer de-duplicates retries (Stripe Idempotency-Key still applies)",
        action:
          "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the UPSTASH_REDIS_KV_REST_API_* variants) in the Vercel production environment.",
      }),
    );
  } catch {
    /* never let logging crash a cold start */
  }
  return true;
}

/** Test-only: reset the once-per-process warned set. */
export function __resetUpstashWarningsForTest(): void {
  warnedComponents.clear();
}
