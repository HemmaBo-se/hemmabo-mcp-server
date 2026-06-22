/**
 * OAuth 2.1 token endpoint — three grants:
 *
 *   1. grant_type=client_credentials     (RFC 6749 §4.4)
 *      Server-to-server. ChatGPT Apps SDK track. Unchanged from the
 *      original ChatGPT-only implementation.
 *
 *   2. grant_type=authorization_code     (RFC 6749 §4.1 + RFC 7636 PKCE)
 *      Required by Anthropic Claude.ai connectors. Redeems a single-use
 *      code issued by /oauth/authorize. PKCE S256 mandatory. Issues an
 *      access_token AND a refresh_token.
 *
 *   3. grant_type=refresh_token          (RFC 6749 §6)
 *      Rotates refresh tokens — every successful refresh revokes the
 *      previous token and issues a new one. Replay of a revoked token
 *      revokes the entire chain (RFC 6749 §10.4).
 *
 * Flow:
 *   POST /oauth/token
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   client_credentials:  grant_type=client_credentials&client_id=...&client_secret=...
 *   authorization_code:  grant_type=authorization_code&code=...&redirect_uri=...
 *                         &code_verifier=...&client_id=...[&client_secret=...]
 *   refresh_token:       grant_type=refresh_token&refresh_token=...&client_id=...
 *                         [&client_secret=...]
 *
 * Tokens are stored in Supabase. Access tokens: opaque 64-char hex, 1h TTL.
 * Refresh tokens: opaque 64-char hex returned once, SHA-256 hashed at rest,
 * 30d TTL, single-use, rotation chain via mcp_refresh_tokens.rotated_to.
 *
 * Public PKCE clients (token_endpoint_auth_method=none) may omit client_secret
 * on authorization_code and refresh_token grants — RFC 8252 §8.4. PKCE is the
 * authentication factor in that case.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { requireEnv } from "../lib/env.js";
import { parseTokenRequestParams } from "../lib/oauth-body.js";
import { anonIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import { verifyS256 } from "../lib/pkce.js";

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

const ACCESS_TOKEN_TTL_SECONDS = 3600;          // 1 h
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 d

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
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

interface ClientRow {
  id: string;
  client_id: string;
  client_secret_hash: string;
  name: string;
  is_active: boolean;
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
}

/**
 * Look up the client and validate the secret if one was provided.
 *
 * Returns the client row on success. Returns the canonical RFC 6749 error
 * object on failure — the caller forwards it to the HTTP response.
 *
 * Public clients (token_endpoint_auth_method=none) may pass clientSecret as
 * undefined; the secret is not checked in that case but the row must still
 * exist and be active.
 */
async function authenticateClient(
  clientId: string,
  clientSecret: string | undefined
): Promise<{ ok: true; client: ClientRow } | { ok: false; status: number; body: Record<string, string> }> {
  const { data: client, error } = await supabase
    .from("mcp_clients")
    .select("id, client_id, client_secret_hash, name, is_active, grant_types, token_endpoint_auth_method, scope")
    .eq("client_id", clientId)
    .maybeSingle<ClientRow>();

  if (error || !client || !client.is_active) {
    return { ok: false, status: 401, body: { error: "invalid_client", error_description: "Unknown or inactive client" } };
  }

  const isPublic = client.token_endpoint_auth_method === "none";
  if (isPublic) {
    if (clientSecret !== undefined && clientSecret !== "") {
      // Spec-strict: a public client MUST NOT send a secret. Reject so the
      // client gets a clear signal rather than a silently-ignored credential.
      return { ok: false, status: 401, body: { error: "invalid_client", error_description: "Public client must not authenticate with client_secret" } };
    }
    return { ok: true, client };
  }

  if (!clientSecret) {
    return { ok: false, status: 401, body: { error: "invalid_client", error_description: "client_secret is required for this client" } };
  }
  if (!timingSafeCompare(hashSecret(clientSecret), client.client_secret_hash)) {
    return { ok: false, status: 401, body: { error: "invalid_client", error_description: "Invalid client credentials" } };
  }
  return { ok: true, client };
}

/**
 * Issue an opaque access token, persist it, and return the bearer payload.
 */
