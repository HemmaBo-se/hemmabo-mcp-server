# ADR 0003 — OAuth 2.1 authorization_code + PKCE for Anthropic Claude.ai connectors

- **Status:** Accepted (2026-05-15)
- **Verified against:** `origin/main` @ `86da91f` (commit *"feat(stripe): non-silent refund + signed webhook handler (#70) (#76)"*)
- **Supersedes:** Nothing (extends ADR 0002 §2.1 auth model)
- **Migration:** [`supabase/migrations/2026-05-15-oauth-mcp-tables.sql`](../../supabase/migrations/2026-05-15-oauth-mcp-tables.sql) (applied to prod 2026-05-15, four tables verified)

## 1 Context

Anthropic's Claude.ai remote-MCP connector flow requires OAuth 2.1 with `authorization_code` grant, PKCE (S256), Dynamic Client Registration (RFC 7591) and discoverable metadata (RFC 8414 + RFC 9728). Without all four, Claude.ai cannot complete the connector handshake and the submission is rejected as *"OAuth callback URL fel"* — the #2 most common rejection reason per Anthropic's own published guidance.

The server today supports only `grant_type=client_credentials` (server-to-server). That grant is used by the OpenAI ChatGPT Apps SDK submission and must keep working unchanged. The Supabase tables backing it did not exist in production before 2026-05-15 (`relation "mcp_clients" does not exist`) — `/oauth/register` and `/oauth/token` were both returning HTTP 500 silently. The migration applied 2026-05-15 creates four tables that cover both grants and locks the schema as a single source of truth.

## 2 Decisions

### 2.1 Identity model: **guest-without-identity**

The authorize endpoint renders a stateless consent page ("Allow Claude to use HemmaBo on your behalf?") and, on user click, issues an authorization code bound to the client and the PKCE challenge — **without** creating or looking up any user account. The booking tools (`booking.checkout`, `booking.create`, etc.) continue to receive `guestEmail`, `guestName`, `guestPhone` as call-time arguments, exactly as today; the OAuth layer carries no per-user state.

**Rationale.** HemmaBo has no end-user account system today and zero users requesting one. Building magic-link login would multiply scope (login UI, email deliverability, account recovery, GDPR retention) for no current user benefit. Anthropic's submission guidance does not mandate per-user identity — only that the OAuth flow exist, the redirect URIs are allowlisted, and the consent step is interactive. Guest-without-identity satisfies all three.

**Trade-off accepted.** `booking.status`, `booking.cancel`, `booking.reschedule` will continue to authorise the *client* (Claude.ai) rather than a specific user, meaning any caller with a valid access token issued via that connector can read or mutate any booking whose UUID it knows. This is the same threat model as today — `validateAuth` does not bind to a user — and is mitigated by the fact that booking UUIDs are 128-bit and never exposed publicly. When a real multi-user need lands (e.g. a HemmaBo-branded app), ADR 0004 will add a `mcp_users` table and bind tokens to a `user_id` column on `mcp_access_tokens` (already reserved in the migration via a `scope` column for forward-compat).

### 2.2 Grants and lifetimes

| Grant | Used by | Access token TTL | Refresh token | Notes |
|---|---|---|---|---|
| `client_credentials` | ChatGPT Apps SDK, server-to-server partners | 1 h (unchanged) | none | Kept bit-identical to today — no behaviour change. |
| `authorization_code` | Claude.ai, future browser-based AI connectors | 1 h | 30 d, single-use, rotation on every refresh | PKCE `S256` required, `plain` rejected at `/authorize`. |
| `refresh_token` | clients that received one | 1 h on the new access token | new 30 d on rotation | RFC 6749 §10.4 reuse detection: presenting a revoked refresh token invalidates the entire rotation chain. |

Authorization codes live 10 minutes (RFC 6749 §4.1.2 recommendation) and are single-use enforced by `used_at IS NULL` on redemption.

### 2.3 Token formats

All tokens remain opaque random hex strings (no JWT). Access tokens: 64 hex chars (256 bits). Refresh tokens: 64 hex chars, **stored hashed** (SHA-256) — defence in depth against DB-snapshot leaks. Authorization codes: 32 hex chars (128 bits, single-use, 10 min). Client secrets: 64 hex chars, hashed before storage (existing behaviour, unchanged).

