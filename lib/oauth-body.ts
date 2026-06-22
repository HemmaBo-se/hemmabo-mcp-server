/**
 * OAuth token-endpoint body parsing (RFC 6749 §3.2).
 *
 * Kept in its own side-effect-free module so it can be unit-tested directly —
 * api/oauth.ts creates a Supabase client at import time, which throws without
 * env, so it cannot be imported from a test.
 */

const TOKEN_PARAM_KEYS = [
  "grant_type", "client_id", "client_secret", "code",
  "redirect_uri", "code_verifier", "refresh_token", "scope",
] as const;

/**
 * Extract OAuth token params from a request body, accepting both
 * application/x-www-form-urlencoded (the RFC 6749 §3.2 mandated default) and
 * application/json.
 *
 * The Vercel runtime pre-parses BOTH content types into an object, so the
 * common case is an already-parsed object regardless of content type. A raw
 * string body (when body parsing is disabled) is also handled: JSON.parse for
 * JSON, URLSearchParams for form-encoded. The previous implementation read
 * only a raw string for the form branch, so on Vercel — where the body is an
 * object — every form-encoded field was silently dropped and the request
 * failed with "grant_type is required".
 */
export function parseTokenRequestParams(
  contentType: string,
  body: unknown,
): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};
  let source: Record<string, unknown> | null = null;

  if (body && typeof body === "object") {
    source = body as Record<string, unknown>;
  } else if (typeof body === "string" && body.length > 0) {
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") source = parsed as Record<string, unknown>;
      } catch {
        source = null;
      }
    } else {
      source = Object.fromEntries(new URLSearchParams(body));
    }
  }

  if (source) {
    for (const k of TOKEN_PARAM_KEYS) {
      const v = source[k];
      if (typeof v === "string") params[k] = v;
    }
  }
  return params;
}
