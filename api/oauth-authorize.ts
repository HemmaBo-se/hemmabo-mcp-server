/**
 * OAuth 2.1 authorization endpoint — /oauth/authorize
 *
 * The "front door" for the authorization_code grant required by Anthropic
 * Claude.ai connectors. This is a stateless consent screen, not a login
 * page: HemmaBo's identity model is guest-without-identity (ADR 0003 §2.1).
 * The end user sees one button — "Connect HemmaBo to Claude" — and clicking
 * it issues a single-use authorization code that the AI client then redeems
 * at /oauth/token together with the PKCE verifier.
 *
 * Flow per RFC 6749 §4.1 + RFC 7636 + ADR 0003:
 *
 *   GET  /oauth/authorize?response_type=code&client_id=...&redirect_uri=...
 *        &state=...&code_challenge=...&code_challenge_method=S256&scope=mcp
 *
 *     Validate every parameter. Anti-open-redirect: if redirect_uri is not
 *     in the client's allowlist, render the error page in-place. NEVER
 *     redirect to an unverified URI. Other errors round-trip via the
 *     redirect_uri so the client can see them per RFC 6749 §4.1.2.1.
 *
 *     On success render a minimal HTML page with an "Approve" form that
 *     POSTs back to this same endpoint with the same parameters echoed in
 *     hidden inputs.
 *
 *   POST /oauth/authorize
 *
 *     Re-validate (state is not trusted), insert mcp_authorization_codes
 *     row (10-min TTL, single-use, S256), and 302-redirect to
 *     `${redirect_uri}?code=<opaque>&state=<state>`.
 *
 * No authentication is required to reach this endpoint — the user is, by
 * definition, anonymous until they consent. Rate-limit (strict tier) keys
 * on source IP to deter code-grinding probes.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { requireEnv } from "../lib/env.js";
import { anonIdentifier, checkRateLimit } from "../lib/rate-limit.js";
import { isValidCodeChallenge } from "../lib/pkce.js";
import { parseAuthorizeRequestParams } from "../lib/oauth-body.js";

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

const CODE_TTL_SECONDS = 600; // 10 minutes — RFC 6749 §4.1.2 recommends short
const DEFAULT_SCOPE = "mcp";

interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
}

interface ClientRow {
  id: string;
  client_id: string;
  name: string;
  is_active: boolean;
  redirect_uris: string[];
  grant_types: string[];
}

function queryParamsFromUrl(req: VercelRequest): AuthorizeParams {
  const host = req.headers.host;
  const baseHost = Array.isArray(host) ? host[0] : host;
  const parsed = new URL(req.url || "", `https://${baseHost || "localhost"}`);
  const params: Record<string, string | string[]> = {};

  for (const [key, value] of parsed.searchParams) {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      params[key] = [existing, value];
    }
  }

  return params as AuthorizeParams;
}

/**
 * Read params from either query string (GET) or form body (POST consent
 * submission). The consent form POSTs application/x-www-form-urlencoded, which
 * the Vercel runtime delivers as an ALREADY-PARSED OBJECT — not a raw string.
 * Parsing only the string case (as this handler originally did) dropped every
 * field on Vercel, so the approve POST failed with "Missing client_id" even
 * though the consent page had rendered correctly. parseAuthorizeRequestParams
 * (lib/oauth-body) handles object, raw form string, and JSON alike — the same
 * fix already applied to the token endpoint.
 */
function readParams(req: VercelRequest): AuthorizeParams {
  if (req.method === "GET") return queryParamsFromUrl(req);

  const ct = (req.headers["content-type"] || "").toString();
  return parseAuthorizeRequestParams(ct, req.body) as AuthorizeParams;
}

/**
 * Look up the client by its public client_id string and verify it is active
 * and may use the authorization_code grant. Returns null if any check fails.
 */