**Rationale.** Opaque tokens require a DB round-trip on every validation, but the existing `validateAuth` already does that for `client_credentials` tokens. JWTs would add JWKS rotation, asymmetric-key management and library surface area for zero functional benefit at our scale.

### 2.4 Redirect URI policy

`mcp_clients.redirect_uris text[]` stores a per-client allowlist. `/authorize` rejects any request whose `redirect_uri` is not an **exact string match** of an entry in the array (RFC 6749 §3.1.2.3). Empty array → client may not use `authorization_code` (defaults to `client_credentials`-only).

The Anthropic client we register manually (via SQL Editor, before submission) will carry both:

```
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```

Both, exactly as documented by Anthropic. No wildcards, no prefix matching.

### 2.5 Discovery metadata

Two new public, unauthenticated endpoints:

- `GET /.well-known/oauth-authorization-server` (RFC 8414) — advertises `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, supported grants, supported challenge methods (`S256` only), `token_endpoint_auth_methods_supported`.
- `GET /.well-known/oauth-protected-resource` (RFC 9728) — declares this MCP server as a resource and points at the AS metadata URL above.

`POST /mcp` returns `401 + WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"` when no/invalid token is supplied, so Claude.ai can discover the AS without prior configuration (RFC 9728 §5.1).

### 2.6 New endpoints (scope of upcoming PRs)

1. `GET /oauth/authorize` — validates client_id, redirect_uri, response_type=code, code_challenge (S256), state. Renders an HTML consent page. On POST-confirm, persists a row in `mcp_authorization_codes` and 302-redirects to `redirect_uri?code=…&state=…`.
2. `POST /oauth/token` — extends the existing handler with `grant_type=authorization_code` (verify PKCE, single-use, 10 min TTL) and `grant_type=refresh_token` (rotation + reuse-detection). Existing `client_credentials` path unchanged.
3. `POST /oauth/revoke` (RFC 7009) — revokes either an access token or a refresh token by value.
4. `POST /oauth/register` — fix the existing 500 (column-drift) and accept RFC 7591 fields (`redirect_uris`, `grant_types`, `token_endpoint_auth_method`).

### 2.7 Origin validation

`api/mcp.ts` and `api/acp.ts` currently set `Access-Control-Allow-Origin: *` and document the choice as *"MCP clients are not browsers"*. That assumption is **false** for Claude.ai (web). The follow-up PR for the `/mcp` endpoint will:

- Keep `*` for `OPTIONS` preflights that carry no credentials (anonymous tool discovery).
- Reflect a specific allowlisted origin (`https://claude.ai`, `https://claude.com`, `https://chat.openai.com`, plus localhost for dev) when the request carries `Authorization: Bearer …`, per the CORS spec.

## 3 Non-decisions (deliberately deferred)

- **Per-user identity** — see §2.1 trade-off. Re-open when there is a concrete product need.
- **Token introspection (RFC 7662)** — not required by Anthropic or OpenAI today.
- **mTLS / DPoP / sender-constrained tokens** — overkill for current threat model.
- **Auth-server-issued ID tokens (OpenID Connect)** — not applicable; no user identity to assert.
- **JWT access tokens** — see §2.3.

## 4 Verification plan

Each new endpoint lands in its own PR with:

1. A contract test under `src/` that locks the wire format (status codes, JSON shape, headers) before the handler is written.
2. A live `curl` smoke against the deployed Vercel URL pasted into the PR description.
3. No silent `catch{}` blocks, no float→cent conversions, no dead validators (zero-tolerance rule).

The end-to-end acceptance test is a manual run of "Add custom connector" in Claude.ai against `https://hemmabo-mcp-server.vercel.app/mcp` followed by a real `search_properties` tool call. Screenshot goes in [`submission/anthropic/`](../../submission/anthropic/) when the folder is created in Fas 7.

## 5 Open follow-ups (will become GitHub issues at end of Fas 6)

- Remove the stale [`supabase/oauth_tables.sql`](../../supabase/oauth_tables.sql) once the new flow is in prod for one full week without rollback.
- Run two independent end-to-end audits (zero-tolerance §3) — one against this server, one against `hemmabo-smart-stays` — and file every finding as an issue.
- Audit privacy-policy text at `https://www.hemmabo.com/privacy` to confirm it covers OAuth access/refresh tokens, retention windows, and the data handed to Stripe at checkout.
