/**
 * OAuth 2.0 token endpoint — client_credentials grant
 *
 * AI platforms (Anthropic, OpenAI, Google, etc.) call this once to get an
 * access token. The token is then passed as Authorization: Bearer <token>
 * on all MCP tools/call and ACP requests.
 *
 * Flow:
 *   POST /oauth/token
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials&client_id=<id>&client_secret=<secret>
 *
 *   → { access_token, token_type: "Bearer", expires_in: 3600 }
 *
 * Tokens are stored in Supabase (mcp_access_tokens table) with a 1-hour TTL.
 * auth.ts validates tokens against this table on every request.
 *
 * RFC 6749 §4.4 — Client Credentials Grant
 * https://datatracker.ietf.org/doc/html/rfc6749#section-4.4
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TOKEN_TTL_SECONDS = 3600; // 1 hour

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) {
      // Still run comparison to avoid timing leak
      timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
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

  // Parse body — supports both JSON and application/x-www-form-urlencoded
  let grantType: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    grantType = req.body?.grant_type;
    clientId = req.body?.client_id;
    clientSecret = req.body?.client_secret;
  } else {
    // application/x-www-form-urlencoded (RFC 6749 standard)
    const raw = typeof req.body === "string" ? req.body : "";
    const params = new URLSearchParams(raw);
    grantType = params.get("grant_type") ?? undefined;
    clientId = params.get("client_id") ?? undefined;
    clientSecret = params.get("client_secret") ?? undefined;
  }

  // Also support HTTP Basic Auth (RFC 6749 §2.3.1)
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [id, secret] = decoded.split(":", 2);
    if (!clientId) clientId = id;
    if (!clientSecret) clientSecret = secret;
  }

  if (grantType !== "client_credentials") {
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only client_credentials grant is supported",
    });
  }

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "client_id and client_secret are required",
    });
  }

  // Look up client in Supabase
  const { data: client, error } = await supabase
    .from("mcp_clients")
    .select("id, client_id, client_secret_hash, name, is_active")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error || !client || !client.is_active) {
    return res.status(401).json({
      error: "invalid_client",
      error_description: "Unknown or inactive client",
    });
  }

  // Validate secret using timing-safe comparison
  const providedHash = hashSecret(clientSecret);
  if (!timingSafeCompare(providedHash, client.client_secret_hash)) {
    return res.status(401).json({
      error: "invalid_client",
      error_description: "Invalid client credentials",
    });
  }

  // Generate opaque access token
  const accessToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

  // Store token in Supabase
  const { error: insertError } = await supabase
    .from("mcp_access_tokens")
    .insert({
      token: accessToken,
      client_id: client.id,
      expires_at: expiresAt,
    });

  if (insertError) {
    console.error("[oauth/token] Failed to store token:", insertError);
    return res.status(500).json({
      error: "server_error",
      error_description: "Failed to issue token",
    });
  }

  // RFC 6749 §5.1 — successful response
  return res.status(200).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
  });
}