async function loadClient(clientId: string): Promise<ClientRow | null> {
  const { data, error } = await supabase
    .from("mcp_clients")
    .select("id, client_id, name, is_active, redirect_uris, grant_types")
    .eq("client_id", clientId)
    .maybeSingle<ClientRow>();
  if (error || !data || !data.is_active) return null;
  if (!Array.isArray(data.grant_types) || !data.grant_types.includes("authorization_code")) {
    return null;
  }
  return data;
}

/**
 * RFC 6749 §3.1.2.3 — redirect_uri MUST match one of the client's registered
 * URIs by exact string comparison. No substring, no scheme normalisation, no
 * trailing-slash forgiveness. This is the single line of defence against
 * open-redirect attacks on the authorization code.
 */
function isRedirectUriAllowed(uri: string, allowlist: string[]): boolean {
  return allowlist.some((registered) => registered === uri);
}

function renderErrorPage(res: VercelResponse, status: number, title: string, detail: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui;max-width:560px;margin:4rem auto;color:#111">` +
    `<h1 style="color:#b00">${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p>` +
    `<p style="color:#666;font-size:.85rem">If you arrived here from an AI assistant, this means the connector is misconfigured. Contact the AI vendor — there is nothing you can do from this page.</p>` +
    `</body>`
  );
}

