/**
 * API key / OAuth token validation for MCP and ACP endpoints.
 *
 * Two accepted credential types (checked in order):
 *
 * 1. MCP_API_KEY (legacy / admin)
 *    Authorization: Bearer <MCP_API_KEY value>
 *    Validated with constant-time comparison — no DB lookup needed.
 *
 * 2. OAuth access token (AI platforms)
 *    Issued by POST /oauth/token (client_credentials grant).
 *    Validated against mcp_access_tokens table in Supabase.
 *    Tokens expire after 1 hour — clients re-fetch automatically.
 *
 * When MCP_API_KEY is unset, the server runs in open mode (all callers allowed).
 */

import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";

let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) {
      timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Full async validation — checks MCP_API_KEY first, then OAuth tokens.
 * Returns null if valid, error string if invalid.
 */
export async function validateAuth(
  authorizationHeader: string | undefined
): Promise<string | null> {
  const masterKey = process.env.MCP_API_KEY;
  if (!masterKey) return null; // open mode

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return "Authorization required. Pass: Authorization: Bearer <token>";
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token) return "Empty Bearer token";

  // 1. MCP_API_KEY — constant-time, no DB
  if (timingSafeStringEqual(token, masterKey)) return null;

  // 2. OAuth access token — DB lookup
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("mcp_access_tokens")
    .select("id, expires_at")
    .eq("token", token)
    .maybeSingle<{ id: string; expires_at: string }>();

  if (error || !data) return "Invalid or unknown token";

  if (new Date(data.expires_at) < new Date()) {
    await supabase.from("mcp_access_tokens").delete().eq("id", data.id);
    return "Token expired — request a new one via POST /oauth/token";
  }

  return null;
}

/**
 * Synchronous legacy validator — only checks MCP_API_KEY.
 * @deprecated Use validateAuth() for full OAuth support.
 */
export function validateApiKey(
  authorizationHeader: string | string[] | undefined
): string | null {
  const masterKey = process.env.MCP_API_KEY;
  if (!masterKey) return null;

  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;

  if (!header?.startsWith("Bearer ")) {
    return "Authorization required. Pass: Authorization: Bearer <key>";
  }

  const provided = header.slice(7).trim();
  if (!timingSafeStringEqual(provided, masterKey)) return "Invalid API key";

  return null;
}
