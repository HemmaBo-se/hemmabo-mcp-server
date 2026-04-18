-- ============================================================
-- OAuth 2.0 tables for hemmabo-mcp-server
--
-- Supports the client_credentials grant used by AI platforms.
-- Run in Supabase SQL Editor (Dashboard → SQL Editor).
-- Safe to re-run: all statements are idempotent.
-- ============================================================


-- ── mcp_clients ──────────────────────────────────────────────────
-- One row per registered OAuth client (AI platform or integration).

CREATE TABLE IF NOT EXISTS mcp_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL UNIQUE,
  client_secret   text NOT NULL,          -- bcrypt hash
  name            text NOT NULL,
  contact_email   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp_clients ENABLE ROW LEVEL SECURITY;

-- Only service_role may read or write clients.
DROP POLICY IF EXISTS "deny_anon_mcp_clients" ON mcp_clients;
CREATE POLICY "deny_anon_mcp_clients"
  ON mcp_clients
  FOR ALL
  TO anon
  USING (false);


-- ── mcp_access_tokens ────────────────────────────────────────────
-- Short-lived opaque tokens issued by POST /oauth/token.
-- Format: hb_<64-char hex>  (256 bits of entropy).
-- TTL: 1 hour. Expired rows are deleted on next validation attempt.

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL UNIQUE,
  client_id   text NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_token_idx
  ON mcp_access_tokens (token);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_expires_at_idx
  ON mcp_access_tokens (expires_at);

ALTER TABLE mcp_access_tokens ENABLE ROW LEVEL SECURITY;

-- Only service_role may read or write tokens.
DROP POLICY IF EXISTS "deny_anon_mcp_access_tokens" ON mcp_access_tokens;
CREATE POLICY "deny_anon_mcp_access_tokens"
  ON mcp_access_tokens
  FOR ALL
  TO anon
  USING (false);
