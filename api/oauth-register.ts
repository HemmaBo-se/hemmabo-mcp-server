/**
 * OAuth 2.0 dynamic client registration (RFC 7591) — POST /oauth/register
 *
 * AI platforms call this once to register themselves and receive
 * client_id + client_secret. The plaintext secret is shown ONCE and
 * never stored — only its SHA-256 hash lives in mcp_clients.
 *
 * Two registration shapes are supported, in priority order:
 *
 *   1. RFC 7591-compliant (Anthropic Claude.ai sends this):
 *        {
 *          "client_name": "...",
 *          "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
 *          "grant_types": ["authorization_code", "refresh_token"],
 *          "token_endpoint_auth_method": "none" | "client_secret_post",
 *          "contact_email": "..."          // non-standard, optional
 *        }
 *
 *   2. Legacy ChatGPT Apps SDK shape (kept for backward compat):
 *        { "client_name": "...", "contact_email": "..." }
 *      Defaults: grant_types=["client_credentials"],
 *                token_endpoint_auth_method="client_secret_post",
 *                redirect_uris=[].
 *
 * Validation rules:
 *   - client_name: required, ≥ 2 chars.
 *   - grant_types: subset of {authorization_code, refresh_token,
 *       client_credentials}. If authorization_code is requested,
 *       redirect_uris MUST be non-empty.
 *   - redirect_uris: must be absolute https:// URLs OR the literal
 *       loopback / custom-scheme patterns allowed by RFC 8252 §7. We do
 *       a minimal "is parseable URL with a scheme" check here; the exact-
 *       string allowlist match at /authorize is the real defence.
 *   - token_endpoint_auth_method: one of {client_secret_post,
 *       client_secret_basic, none}. `none` is only valid when PKCE is
 *       used (i.e. authorization_code grant present).
 *
 * Public clients (token_endpoint_auth_method=none) still receive a
 * client_secret in the response so they can downgrade to a confidential
 * client later without re-registering — but they will fail authentication
 * if they try to send the secret on /oauth/token (see api/oauth.ts).
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "crypto";
import { baseUrl } from "../lib/base-url.js";
import { requireEnv } from "../lib/env.js";
import { anonIdentifier, checkRateLimit } from "../lib/rate-limit.js";

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

const TOKEN_ENDPOINT_PATH = "/oauth/token";
const AUTHORIZE_ENDPOINT_PATH = "/oauth/authorize";

const ALLOWED_GRANTS = new Set(["authorization_code", "refresh_token", "client_credentials"]);
const ALLOWED_AUTH_METHODS = new Set(["client_secret_post", "client_secret_basic", "none"]);

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * RFC 8252 §7 — accept https://, http://127.0.0.1, http://[::1] and custom
 * schemes (e.g. com.example.app:/callback) for native apps. Reject anything
 * else outright so the allowlist cannot be poisoned with javascript: or
 * data: URIs.
 */
function isAcceptableRedirectUri(uri: string): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return false;
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return false; }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "javascript" || scheme === "data" || scheme === "vbscript" || scheme === "file") return false;
  if (scheme === "http") {
    // Loopback only — RFC 8252 §7.3.
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  }
  // https:// and any custom scheme (RFC 8252 §7.1) are allowed.
  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Rate-limit (#65): registration creates a new credential pair on every
  // call, so per-IP throttling at the "strict" tier (default 5/min) prevents
  // credential-storage bloat and brute-force probing of the endpoint.
  const rlIdent = anonIdentifier(req.headers as Record<string, string | string[] | undefined>);
  const rl = await checkRateLimit("strict", rlIdent);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec ?? 60));
    if (rl.limit !== undefined) res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", "0");
    return res.status(429).json({
      error: "rate_limit_exceeded",
      error_description: `Too many registration attempts. Retry in ${rl.retryAfterSec ?? 60}s.`,
    });
  }
  if (rl.limit !== undefined && rl.remaining !== undefined) {
    res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const clientName = body.client_name;
  if (typeof clientName !== "string" || clientName.trim().length < 2) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "client_name is required (min 2 characters)",
    });
  }

  // Grant types — default to client_credentials for legacy ChatGPT Apps SDK
  // registrations that don't specify any.
  let grantTypes: string[];
  if (Array.isArray(body.grant_types) && body.grant_types.length > 0) {
    grantTypes = body.grant_types.map((g) => String(g));
    for (const g of grantTypes) {
      if (!ALLOWED_GRANTS.has(g)) {
        return res.status(400).json({
          error: "invalid_client_metadata",
          error_description: `Unsupported grant_type: ${g}`,
        });
      }
    }
  } else {
    grantTypes = ["client_credentials"];
  }

  // Redirect URIs — required if authorization_code grant is requested.
  let redirectUris: string[] = [];
  if (Array.isArray(body.redirect_uris)) {
    redirectUris = body.redirect_uris.map((u) => String(u));
    for (const u of redirectUris) {
      if (!isAcceptableRedirectUri(u)) {
        return res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `Rejected redirect_uri: ${u}`,
        });
      }
    }
  }
  if (grantTypes.includes("authorization_code") && redirectUris.length === 0) {
    return res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uris is required when authorization_code grant is requested",
    });
  }

  // Token-endpoint auth method.
  let authMethod = "client_secret_post";
  if (typeof body.token_endpoint_auth_method === "string") {
    if (!ALLOWED_AUTH_METHODS.has(body.token_endpoint_auth_method)) {
      return res.status(400).json({
        error: "invalid_client_metadata",
        error_description: `Unsupported token_endpoint_auth_method: ${body.token_endpoint_auth_method}`,
      });
    }
    authMethod = body.token_endpoint_auth_method;
  }
  // `none` requires PKCE, i.e. authorization_code grant must be present.
  if (authMethod === "none" && !grantTypes.includes("authorization_code")) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "token_endpoint_auth_method=none is only valid for public PKCE clients (authorization_code grant)",
    });
  }

  // Optional contact email (HemmaBo-specific extension; not RFC 7591).
  const contactEmail = typeof body.contact_email === "string" ? body.contact_email.trim() : null;

  // Optional scope.
  const scope = typeof body.scope === "string" ? body.scope.trim() : null;

  // Generate credentials.
  const clientId = `hb_${randomUUID().replace(/-/g, "")}`;
  const clientSecret = randomBytes(32).toString("hex"); // 64-char hex, shown once
  const secretHash = hashSecret(clientSecret);

  const { error } = await supabase.from("mcp_clients").insert({
    client_id: clientId,
    client_secret_hash: secretHash,
    name: clientName.trim(),
    contact_email: contactEmail,
    is_active: true,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: authMethod,
    scope,
  });

  if (error) {
    console.error("[oauth/register] insert failed:", error);
    return res.status(500).json({
      error: "server_error",
      error_description: "Registration failed — please retry",
    });
  }

  const base = baseUrl(req);

  // RFC 7591 §3.2 — successful registration response.
  return res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret, // shown ONCE — client must store this
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0, // 0 = never expires (RFC 7591 §3.2.1)
    client_name: clientName.trim(),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: authMethod,
    ...(scope ? { scope } : {}),
    // HemmaBo-specific convenience fields (not part of RFC 7591 §3.2.1 but
    // harmless additions per §3.2.2 — clients ignore unknown fields).
    token_endpoint: `${base}${TOKEN_ENDPOINT_PATH}`,
    authorization_endpoint: `${base}${AUTHORIZE_ENDPOINT_PATH}`,
    note: "Store client_secret securely — it is not recoverable. Public PKCE clients (token_endpoint_auth_method=none) MUST NOT send the secret to /oauth/token.",
  });
}