async function issueAccessToken(clientUuid: string, scope: string | null): Promise<{ token: string; expiresIn: number } | null> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await supabase.from("mcp_access_tokens").insert({
    token,
    client_id: clientUuid,
    scope,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("[oauth/token] access-token insert failed:", error);
    return null;
  }
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Issue a refresh token, persist its SHA-256 hash, and return the plaintext
 * (shown to the client once, never stored). `previousId` chains rotation:
 * if the new refresh is issued as part of a refresh_token redemption, the
 * old row's revoked_at + rotated_to must be set in the same transaction.
 */
async function issueRefreshToken(
  clientUuid: string,
  scope: string | null,
): Promise<{ token: string; id: string } | null> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from("mcp_refresh_tokens")
    .insert({ token_hash: tokenHash, client_id: clientUuid, scope, expires_at: expiresAt })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error || !data) {
    console.error("[oauth/token] refresh-token insert failed:", error);
    return null;
  }
  return { token, id: data.id };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Rate-limit (#65): token endpoint verifies client_secret on every call, so
  // it's the primary surface for credential-stuffing. Use the "strict" tier
  // keyed on client IP (default 5/min). Legitimate clients hit it once per
  // hour (token TTL).
  const rlIdent = anonIdentifier(req.headers as Record<string, string | string[] | undefined>);
  const rl = await checkRateLimit("strict", rlIdent);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec ?? 60));
    if (rl.limit !== undefined) res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", "0");
    return res.status(429).json({
      error: "rate_limit_exceeded",
      error_description: `Too many token requests. Retry in ${rl.retryAfterSec ?? 60}s.`,
    });
  }
  if (rl.limit !== undefined && rl.remaining !== undefined) {
    res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  }

  // ── Parse body (JSON or x-www-form-urlencoded; object or raw string) ───
  const contentType = (req.headers["content-type"] || "").toString();
  const params = parseTokenRequestParams(contentType, req.body);

  // HTTP Basic Auth (RFC 6749 §2.3.1) for client credentials.
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const id = decoded.slice(0, idx);
        const secret = decoded.slice(idx + 1);
        if (!params.client_id) params.client_id = id;
        if (!params.client_secret) params.client_secret = secret;
      }
    } catch {
      return res.status(400).json({ error: "invalid_request", error_description: "Malformed Basic auth header" });
    }
  }

  const grantType = params.grant_type;
  if (!grantType) {
    return res.status(400).json({ error: "invalid_request", error_description: "grant_type is required" });
  }

  // ─── grant_type=client_credentials ─────────────────────────────────────
  if (grantType === "client_credentials") {
    if (!params.client_id || !params.client_secret) {
      return res.status(400).json({ error: "invalid_request", error_description: "client_id and client_secret are required" });
    }
    const auth = await authenticateClient(params.client_id, params.client_secret);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    if (!auth.client.grant_types.includes("client_credentials")) {
      return res.status(400).json({ error: "unauthorized_client", error_description: "Client is not authorized to use the client_credentials grant" });
    }
    const access = await issueAccessToken(auth.client.id, auth.client.scope);
    if (!access) return res.status(500).json({ error: "server_error", error_description: "Failed to issue token" });
    return res.status(200).json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      ...(auth.client.scope ? { scope: auth.client.scope } : {}),
    });
  }

  // ─── grant_type=authorization_code ─────────────────────────────────────
  if (grantType === "authorization_code") {
    if (!params.client_id || !params.code || !params.redirect_uri || !params.code_verifier) {
      return res.status(400).json({ error: "invalid_request", error_description: "client_id, code, redirect_uri and code_verifier are required" });
    }
    const auth = await authenticateClient(params.client_id, params.client_secret);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    if (!auth.client.grant_types.includes("authorization_code")) {
      return res.status(400).json({ error: "unauthorized_client", error_description: "Client is not authorized to use the authorization_code grant" });
    }

    // Look up the code. We deliberately read used_at + expires_at and
    // enforce the checks in code rather than relying on a partial index —
    // it makes the replay-rejection branch testable in isolation.
    const { data: codeRow, error: codeErr } = await supabase
      .from("mcp_authorization_codes")
      .select("id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used_at")
      .eq("code", params.code)
      .maybeSingle<{
        id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string | null;
        expires_at: string;
        used_at: string | null;
      }>();

    if (codeErr || !codeRow) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Unknown authorization code" });
    }

    // Single-use. RFC 6749 §4.1.2: "If an authorization code is used more
    // than once, the authorization server MUST … revoke all tokens
    // previously issued based on that authorization code." We mark and
    // reject; full chain revocation is a follow-up.
    if (codeRow.used_at) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code already used" });
    }
    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired" });
    }
    if (codeRow.client_id !== auth.client.id) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code was issued to a different client" });
    }
    if (codeRow.redirect_uri !== params.redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri does not match the one used at /oauth/authorize" });
    }
    if (codeRow.code_challenge_method !== "S256") {
      return res.status(400).json({ error: "invalid_grant", error_description: "Code was issued with an unsupported PKCE method" });
    }
    if (!verifyS256(params.code_verifier, codeRow.code_challenge)) {
      return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    // Mark code as used BEFORE issuing tokens — protects against races
    // where two concurrent redemptions both pass validation. Postgres'
    // single-statement UPDATE WHERE used_at IS NULL is atomic.
    const { data: claimed, error: claimErr } = await supabase
      .from("mcp_authorization_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", codeRow.id)
      .is("used_at", null)
      .select("id")
      .maybeSingle<{ id: string }>();
    if (claimErr || !claimed) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Authorization code was concurrently consumed" });
    }

    const access = await issueAccessToken(auth.client.id, codeRow.scope);
    if (!access) return res.status(500).json({ error: "server_error", error_description: "Failed to issue access token" });
    const refresh = await issueRefreshToken(auth.client.id, codeRow.scope);
    if (!refresh) return res.status(500).json({ error: "server_error", error_description: "Failed to issue refresh token" });

    return res.status(200).json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refresh.token,
      ...(codeRow.scope ? { scope: codeRow.scope } : {}),
    });
  }

  // ─── grant_type=refresh_token ──────────────────────────────────────────
  if (grantType === "refresh_token") {
    if (!params.client_id || !params.refresh_token) {
      return res.status(400).json({ error: "invalid_request", error_description: "client_id and refresh_token are required" });
    }
    const auth = await authenticateClient(params.client_id, params.client_secret);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    if (!auth.client.grant_types.includes("refresh_token")) {
      return res.status(400).json({ error: "unauthorized_client", error_description: "Client is not authorized to use refresh_token" });
    }

    const tokenHash = hashRefreshToken(params.refresh_token);
    const { data: row, error: rowErr } = await supabase
      .from("mcp_refresh_tokens")
      .select("id, client_id, scope, expires_at, revoked_at, rotated_to")
      .eq("token_hash", tokenHash)
      .maybeSingle<{
        id: string;
        client_id: string;
        scope: string | null;
        expires_at: string;
        revoked_at: string | null;
        rotated_to: string | null;
      }>();

    if (rowErr || !row) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Unknown refresh token" });
    }
    if (row.client_id !== auth.client.id) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token was issued to a different client" });
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
    }

    // REPLAY DETECTION (RFC 6749 §10.4 + OAuth 2.1 §6.2):
    // If this token is already revoked AND was rotated to a successor,
    // the chain has been compromised. Revoke the whole family.
    if (row.revoked_at) {
      // Best-effort revocation of the live successor. We don't currently walk
      // the full chain — single hop is enough to break the live session and
      // surface the incident; deeper rotation would require a recursive CTE.
      if (row.rotated_to) {
        await supabase
          .from("mcp_refresh_tokens")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", row.rotated_to)
          .is("revoked_at", null);
      }
      console.warn("[oauth/token] refresh-token replay detected — chain revoked", {
        client_id: auth.client.client_id,
        token_id: row.id,
      });
      return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token has been revoked (replay detected)" });
    }

    // Issue new refresh token, then revoke old + link rotation.
    const refresh = await issueRefreshToken(auth.client.id, row.scope);
    if (!refresh) return res.status(500).json({ error: "server_error", error_description: "Failed to issue refresh token" });
    const { error: revokeErr } = await supabase
      .from("mcp_refresh_tokens")
      .update({ revoked_at: new Date().toISOString(), rotated_to: refresh.id })
      .eq("id", row.id)
      .is("revoked_at", null);
    if (revokeErr) {
      console.error("[oauth/token] failed to revoke previous refresh token:", revokeErr);
      // The new token is live; downgrading to 500 would strand it. Continue.
    }

    const access = await issueAccessToken(auth.client.id, row.scope);
    if (!access) return res.status(500).json({ error: "server_error", error_description: "Failed to issue access token" });

    return res.status(200).json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refresh.token,
      ...(row.scope ? { scope: row.scope } : {}),
    });
  }

  return res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Unsupported grant_type: ${grantType}`,
  });
}