function renderConsentPage(
  res: VercelResponse,
  client: ClientRow,
  p: Required<Pick<AuthorizeParams, "client_id" | "redirect_uri" | "state" | "code_challenge" | "code_challenge_method">> & { scope: string }
) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // X-Frame-Options + CSP: prevent the consent page from being framed by a
  // malicious site that overlays a transparent click target on "Approve".
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(200).send(
    `<!doctype html><meta charset="utf-8"><title>Connect ${escapeHtml(client.name)} to HemmaBo</title>` +
    `<body style="font-family:system-ui;max-width:560px;margin:4rem auto;color:#111">` +
    `<h1>Connect to HemmaBo</h1>` +
    `<p><strong>${escapeHtml(client.name)}</strong> is requesting access to HemmaBo's vacation-rental tools on your behalf.</p>` +
    `<p style="color:#444">No HemmaBo account is required. You will provide your name and email at booking time, per request.</p>` +
    `<form method="POST" action="/oauth/authorize" style="margin-top:2rem">` +
    `<input type="hidden" name="response_type" value="code">` +
    `<input type="hidden" name="client_id" value="${escapeAttr(p.client_id)}">` +
    `<input type="hidden" name="redirect_uri" value="${escapeAttr(p.redirect_uri)}">` +
    `<input type="hidden" name="state" value="${escapeAttr(p.state)}">` +
    `<input type="hidden" name="code_challenge" value="${escapeAttr(p.code_challenge)}">` +
    `<input type="hidden" name="code_challenge_method" value="${escapeAttr(p.code_challenge_method)}">` +
    `<input type="hidden" name="scope" value="${escapeAttr(p.scope)}">` +
    `<input type="hidden" name="decision" value="approve">` +
    `<button type="submit" style="background:#0a7;color:#fff;border:0;padding:.8rem 1.6rem;font-size:1rem;border-radius:.4rem;cursor:pointer">Connect ${escapeHtml(client.name)}</button>` +
    `</form>` +
    `<form method="POST" action="/oauth/authorize" style="margin-top:.8rem">` +
    `<input type="hidden" name="response_type" value="code">` +
    `<input type="hidden" name="client_id" value="${escapeAttr(p.client_id)}">` +
    `<input type="hidden" name="redirect_uri" value="${escapeAttr(p.redirect_uri)}">` +
    `<input type="hidden" name="state" value="${escapeAttr(p.state)}">` +
    `<input type="hidden" name="decision" value="deny">` +
    `<button type="submit" style="background:transparent;color:#444;border:1px solid #ccc;padding:.6rem 1.2rem;border-radius:.4rem;cursor:pointer">Cancel</button>` +
    `</form>` +
    `</body>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }

/**
 * Build a redirect URL that round-trips an error to the client per
 * RFC 6749 §4.1.2.1. We use query-string encoding (response_mode=query).
 */
function buildErrorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // No CORS — this is a browser-rendered page reached by top-level navigation,
  // not a cross-origin fetch. Allowing CORS would let arbitrary JS read the
  // consent HTML.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Strict rate-limit per IP — guards against code-grinding and consent-page
  // scraping.
  const rlIdent = anonIdentifier(req.headers as Record<string, string | string[] | undefined>);
  const rl = await checkRateLimit("strict", rlIdent);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec ?? 60));
    return renderErrorPage(res, 429, "Too many requests", `Retry in ${rl.retryAfterSec ?? 60}s.`);
  }

  const p = readParams(req);

  // ── Phase 1: validate parameters that cannot safely round-trip via
  // redirect_uri (client_id, redirect_uri itself). Errors here MUST render
  // in-place — redirecting an unverified URI is an open-redirect vuln.

  if (!p.client_id || typeof p.client_id !== "string") {
    return renderErrorPage(res, 400, "Missing client_id", "The AI assistant did not include a client_id parameter.");
  }
  if (!p.redirect_uri || typeof p.redirect_uri !== "string") {
    return renderErrorPage(res, 400, "Missing redirect_uri", "The AI assistant did not include a redirect_uri parameter.");
  }

  const client = await loadClient(p.client_id);
  if (!client) {
    return renderErrorPage(res, 400, "Unknown client", "This client is not registered or has been disabled, or does not have the authorization_code grant enabled.");
  }
  if (!isRedirectUriAllowed(p.redirect_uri, client.redirect_uris)) {
    return renderErrorPage(res, 400, "Invalid redirect_uri", "The supplied redirect_uri is not in this client's registered allowlist. Per RFC 6749 §4.1.2.1 we will not redirect to it.");
  }

  // ── Phase 2: validate parameters that CAN round-trip via redirect_uri.
  // From here on, errors go via 302 so the AI client surfaces them.

  if (p.response_type !== "code") {
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "unsupported_response_type", "Only response_type=code is supported.", p.state));
  }
  if (p.code_challenge_method !== "S256") {
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "invalid_request", "code_challenge_method must be S256 (plain is not supported).", p.state));
  }
  if (!isValidCodeChallenge(p.code_challenge)) {
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "invalid_request", "code_challenge is missing or malformed (RFC 7636 §4.2 BASE64URL SHA-256, 43 chars).", p.state));
  }

  const scope = (p.scope && typeof p.scope === "string") ? p.scope : DEFAULT_SCOPE;
  const state = (p.state && typeof p.state === "string") ? p.state : "";

  // ── GET: render consent page. ──────────────────────────────────────────
  if (req.method === "GET") {
    return renderConsentPage(res, client, {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      state,
      code_challenge: p.code_challenge,
      code_challenge_method: "S256",
      scope,
    });
  }

  // ── POST: user clicked Approve or Cancel. ──────────────────────────────
  const decision = (p as { decision?: string }).decision;
  if (decision === "deny") {
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "access_denied", "User cancelled the consent.", state));
  }
  if (decision !== "approve") {
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "invalid_request", "Missing or unknown decision.", state));
  }

  // Issue the single-use authorization code. 32 bytes hex = 256 bits of
  // entropy, opaque, never seen by the user (only by the AI client).
  const code = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();

  const { error: insertErr } = await supabase
    .from("mcp_authorization_codes")
    .insert({
      code,
      client_id: client.id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      code_challenge_method: "S256",
      scope,
      expires_at: expiresAt,
    });

  if (insertErr) {
    console.error("[oauth/authorize] failed to persist code:", insertErr);
    return res.redirect(302, buildErrorRedirect(p.redirect_uri, "server_error", "Could not issue authorization code.", state));
  }

  const success = new URL(p.redirect_uri);
  success.searchParams.set("code", code);
  if (state) success.searchParams.set("state", state);
  return res.redirect(302, success.toString());
}
