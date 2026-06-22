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

const AUTHORIZE_PARAM_KEYS = [
  "response_type", "client_id", "redirect_uri", "state",
  "code_challenge", "code_challenge_method", "scope", "decision",
] as const;

/**
 * Normalise an OAuth request body into a flat key→value source object,
 * accepting both application/x-www-form-urlencoded (the RFC 6749 §3.2 mandated
 * default) and application/json.
 *
 * The Vercel runtime pre-parses BOTH content types into an object, so the
 * common case is an already-parsed object regardless of content type. A raw
 * string body (when body parsing is disabled) is also handled: JSON.parse for
 * JSON, URLSearchParams for form-encoded. Reading only a raw string for the
 * form branch — as the original token and authorize handlers both did — means
 * that on Vercel, where the body is an object, every form-encoded field is
 * silently dropped (token endpoint failed "grant_type is required"; the
 * authorize consent POST failed "Missing client_id").
 */
function bodyToSource(contentType: string, body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object") {
    return body as Record<string, unknown>;
  }
  if (typeof body === "string" && body.length > 0) {
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return Object.fromEntries(new URLSearchParams(body));
  }
  return null;
}

function pickStringKeys(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};
  if (source) {
    for (const k of keys) {
      const v = source[k];
      if (typeof v === "string") params[k] = v;
    }
  }
  return params;
}

/** Token-endpoint params (RFC 6749 §3.2). See {@link bodyToSource}. */
export function parseTokenRequestParams(
  contentType: string,
  body: unknown,
): Record<string, string | undefined> {
  return pickStringKeys(bodyToSource(contentType, body), TOKEN_PARAM_KEYS);
}

/**
 * Authorize-endpoint consent-POST params (RFC 6749 §4.1.1). The consent form
 * submits application/x-www-form-urlencoded, which Vercel delivers as an
 * object — so this MUST go through {@link bodyToSource} or every field (incl.
 * client_id) is dropped and the user sees "Missing client_id".
 */
export function parseAuthorizeRequestParams(
  contentType: string,
  body: unknown,
): Record<string, string | undefined> {
  return pickStringKeys(bodyToSource(contentType, body), AUTHORIZE_PARAM_KEYS);
}
