/**
 * /.well-known/oauth-authorization-server — RFC 8414 Authorization Server Metadata
 *
 * Required by Anthropic Claude.ai connectors and by any spec-compliant
 * OAuth 2.1 client doing discovery. Without this endpoint the client cannot
 * find the authorization, token or registration URLs without being
 * pre-configured — which Anthropic's connector flow does not do.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc8414
 *
 * The base URL of every advertised endpoint is request-derived (lib/base-url),
 * so preview deploys, self-hosted forks and the canonical Vercel domain all
 * self-describe correctly without env-var overrides.
 *
 * No authentication required — this endpoint is public discovery.
 *
 * Locked by src/oauth-authorization-server.contract.test.ts.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";
import { baseUrl } from "../lib/base-url.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const base = baseUrl(req);

  // RFC 8414 §2 — values are stable across the lifetime of this server. If
  // any field changes (new grant, new auth method, JWKS introduced),
  // src/oauth-authorization-server.contract.test.ts must change in the same
  // PR so the contract is reviewed.
  res.status(200).json({
    issuer: base,

    // Endpoints — match vercel.json rewrites and api/oauth*.ts handlers.
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint:         `${base}/oauth/token`,
    registration_endpoint:  `${base}/oauth/register`,
    revocation_endpoint:    `${base}/oauth/revoke`,

    // Grants. authorization_code + refresh_token cover Claude.ai;
    // client_credentials covers the existing ChatGPT Apps SDK track.
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ],

    response_types_supported: ["code"],
    response_modes_supported: ["query"],

    // RFC 7636 PKCE — S256 only. `plain` is explicitly rejected at
    // /oauth/authorize per ADR 0003 §2.2.
    code_challenge_methods_supported: ["S256"],

    // RFC 6749 §2.3 + RFC 8414. `none` is for public PKCE clients (Claude.ai
    // registers as a public client). client_secret_basic is treated as an
    // alias for client_secret_post in api/oauth.ts.
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],

    // Scopes. The MCP server exposes a single "mcp" scope today; per-tool
    // scopes can be added later without breaking this contract.
    scopes_supported: ["mcp"],

    // No opaque-introspection or JWKS endpoint — tokens are opaque and
    // validated server-side via the Supabase mcp_access_tokens table.

    service_documentation: "https://github.com/HemmaBo-se/hemmabo-mcp-server",
  });
}
