/**
 * OAuth 2.0 client registration endpoint
 *
 * AI platforms call this once to register themselves and receive
 * client_id + client_secret. These are then used to get access tokens
 * via POST /oauth/token (client_credentials grant).
 *
 * This implements a simplified version of RFC 7591 (Dynamic Client Registration).
 *
 * POST /oauth/register
 * {
 *   "client_name": "Anthropic Claude",
 *   "contact_email": "mcp@anthropic.com"   // optional
 * }
 *
 * → {
 *     "client_id": "hb_<uuid>",
 *     "client_secret": "<64-char hex>",   // shown ONCE, not stored
 *     "client_name": "Anthropic Claude",
 *     "token_endpoint": "https://hemmabo-mcp-server.vercel.app/oauth/token"
 *   }
 *
 * Registration is open — any AI platform can register. The client_secret
 * is hashed (SHA-256) before storage so HemmaBo never sees the plaintext.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TOKEN_ENDPOINT = "https://hemmabo-mcp-server.vercel.app/oauth/token";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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

  const clientName: string | undefined = req.body?.client_name;
  const contactEmail: string | undefined = req.body?.contact_email;

  if (!clientName || typeof clientName !== "string" || clientName.trim().length < 2) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "client_name is required (min 2 characters)",
    });
  }

  // Generate credentials
  const clientId = `hb_${randomUUID().replace(/-/g, "")}`;
  const clientSecret = randomBytes(32).toString("hex"); // 64-char hex, shown once
  const secretHash = hashSecret(clientSecret);

  // Store in Supabase — only the hash, never the plaintext secret
  const { error } = await supabase.from("mcp_clients").insert({
    client_id: clientId,
    client_secret_hash: secretHash,
    name: clientName.trim(),
    contact_email: contactEmail?.trim() || null,
    is_active: true,
  });

  if (error) {
    console.error("[oauth/register] Insert failed:", error);
    return res.status(500).json({
      error: "server_error",
      error_description: "Registration failed — please retry",
    });
  }

  // RFC 7591 §3.2 — successful registration response
  return res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret, // shown ONCE — client must store this
    client_name: clientName.trim(),
    token_endpoint: TOKEN_ENDPOINT,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "client_secret_post",
    note: "Store client_secret securely — it is not recoverable. Use it to obtain access tokens via the token_endpoint.",
  });
}
