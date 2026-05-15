/**
 * /.well-known/oauth-protected-resource — RFC 9728 Protected Resource Metadata
 *
 * Tells an OAuth 2.1 client which authorization server(s) issue tokens for
 * this resource (the MCP server) and which bearer-token transport methods
 * are accepted. Claude.ai reads this in response to the `WWW-Authenticate`
 * header on a 401 from /mcp (RFC 9728 §5.1).
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc9728
 *
 * No authentication required — this endpoint is public discovery.
 *
 * Locked by src/oauth-protected-resource.contract.test.ts.
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

  res.status(200).json({
    // The protected resource is the MCP JSON-RPC endpoint. Anthropic and
    // other clients use this to anchor the audience claim of access tokens.
    resource: `${base}/mcp`,

    // Single in-tree authorization server (this same deployment serves
    // both metadata documents).
    authorization_servers: [base],

    // RFC 6750 §2.1 — `header` means Authorization: Bearer <token>. We do
    // not accept the (deprecated) form-encoded or URI-query variants.
    bearer_methods_supported: ["header"],

    scopes_supported: ["mcp"],

    resource_name: "HemmaBo Federation MCP Server",
    resource_documentation: "https://github.com/HemmaBo-se/hemmabo-mcp-server",
  });
}
