-- ============================================================
-- 2026-05-15 — OAuth 2.1 tables for hemmabo-mcp-server
--
-- Replaces the stale `supabase/oauth_tables.sql` (column names did not
-- match the runtime code in api/oauth-register.ts and api/oauth.ts, and
-- the file was never applied to prod — `SELECT * FROM mcp_clients`
-- returned `relation does not exist` on 2026-05-15).
--
-- Creates everything needed for BOTH OAuth grants this server supports:
--
--   1. grant_type=client_credentials   (existing — server-to-server,
--      ChatGPT Apps SDK track, kept unchanged).
--
--   2. grant_type=authorization_code   (new — RFC 6749 + RFC 7636 PKCE
--      S256, required by Anthropic Claude.ai connectors).
--
--   3. grant_type=refresh_token         (new — RFC 6749 §6, rotation on
--      every use, single-use refresh tokens, 30-day TTL).
--
-- Identity model: guest-without-identity (ADR 0003). The authorize
-- endpoint is a stateless consent page — there are no user accounts.
-- Tools that take per-booking PII continue to receive guestEmail/guest
-- Name as call arguments, exactly like today.
--
-- All tables are service_role-only (RLS denies anon). Run in Supabase
-- SQL Editor (Dashboard → SQL Editor). Safe to re-run.
-- ============================================================


-- ── mcp_clients ──────────────────────────────────────────────────
-- One row per registered OAuth client (Claude.ai, ChatGPT, etc.).
-- Created either via POST /oauth/register (RFC 7591 DCR) or by hand
-- via SQL Editor for known partners.

CREATE TABLE IF NOT EXISTS mcp_clients (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                   text        NOT NULL UNIQUE,
  client_secret_hash          text        NOT NULL,                 -- sha256 hex of plaintext secret
  name                        text        NOT NULL,
  contact_email               text,
  is_active                   boolean     NOT NULL DEFAULT true,

  -- RFC 7591 §2: per-client redirect_uri allowlist. Empty array means
  -- this client may NOT use authorization_code grant — only
  -- client_credentials. Exact string match on /authorize.
  redirect_uris               text[]      NOT NULL DEFAULT ARRAY[]::text[],

  -- RFC 7591 §2: declared grant types. Defaults preserve the current
  -- ChatGPT/Apps-SDK behaviour for clients registered before this PR.
  grant_types                 text[]      NOT NULL DEFAULT ARRAY['client_credentials']::text[],

  -- RFC 7591 §2: how the client authenticates to /oauth/token. We only
  -- accept client_secret_post (and HTTP Basic which RFC 6749 mandates
  -- as a fallback). client_secret_basic is treated as an alias.
  token_endpoint_auth_method  text        NOT NULL DEFAULT 'client_secret_post',

  -- RFC 7591 §2: optional scope the client is allowed to request.
  -- NULL = no scope restriction beyond server defaults.
  scope                       text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_clients_client_id_idx ON mcp_clients (client_id);

ALTER TABLE mcp_clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny_anon_mcp_clients" ON mcp_clients;
CREATE POLICY "deny_anon_mcp_clients"
  ON mcp_clients
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);


-- ── mcp_access_tokens ────────────────────────────────────────────
-- Short-lived opaque tokens (1 h TTL). Format: 64-char hex.
-- Used by both grants. Expired rows are reaped on next validation.

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text        NOT NULL UNIQUE,

  -- NOTE: api/oauth.ts inserts the *uuid pk* of mcp_clients into this
  -- column, not the public client_id string. The column name is kept
  -- for compatibility with that code path.
  client_id   uuid        NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,

  scope       text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_token_idx      ON mcp_access_tokens (token);
CREATE INDEX IF NOT EXISTS mcp_access_tokens_expires_at_idx ON mcp_access_tokens (expires_at);

ALTER TABLE mcp_access_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny_anon_mcp_access_tokens" ON mcp_access_tokens;
CREATE POLICY "deny_anon_mcp_access_tokens"
  ON mcp_access_tokens
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);


-- ── mcp_authorization_codes ──────────────────────────────────────
-- Single-use codes issued by GET/POST /oauth/authorize and redeemed at
-- POST /oauth/token (grant_type=authorization_code).
--
-- TTL: 10 minutes (RFC 6749 §4.1.2 recommends short).
-- PKCE: S256 only — `plain` is rejected at /authorize.
--
-- After a successful redemption `used_at` is set; the code MUST NOT be
-- accepted again (RFC 6749 §4.1.2: "The client MUST NOT use the
-- authorization code more than once.").

CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text        NOT NULL UNIQUE,
  client_id               uuid        NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  redirect_uri            text        NOT NULL,
  code_challenge          text        NOT NULL,
  code_challenge_method   text        NOT NULL CHECK (code_challenge_method = 'S256'),
  scope                   text,
  expires_at              timestamptz NOT NULL,
  used_at                 timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_authorization_codes_code_idx       ON mcp_authorization_codes (code);
CREATE INDEX IF NOT EXISTS mcp_authorization_codes_expires_at_idx ON mcp_authorization_codes (expires_at);

ALTER TABLE mcp_authorization_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny_anon_mcp_authorization_codes" ON mcp_authorization_codes;
CREATE POLICY "deny_anon_mcp_authorization_codes"
  ON mcp_authorization_codes
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);


-- ── mcp_refresh_tokens ───────────────────────────────────────────
-- Long-lived (30 d) refresh tokens issued alongside access tokens for
-- the authorization_code grant. We store ONLY the sha256 hash, never
-- the plaintext (defence in depth: a leaked DB snapshot cannot be
-- replayed against /oauth/token).
--
-- Rotation policy: every use issues a new refresh token and revokes
-- the previous one. `rotated_to` lets us audit the chain and detect
-- replay (if a revoked token is presented after being rotated, the
-- whole chain is revoked — RFC 6749 §10.4).

CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text        NOT NULL UNIQUE,
  client_id    uuid        NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  scope        text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  rotated_to   uuid        REFERENCES mcp_refresh_tokens(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_token_hash_idx  ON mcp_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_expires_at_idx  ON mcp_refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_client_id_idx   ON mcp_refresh_tokens (client_id);

ALTER TABLE mcp_refresh_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny_anon_mcp_refresh_tokens" ON mcp_refresh_tokens;
CREATE POLICY "deny_anon_mcp_refresh_tokens"
  ON mcp_refresh_tokens
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);


-- ── updated_at trigger for mcp_clients ───────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_clients_set_updated_at ON mcp_clients;
CREATE TRIGGER mcp_clients_set_updated_at
  BEFORE UPDATE ON mcp_clients
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- ── Verification queries (run manually after applying) ───────────
--
--   SELECT table_name FROM information_schema.tables
--     WHERE table_schema = 'public' AND table_name LIKE 'mcp_%'
--     ORDER BY table_name;
--   -- expected: mcp_access_tokens, mcp_authorization_codes,
--   --           mcp_clients, mcp_refresh_tokens
--
--   SELECT count(*) FROM mcp_clients;          -- expected: 0
--   SELECT count(*) FROM mcp_access_tokens;    -- expected: 0
