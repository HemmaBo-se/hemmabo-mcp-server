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
 *
 * OA-2: an OAuth access token is only valid while its issuing client is still
 * active (mcp_clients.is_active). Deactivating a client invalidates its live
 * tokens IMMEDIATELY — not just after the 1h TTL. A deactivated client's token
 * returns the same "Invalid or unknown token" as a token that never existed
 * (no oracle that distinguishes "deactivated" from "never existed").
 *
 * OA-3: `scope` is STORED on clients/tokens but is NOT an authorization
 * boundary — nothing here (or in the MCP/ACP tool dispatch) restricts
 * capability by scope. Per-booking authorization is the guest_token binding
 * (see lib/booking-binding.ts), NOT scope. Do not assume a token's scope limits
 * what it can call.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";
import { requireEnv } from "../lib/env.js";

let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
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
  authorizationHeader: string | undefined,
  deps: { supabase?: SupabaseClient } = {}
): Promise<string | null> {
  const masterKey = process.env.MCP_API_KEY;
  if (!masterKey) return null; // open mode

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return "Authorization required. Pass: Authorization: Bearer <token>";
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token) return "Empty Bearer token";

  // 1. MCP_API_KEY — constant-time, no DB. Unchanged.
  if (timingSafeStringEqual(token, masterKey)) return null;

  // 2. OAuth access token — DB lookup. A caller-injected client (tests) is used
  //    when provided; otherwise one is built from env. If neither is available,
  //    OAuth cannot be used to authenticate, so reject the token immediately
  //    rather than crashing the request — the same outcome a caller with an
  //    unknown OAuth token would have received once the DB lookup completed.
  const supabase =
    deps.supabase ??
    (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? (getSupabase() as SupabaseClient)
      : null);
  if (!supabase) return "Invalid API key";

  // OA-2: embed the token's client so a client deactivated AFTER the token was
  // issued is rejected immediately (not only after the 1h TTL). The FK
  // mcp_access_tokens.client_id → mcp_clients.id embeds as `mcp_clients`.
  const { data, error } = await supabase
    .from("mcp_access_tokens")
    .select("id, expires_at, mcp_clients(is_active)")
    .eq("token", token)
    .maybeSingle<{ id: string; expires_at: string; mcp_clients: unknown }>();

  if (error || !data) return "Invalid or unknown token";

  // OA-2: the issuing client must still be active. Same "Invalid or unknown
  // token" message as a not-found token — no oracle that distinguishes
  // "deactivated" from "never existed". (PostgREST returns the to-one embed as
  // an object; normalise a single-element-array shape defensively.)
  const rel = (data as { mcp_clients?: unknown }).mcp_clients;
  const client = (Array.isArray(rel) ? rel[0] : rel) as { is_active?: boolean } | null | undefined;
  if (!client || client.is_active !== true) return "Invalid or unknown token";

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
